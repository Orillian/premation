#include "frame_cache.hpp"

#include <algorithm>
#include <iterator>
#include <utility>

namespace premation::render {

FrameCache::FrameCache(wgpu::Device device, std::size_t budgetBytes) : device_(std::move(device)), budget_(budgetBytes) {
  stats_.budget = budget_;
}

bool FrameCache::copy_to(std::uint64_t key, std::uint32_t width, std::uint32_t height, const wgpu::Texture& target,
                         wgpu::CommandEncoder& encoder) {
  const auto it = index_.find(key);
  if (it == index_.end() || it->second->width != width || it->second->height != height) {
    ++stats_.misses;
    return false;
  }
  lru_.splice(lru_.begin(), lru_, it->second);
  wgpu::TexelCopyTextureInfo src{};
  src.texture = it->second->texture;
  wgpu::TexelCopyTextureInfo dst{};
  dst.texture = target;
  const wgpu::Extent3D size{width, height, 1};
  encoder.CopyTextureToTexture(&src, &dst, &size);
  ++stats_.hits;
  return true;
}

const wgpu::Texture* FrameCache::use(std::uint64_t key, std::uint32_t width, std::uint32_t height) {
  const auto it = index_.find(key);
  if (it == index_.end() || it->second->width != width || it->second->height != height) {
    ++stats_.misses;
    return nullptr;
  }
  lru_.splice(lru_.begin(), lru_, it->second);
  ++stats_.hits;
  return &it->second->texture;
}

wgpu::Texture FrameCache::peek(std::uint64_t key, std::uint32_t width, std::uint32_t height) const {
  const auto it = index_.find(key);
  if (it == index_.end() || it->second->width != width || it->second->height != height) return nullptr;
  return it->second->texture;
}

void FrameCache::store(std::uint64_t key, std::uint32_t width, std::uint32_t height, const wgpu::Texture& source,
                       wgpu::CommandEncoder& encoder, const FrameMeta& meta, const EvictHook& onEvict) {
  const std::size_t need = bytes_of(width, height);
  if (need == 0 || need > budget_) return;
  if (const auto it = index_.find(key); it != index_.end()) {
    // Same content already here (a re-render of an identical frame): refresh only.
    lru_.splice(lru_.begin(), lru_, it->second);
    it->second->meta.tag = meta.tag;
    if (meta.diskKey != 0) it->second->meta.diskKey = meta.diskKey;
    return;
  }
  while (bytes_ + need > budget_ && !lru_.empty()) {
    // Every remaining frame is one an open surface shows: the cache stays over
    // budget by this frame rather than blank another viewport.
    if (!evict_one(&encoder, onEvict ? &onEvict : nullptr)) break;
  }
  Entry e;
  e.key = key;
  e.width = width;
  e.height = height;
  e.meta = meta;
  e.texture = take_texture(width, height);
  wgpu::TexelCopyTextureInfo src{};
  src.texture = source;
  wgpu::TexelCopyTextureInfo dst{};
  dst.texture = e.texture;
  const wgpu::Extent3D size{width, height, 1};
  encoder.CopyTextureToTexture(&src, &dst, &size);
  lru_.push_front(std::move(e));
  index_.emplace(key, lru_.begin());
  bytes_ += need;
  ++stats_.stores;
}

FrameMeta* FrameCache::meta(std::uint64_t key) {
  const auto it = index_.find(key);
  return it == index_.end() ? nullptr : &it->second->meta;
}

bool FrameCache::evict_one(wgpu::CommandEncoder* encoder, const EvictHook* onEvict) {
  // Least recently used first, skipping the frames open surfaces show now.
  auto it = lru_.end();
  for (auto cand = lru_.rbegin(); cand != lru_.rend(); ++cand) {
    if (!pinned_.pins(cand->key)) {
      it = std::prev(cand.base());
      break;
    }
  }
  if (it == lru_.end()) return false;
  Entry& victim = *it;
  if (encoder != nullptr && onEvict != nullptr) {
    (*onEvict)(Evicted{victim.key, victim.width, victim.height, &victim.texture, victim.meta}, *encoder);
  }
  index_.erase(victim.key);
  bytes_ -= bytes_of(victim.width, victim.height);
  // One spare per size is enough: stores and evictions alternate one-for-one
  // at a full budget. Others are released.
  const bool keep = std::ranges::none_of(spare_, [&](const Entry& s) {
    return s.width == victim.width && s.height == victim.height;
  });
  if (keep) spare_.push_back(std::move(victim));
  lru_.erase(it);
  ++stats_.evictions;
  return true;
}

wgpu::Texture FrameCache::take_texture(std::uint32_t w, std::uint32_t h) {
  for (auto it = spare_.begin(); it != spare_.end(); ++it) {
    if (it->width == w && it->height == h) {
      wgpu::Texture t = std::move(it->texture);
      spare_.erase(it);
      return t;
    }
  }
  wgpu::TextureDescriptor td{};
  td.label = "frame-cache";
  td.size = {w, h, 1};
  td.format = wgpu::TextureFormat::RGBA8Unorm;
  td.usage = wgpu::TextureUsage::CopyDst | wgpu::TextureUsage::CopySrc;
  return device_.CreateTexture(&td);
}

void FrameCache::clear() {
  lru_.clear();
  index_.clear();
  spare_.clear();
  bytes_ = 0;
}

FrameCacheStats FrameCache::stats() const {
  FrameCacheStats s = stats_;
  s.entries = index_.size();
  s.bytes = bytes_;
  s.budget = budget_;
  return s;
}

}  // namespace premation::render
