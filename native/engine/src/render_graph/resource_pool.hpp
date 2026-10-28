// Keyed GPU resource pools with frame-stamped GC and VRAM accounting — the C++
// twin of packages/renderer/src/gpu/ResourceManager.ts + gpuMemory.ts.
//
//   * Dedup: a resource is acquired by a stable string key; the same key hands
//     back the same object instead of allocating again.
//   * Lifetime: every acquire stamps the current frame; `collect` destroys
//     anything untouched for more than `maxIdle` frames (pinned entries never).
//   * Accounting: bytes are charged on a MISS only (a hit is free and never
//     double-counts) and refunded on destroy; `peak` is the high-water mark.
//
// GPU-free on purpose: `T` is any RAII handle (a wgpu::Texture, a test double),
// so the lifetime rules are unit-tested without a device (test_render_graph.cpp).
#pragma once

#include <algorithm>
#include <cstdint>
#include <functional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace premation::rg {

/// Running byte counter with a high-water mark (GpuMemoryMeter).
struct MemoryMeter {
  std::uint64_t bytes = 0;
  std::uint64_t peak = 0;
  void add(std::uint64_t n) noexcept {
    if (n == 0) return;
    bytes += n;
    peak = std::max(peak, bytes);
  }
  void sub(std::uint64_t n) noexcept { bytes = n > bytes ? 0 : bytes - n; }
};

/// Transparent hash so lookups by string_view allocate nothing.
struct KeyHash {
  using is_transparent = void;
  std::size_t operator()(std::string_view s) const noexcept { return std::hash<std::string_view>{}(s); }
};

template <typename T>
class Pool {
 public:
  explicit Pool(MemoryMeter* meter) : meter_(meter) {}

  struct Stats {
    std::uint64_t hits = 0;
    std::uint64_t misses = 0;
    std::uint64_t collected = 0;
  };

  /// The resource under `key`, creating it with `make()` (charged `bytes`) on a miss.
  template <typename Make>
  T& acquire(std::string_view key, std::uint64_t frame, Make&& make, std::uint64_t bytes = 0, bool pinned = false) {
    auto it = map_.find(key);
    if (it != map_.end()) {
      it->second.lastFrame = frame;
      it->second.pinned = it->second.pinned || pinned;
      ++stats_.hits;
      return it->second.value;
    }
    ++stats_.misses;
    Entry e{std::forward<Make>(make)(), frame, pinned, bytes};
    if (meter_ != nullptr) meter_->add(bytes);
    return map_.emplace(std::string(key), std::move(e)).first->second.value;
  }

  [[nodiscard]] T* find(std::string_view key) noexcept {
    auto it = map_.find(key);
    return it == map_.end() ? nullptr : &it->second.value;
  }

  [[nodiscard]] bool has(std::string_view key) const noexcept { return map_.find(key) != map_.end(); }

  /// Destroy entries untouched since `frame - maxIdle`. Returns how many.
  std::size_t collect(std::uint64_t frame, std::uint64_t maxIdle) {
    std::size_t n = 0;
    for (auto it = map_.begin(); it != map_.end();) {
      const Entry& e = it->second;
      if (!e.pinned && frame > e.lastFrame + maxIdle) {
        if (meter_ != nullptr) meter_->sub(e.bytes);
        it = map_.erase(it);
        ++n;
      } else {
        ++it;
      }
    }
    stats_.collected += n;
    return n;
  }

  /// Program P10 — collection with a byte budget: an entry idle longer than
  /// `maxIdle` frames goes; one idle longer than `minIdle` goes only while the
  /// pool holds more than `budgetBytes`, oldest first. A playback loop longer
  /// than `minIdle` frames keeps its textures for the next pass (the plain
  /// collect re-uploaded every raster each time round), and memory stays bounded.
  /// Over the budget, an entry whose key `quick` accepts goes once idle longer
  /// than `quickIdle` instead (the default accepts none).
  template <typename Quick = bool (*)(std::string_view)>
  std::size_t collect_budgeted(std::uint64_t frame, std::uint64_t minIdle, std::uint64_t maxIdle, std::uint64_t budgetBytes,
                               std::uint64_t quickIdle = 0, Quick quick = [](std::string_view) { return false; }) {
    std::size_t n = collect(frame, maxIdle);
    std::uint64_t total = 0;
    for (const auto& [k, e] : map_) total += e.bytes;
    if (total <= budgetBytes) return n;
    std::vector<typename decltype(map_)::iterator> idle;
    for (auto it = map_.begin(); it != map_.end(); ++it) {
      const std::uint64_t grace = quick(std::string_view(it->first)) ? std::min(quickIdle, minIdle) : minIdle;
      if (!it->second.pinned && frame > it->second.lastFrame + grace) idle.push_back(it);
    }
    std::ranges::sort(idle, [](const auto& a, const auto& b) { return a->second.lastFrame < b->second.lastFrame; });
    std::size_t extra = 0;
    for (auto it : idle) {
      if (total <= budgetBytes) break;
      total -= it->second.bytes;
      if (meter_ != nullptr) meter_->sub(it->second.bytes);
      map_.erase(it);
      ++extra;
    }
    stats_.collected += extra;
    return n + extra;
  }

  /// Drop every entry whose key `other` no longer holds (a companion pool
  /// keyed like it: the texture objects behind the views). Returns how many.
  template <typename U>
  std::size_t collect_absent_from(const Pool<U>& other) {
    std::size_t n = 0;
    for (auto it = map_.begin(); it != map_.end();) {
      if (!it->second.pinned && !other.has(it->first)) {
        if (meter_ != nullptr) meter_->sub(it->second.bytes);
        it = map_.erase(it);
        ++n;
      } else {
        ++it;
      }
    }
    stats_.collected += n;
    return n;
  }

  void free(std::string_view key) {
    auto it = map_.find(key);
    if (it == map_.end()) return;
    if (meter_ != nullptr) meter_->sub(it->second.bytes);
    map_.erase(it);
  }

  void clear() {
    for (auto& [k, e] : map_) {
      (void)k;
      if (meter_ != nullptr) meter_->sub(e.bytes);
    }
    map_.clear();
  }

  [[nodiscard]] std::size_t size() const noexcept { return map_.size(); }
  [[nodiscard]] const Stats& stats() const noexcept { return stats_; }

 private:
  struct Entry {
    T value;
    std::uint64_t lastFrame = 0;
    bool pinned = false;
    std::uint64_t bytes = 0;
  };
  std::unordered_map<std::string, Entry, KeyHash, std::equal_to<>> map_;
  MemoryMeter* meter_;
  Stats stats_;
};

/// gpuMemory.ts `bytesPerPixel`.
constexpr std::uint64_t bytes_per_pixel(std::string_view format) noexcept {
  if (format == "r8unorm") return 1;
  if (format == "rgba16float") return 8;
  if (format == "rgba32float") return 16;
  return 4;
}

/// gpuMemory.ts `estimateRenderTargetBytes`: colour + MSAA attachment + depth.
constexpr std::uint64_t render_target_bytes(std::uint32_t w, std::uint32_t h, std::uint64_t bpp, std::uint32_t samples,
                                            bool depth) noexcept {
  const std::uint64_t px = std::uint64_t{std::max(1U, w)} * std::max(1U, h);
  const std::uint64_t s = samples > 1 ? 4 : 1;
  std::uint64_t bytes = px * bpp;
  if (s > 1) bytes += px * bpp * s;
  if (depth) bytes += px * 4 * s;
  return bytes;
}

}  // namespace premation::rg
