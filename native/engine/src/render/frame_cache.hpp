// D4: the engine's frame cache (docs/NATIVE_CORE_PLAN.md §5 D4) — finished
// viewport frames kept on the GPU, so a second pass over the work area (or a
// scrub back over it) is a texture copy instead of rasters + effects + the
// render graph. The C++ twin of src/core/rendering/frameCache.ts, with two
// deliberate differences:
//
//  * The key is the frame's CONTENT (a 64-bit hash of the built FrameScene,
//    its view and its texture feed — BuiltFrameDrawer::content_key), not an
//    invalidation key of revisions. An edit that does not change what a frame
//    shows keeps it; undo, a slider released where it started, a layer toggled
//    off and on again all return to keys already here. The TS needed "parking"
//    to get that back; content keys have it by construction, and there is no
//    wholesale clear to get wrong.
//  * The budget is the machine's, not Chromium's heap: a share of the adapter's
//    VRAM budget (vram_budget_bytes, DXGI on Windows), overridable per process.
//
// Render-thread only: every method must be called on the thread that owns the
// device. Entries are exact frames only — the caller decides (a frame drawn
// while playing with footage on it may show a nearest decoded frame and is
// never stored).
#pragma once

#include <webgpu/webgpu_cpp.h>

#include <cstddef>
#include <cstdint>
#include <functional>
#include <list>
#include <unordered_map>
#include <vector>

#include "ram_cache.hpp"

namespace premation::render {

/// What the render thread knows of a cached frame besides its pixels: where it
/// sits (the RAM tier's eviction rule), what drawing it cost and its disk key
/// (the disk tier's), carried along when the frame moves down a tier.
struct FrameMeta {
  FrameTag tag;
  double drawMs = 0;
  std::uint64_t diskKey = 0;
};

struct FrameCacheStats {
  std::uint64_t hits = 0;
  std::uint64_t misses = 0;
  std::uint64_t stores = 0;
  std::uint64_t evictions = 0;
  std::size_t entries = 0;
  std::size_t bytes = 0;
  std::size_t budget = 0;
};

class FrameCache {
 public:
  FrameCache(wgpu::Device device, std::size_t budgetBytes);
  ~FrameCache() = default;
  FrameCache(const FrameCache&) = delete;
  FrameCache& operator=(const FrameCache&) = delete;
  FrameCache(FrameCache&&) = delete;
  FrameCache& operator=(FrameCache&&) = delete;

  /// A hit encodes a copy of the cached frame into `target` (width × height,
  /// RGBA8Unorm, CopyDst) and marks it most recently used. A miss encodes nothing.
  bool copy_to(std::uint64_t key, std::uint32_t width, std::uint32_t height, const wgpu::Texture& target,
               wgpu::CommandEncoder& encoder);

  /// A frame about to leave the cache: its texture is reused by the store that
  /// evicted it, so the hook encodes any copy out of it into the same encoder
  /// (queue order: the copy reads the old pixels before the store overwrites them).
  struct Evicted {
    std::uint64_t key = 0;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    const wgpu::Texture* texture = nullptr;
    FrameMeta meta;
  };
  using EvictHook = std::function<void(const Evicted&, wgpu::CommandEncoder&)>;

  /// Keep `source` (width × height, RGBA8Unorm, CopySrc) as `key`'s frame,
  /// evicting least recently used frames to stay inside the budget (each one
  /// through `onEvict`, when given). A frame larger than the whole budget is
  /// not kept. Encodes the copies only.
  void store(std::uint64_t key, std::uint32_t width, std::uint32_t height, const wgpu::Texture& source,
             wgpu::CommandEncoder& encoder, const FrameMeta& meta = {}, const EvictHook& onEvict = {});
  /// `key`'s meta (nullptr on a miss); the render thread fills in the draw time once it is known.
  [[nodiscard]] FrameMeta* meta(std::uint64_t key);

  [[nodiscard]] bool contains(std::uint64_t key) const { return index_.contains(key); }
  /// `key`'s cached texture (width × height), without marking it used; null
  /// on a miss. Copy from it in a submission made now: an evicted texture is
  /// reused by the next store.
  [[nodiscard]] wgpu::Texture peek(std::uint64_t key, std::uint32_t width, std::uint32_t height) const;
  /// Drop every frame (fonts changed under the rasters, device reset, budget 0).
  void clear();
  [[nodiscard]] FrameCacheStats stats() const;

 private:
  struct Entry {
    std::uint64_t key = 0;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    wgpu::Texture texture;
    FrameMeta meta;
  };
  static std::size_t bytes_of(std::uint32_t w, std::uint32_t h) { return std::size_t{w} * h * 4; }
  void evict_one(wgpu::CommandEncoder* encoder = nullptr, const EvictHook* onEvict = nullptr);
  wgpu::Texture take_texture(std::uint32_t w, std::uint32_t h);

  wgpu::Device device_;
  std::size_t budget_;
  std::size_t bytes_ = 0;
  /// Front = most recently used.
  std::list<Entry> lru_;
  std::unordered_map<std::uint64_t, std::list<Entry>::iterator> index_;
  /// Evicted textures, reused for the next store of the same size: playback at
  /// a full budget evicts one frame per stored frame, and re-creating a 1080p
  /// texture per frame is allocator churn on the render thread's hot path.
  std::vector<Entry> spare_;
  FrameCacheStats stats_;
};

/// The frame cache's default budget for this machine: a quarter of the render
/// adapter's local-memory budget (DXGI QueryVideoMemoryInfo on Windows), capped
/// at 4 GiB; 1 GiB where the OS does not say. `vendorId`/`deviceId` pick the
/// adapter Dawn chose (0 = the first hardware adapter).
[[nodiscard]] std::size_t default_frame_cache_budget(std::uint32_t vendorId, std::uint32_t deviceId);

}  // namespace premation::render
