#include "render_thread.hpp"

#include <algorithm>
#include <cstring>
#include <span>
#include <string>
#include <utility>

#include "log.hpp"
#include "overlay_geometry.hpp"
#include "os_ffi.hpp"
#include "premation/protocol/framing.hpp"
#include "premation/protocol/pixel_channel.hpp"

#if defined(PREMATION_SHARED_TEXTURE)
#include "shared_texture_ffi.hpp"
#endif

namespace premation::render {
namespace {

using SteadyClock = std::chrono::steady_clock;

/// How long a replaced ring stays alive: long enough for the host to have
/// imported (and Chromium to have finished sampling) anything announced from
/// it before the resize.
constexpr auto kRetireGrace = std::chrono::seconds(2);

}  // namespace

struct RenderThread::SlotSet {
  std::uint32_t generation = 0;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  bool shared = false;
  /// Route A: every frame is read back into `readback[slot]` and sent on fd 5.
  bool copy = false;
  std::vector<wgpu::Buffer> readback;
  std::uint32_t readbackRow = 0;  // bytes per row in `readback` (256-aligned, WebGPU's copy rule)
  /// Every slot allows copies in and out (the D4 frame cache).
  bool copyable = true;
  std::vector<wgpu::Texture> textures;  // every slot's texture (offscreen, or the shared slot's own)
  std::vector<wgpu::TextureView> views;
#if defined(PREMATION_SHARED_TEXTURE)
  std::unique_ptr<shared::SharedTexturePool> pool;
#endif
  SteadyClock::time_point retiredAt{};

  SlotSet() = default;
  ~SlotSet() {
#if defined(PREMATION_SHARED_TEXTURE)
    if (pool) pool->close_remote_handles();
#endif
  }
  SlotSet(const SlotSet&) = delete;
  SlotSet& operator=(const SlotSet&) = delete;
  SlotSet(SlotSet&&) = delete;
  SlotSet& operator=(SlotSet&&) = delete;
};

RenderThread::RenderThread(RenderOptions options, SendFrames send, OnFatal onFatal)
    : options_(options), send_(std::move(send)), onFatal_(std::move(onFatal)) {
  options_.slots = std::clamp<std::uint32_t>(options_.slots, 2, frames::kMaxSlots);
}

void RenderThread::release(std::uint32_t generation, std::uint32_t slot) {
  std::shared_ptr<FrameRing> ring;
  {
    const std::lock_guard<std::mutex> lock(m_);
    for (const auto& [id, port] : ports_) {
      if (port->ring->generation() == generation) {
        ring = port->ring;
        break;
      }
    }
  }
  // Outside m_: the ring's release hook takes m_ to wake the render thread.
  if (ring) (void)ring->release(generation, slot);
}

RenderThread::~RenderThread() { stop(); }

bool RenderThread::start(std::string& error) {
  std::promise<std::string> ready;
  std::future<std::string> result = ready.get_future();
  // The promise moves into the thread: set_value may still be unwinding when
  // get() returns here, so it must not live in this frame.
  thread_ = std::thread([this, p = std::move(ready)]() mutable { run(p); });
  error = result.get();
  if (!error.empty()) {
    thread_.join();
    return false;
  }
  return true;
}

void RenderThread::stop() {
  {
    const std::lock_guard<std::mutex> lock(m_);
    quit_ = true;
  }
  cv_.notify_all();
  if (thread_.joinable()) thread_.join();
}

void RenderThread::submit(RenderJob job) {
  {
    const std::lock_guard<std::mutex> lock(m_);
    const auto it = ports_.find(job.viewport);
    if (it == ports_.end() || !it->second->config.open) {
      ++counters_.dropped;  // its viewport closed meanwhile: nowhere to show it
      return;
    }
    Port& p = *it->second;
    if (p.pending) {
      ++counters_.dropped;  // superseded before it started: the newest frame wins
      if (p.pending->playing) ++p.droppedPending;  // a frame of playback lost (an edit's is not)
    }
    p.droppedPending += job.clockDropped;
    p.pending = std::move(job);
  }
  cv_.notify_all();
}

bool RenderThread::job_pending(std::uint32_t viewport) const {
  const std::lock_guard<std::mutex> lock(m_);
  const auto it = ports_.find(viewport);
  return it != ports_.end() && it->second->pending.has_value();
}

void RenderThread::note_dropped(std::uint32_t viewport, std::uint32_t skipped, std::uint32_t clockJumped) {
  const std::lock_guard<std::mutex> lock(m_);
  const auto it = ports_.find(viewport);
  if (it == ports_.end()) return;
  it->second->droppedPending += skipped + clockJumped;
  counters_.dropped += skipped;
}

void RenderThread::configure(const ViewportConfig& config) {
  {
    const std::lock_guard<std::mutex> lock(m_);
    auto it = ports_.find(config.viewport);
    if (it == ports_.end()) {
      if (!config.open) return;  // closing a viewport this thread never had
      auto port = std::make_unique<Port>();
      port->ring->on_release([this] {
        const std::lock_guard<std::mutex> relock(m_);
        cv_.notify_all();
      });
      it = ports_.emplace(config.viewport, std::move(port)).first;
      it->second->config = config;
      it->second->dirty = true;
    } else {
      Port& p = *it->second;
      if (config == p.config) return;
      const bool ring = ring_config_changed(p.config, config);
      p.config = config;
      // D5: a camera-only change keeps the ring (ring_config_changed).
      if (!ring) return;
      p.dirty = true;
      if (!config.open) p.pending.reset();
    }
  }
  cv_.notify_all();
}

void RenderThread::set_shared(bool shared) {
  {
    const std::lock_guard<std::mutex> lock(m_);
    if (shared_ == shared) return;
    shared_ = shared;
    for (auto& [id, p] : ports_) p->dirty = true;
  }
  cv_.notify_all();
}

bool RenderThread::shared_supported() const {
  const std::lock_guard<std::mutex> lock(m_);
  return sharedCapable_;
}

void RenderThread::set_copy(bool copy) {
  {
    const std::lock_guard<std::mutex> lock(m_);
    const bool want = copy && static_cast<bool>(options_.sendPixels);
    if (copy_ == want) return;
    copy_ = want;
    for (auto& [id, p] : ports_) p->dirty = true;
  }
  cv_.notify_all();
}

bool RenderThread::copy_supported() const { return static_cast<bool>(options_.sendPixels); }

RenderCounters RenderThread::counters() const {
  const std::lock_guard<std::mutex> lock(m_);
  return counters_;
}

std::string RenderThread::adapter() const {
  const std::lock_guard<std::mutex> lock(m_);
  return adapter_;
}

std::string RenderThread::backend() const {
  const std::lock_guard<std::mutex> lock(m_);
  return backend_;
}

FrameCacheStats RenderThread::cache_stats() const {
  const std::lock_guard<std::mutex> lock(m_);
  return cacheStats_;
}

CacheCoverageSnap RenderThread::cache_coverage() const {
  const std::lock_guard<std::mutex> lock(m_);
  return coverage_;
}

void RenderThread::purge_frame_cache() {
  post([this] {
    if (cache_) cache_->clear();
    ram_.clear();
    // Read-backs in flight would land in the RAM tier after the purge.
    victims_.clear();
    publish_coverage();
  });
}

void RenderThread::configure_ram_cache(std::uint64_t bytes) {
  {
    const std::lock_guard<std::mutex> lock(m_);
    ramBudgetAsked_ = bytes;
    ramBudgetDirty_ = true;
  }
  post([this] {
    manage_ram_budget(true);
    publish_coverage();
  });
}

RamCacheStats RenderThread::ram_stats() const {
  const std::lock_guard<std::mutex> lock(m_);
  return ramStats_;
}

void RenderThread::manage_ram_budget(bool force) {
  const auto now = SteadyClock::now();
  bool dirty = false;
  std::uint64_t asked = 0;
  {
    const std::lock_guard<std::mutex> lock(m_);
    dirty = ramBudgetDirty_;
    ramBudgetDirty_ = false;
    asked = ramBudgetAsked_;
  }
  if (!force && !dirty && now - memoryCheckedAt_ < std::chrono::seconds(1)) return;
  memoryCheckedAt_ = now;
  const os::MemoryStatus mem = os::memory_status();
  if (dirty || ramBudgetTarget_ == 0) {
    const std::uint64_t target = asked != 0                    ? asked
                                 : options_.ramCacheBytes != 0 ? options_.ramCacheBytes
                                                               : auto_ram_budget(mem.physicalBytes);
    if (target != ramBudgetTarget_) {
      ramBudgetTarget_ = target;
      PREMATION_LOG(info, "ram_cache")
          .kv("budgetMB", static_cast<double>(target) / (1024.0 * 1024.0))
          .kv("physicalMB", static_cast<double>(mem.physicalBytes) / (1024.0 * 1024.0));
    }
  }
  // Never push the machine into its page file: keep a reserve free for the
  // system and the other applications (AE's "RAM reserved for other
  // applications"). The tier may hold what it holds plus what is free beyond it.
  std::uint64_t budget = ramBudgetTarget_;
  if (mem.physicalBytes > 0 && mem.availableBytes > 0) {
    const std::uint64_t reserve = std::max<std::uint64_t>(std::uint64_t{1536} << 20U, mem.physicalBytes / 10);
    const std::uint64_t room = mem.availableBytes > reserve ? mem.availableBytes - reserve : 0;
    budget = std::min<std::uint64_t>(budget, ram_.bytes() + room);
  }
  if (budget != ram_.budget()) {
    std::vector<RamFrame> evicted;
    ram_.set_budget(static_cast<std::size_t>(budget), evicted);
    if (!evicted.empty()) {
      spill_ram_evictions(evicted);
      coverageStale_ = true;
    }
  }
}

void RenderThread::configure_disk_cache(const std::string& folder, std::uint64_t bytes) {
  disk_->configure(folder, bytes);
  post([this] {
    diskReadMeasured_ = false;  // another folder (another drive): its own read cost
    publish_coverage();
  });
}

void RenderThread::purge_disk_cache() {
  disk_->purge();
  post([this] { publish_coverage(); });
}

bool RenderThread::load_from_disk(std::uint64_t diskKey, std::uint32_t width, std::uint32_t height,
                                  const wgpu::Texture& target) {
  const auto t0 = SteadyClock::now();
  if (!disk_->load(diskKey, width, height, diskScratch_)) return false;
  wgpu::TexelCopyTextureInfo dst{};
  dst.texture = target;
  wgpu::TexelCopyBufferLayout layout{};
  layout.bytesPerRow = width * 4U;
  layout.rowsPerImage = height;
  const wgpu::Extent3D size{width, height, 1};
  gpu_->queue.WriteTexture(&dst, diskScratch_.data(), diskScratch_.size(), &layout, &size);
  const double ms = std::chrono::duration<double, std::milli>(SteadyClock::now() - t0).count();
  const double mp = static_cast<double>(width) * static_cast<double>(height) / 1e6;
  if (mp > 0) {
    // The first hit replaces the guess outright; later ones (or hits after the cache's seed) average in.
    diskReadMsPerMp_ = diskReadMeasured_ ? 0.8 * diskReadMsPerMp_ + 0.2 * (ms / mp) : ms / mp;
    diskReadMeasured_ = true;
  }
  return true;
}

bool RenderThread::worth_disk(double drawMs, std::uint32_t width, std::uint32_t height) const {
  if (options_.diskCacheMinDrawMs >= 0) return drawMs >= options_.diskCacheMinDrawMs;
  // A frame is worth a file when its draw costs half again what reading it
  // back would, plus a millisecond: a cheap comp never pays for disk at all.
  const double mp = static_cast<double>(width) * static_cast<double>(height) / 1e6;
  return drawMs > 1.5 * diskReadMsPerMp_ * mp + 1.0;
}

wgpu::Buffer RenderThread::encode_readback(const wgpu::Texture& source, std::uint32_t width, std::uint32_t height,
                                           std::uint32_t& row, wgpu::CommandEncoder& encoder) {
  row = (width * 4U + 255U) & ~255U;  // WebGPU's copy rule
  const std::uint64_t size = std::uint64_t{row} * height;
  if (diskSpareSize_ != size) {
    diskSpare_.clear();
    diskSpareSize_ = size;
  }
  wgpu::Buffer buffer;
  if (!diskSpare_.empty()) {
    buffer = std::move(diskSpare_.back());
    diskSpare_.pop_back();
  } else {
    wgpu::BufferDescriptor bd{};
    bd.size = size;
    bd.usage = wgpu::BufferUsage::MapRead | wgpu::BufferUsage::CopyDst;
    buffer = gpu_->device.CreateBuffer(&bd);
  }
  wgpu::TexelCopyTextureInfo src{};
  src.texture = source;
  wgpu::TexelCopyBufferInfo dst{};
  dst.buffer = buffer;
  dst.layout.bytesPerRow = row;
  dst.layout.rowsPerImage = height;
  const wgpu::Extent3D extent{width, height, 1};
  encoder.CopyTextureToBuffer(&src, &dst, &extent);
  return buffer;
}

wgpu::Buffer RenderThread::encode_disk_readback(const wgpu::Texture& source, std::uint32_t width, std::uint32_t height,
                                                std::uint32_t& row) {
  wgpu::CommandEncoder enc = gpu_->device.CreateCommandEncoder();
  wgpu::Buffer buffer = encode_readback(source, width, height, row, enc);
  const wgpu::CommandBuffer cb = enc.Finish();
  gpu_->queue.Submit(1, &cb);
  return buffer;
}

bool RenderThread::take_readback(wgpu::Buffer buffer, std::uint32_t row, std::uint32_t width, std::uint32_t height,
                                 std::vector<std::uint8_t>& out) {
  const std::uint64_t size = std::uint64_t{row} * height;
  bool mapped = false;
  // The copy is done (its future was waited for): the map is immediate.
  gpu_->instance.WaitAny(buffer.MapAsync(wgpu::MapMode::Read, 0, size, wgpu::CallbackMode::WaitAnyOnly,
                                         [&mapped](wgpu::MapAsyncStatus status, wgpu::StringView) {
                                           mapped = status == wgpu::MapAsyncStatus::Success;
                                         }),
                         UINT64_MAX);
  if (!mapped) return false;
  const auto* src = static_cast<const std::uint8_t*>(buffer.GetConstMappedRange(0, static_cast<std::size_t>(size)));
  if (src == nullptr) {
    buffer.Unmap();
    return false;
  }
  // One allocation per frame read back, on purpose: the RAM tier or the disk
  // writer owns the bytes from here (a frame is megabytes; the tiers bound how many exist).
  const std::size_t rowBytes = std::size_t{width} * 4U;
  out.resize(rowBytes * height);
  for (std::uint32_t y = 0; y < height; ++y) {
    std::memcpy(out.data() + rowBytes * y, src + std::size_t{row} * y, rowBytes);
  }
  buffer.Unmap();
  constexpr std::size_t kSpareBuffers = 6;
  if (diskSpareSize_ == size && diskSpare_.size() < kSpareBuffers) diskSpare_.push_back(std::move(buffer));
  return true;
}

void RenderThread::on_vram_evict(const FrameCache::Evicted& ev, wgpu::CommandEncoder& encoder) {
  if (ev.texture == nullptr || ram_.contains(ev.key)) return;
  const std::size_t bytes = std::size_t{ev.width} * ev.height * 4;
  const bool ramKeeps = ram_.would_keep(bytes, protect_);
  // The RAM tier full of the range being played: a slow frame still has the disk tier.
  const bool diskWants = !ramKeeps && ev.meta.diskKey != 0 && ev.meta.drawMs > 0 && disk_->enabled() &&
                         worth_disk(ev.meta.drawMs, ev.width, ev.height) && !disk_->contains(ev.meta.diskKey);
  if (!ramKeeps && !diskWants) return;
  // Bounded: each read-back holds a frame-sized buffer until it is drained.
  while (victims_.size() >= kMaxVictims) drain_victims(true);
  Victim v;
  v.buffer = encode_readback(*ev.texture, ev.width, ev.height, v.row, encoder);
  v.key = ev.key;
  v.width = ev.width;
  v.height = ev.height;
  v.meta = ev.meta;
  v.diskOnly = !ramKeeps;
  victimsEncoding_.push_back(std::move(v));
}

void RenderThread::store_vram(std::uint64_t key, const wgpu::Texture& source, std::uint32_t width, std::uint32_t height,
                              const FrameMeta& meta) {
  wgpu::CommandEncoder enc = gpu_->device.CreateCommandEncoder();
  cache_->store(key, width, height, source, enc, meta,
                [this](const FrameCache::Evicted& ev, wgpu::CommandEncoder& e) { on_vram_evict(ev, e); });
  const wgpu::CommandBuffer cb = enc.Finish();
  gpu_->queue.Submit(1, &cb);
  for (Victim& v : victimsEncoding_) {
    v.done = gpu_->queue.OnSubmittedWorkDone(wgpu::CallbackMode::WaitAnyOnly, [](wgpu::QueueWorkDoneStatus, wgpu::StringView) {});
    victims_.push_back(std::move(v));
  }
  victimsEncoding_.clear();
}

void RenderThread::drain_victims(bool block) {
  while (!victims_.empty()) {
    const wgpu::WaitStatus st = gpu_->instance.WaitAny(victims_.front().done, block ? UINT64_MAX : 0);
    if (st == wgpu::WaitStatus::TimedOut) break;
    Victim v = std::move(victims_.front());
    victims_.pop_front();
    block = false;  // only the oldest is waited for
    if (st != wgpu::WaitStatus::Success || gpu_->device_lost()) continue;
    // shared_ptr: the RAM tier's frames are shared with uploads in flight (ram_cache.hpp RamFrame).
    auto rgba = std::make_shared<std::vector<std::uint8_t>>();
    if (!take_readback(std::move(v.buffer), v.row, v.width, v.height, *rgba)) continue;
    if (!v.diskOnly) {
      std::vector<RamFrame> evicted;
      const bool kept = ram_.store(v.key, RamFrame{rgba, v.width, v.height, v.meta.drawMs, v.meta.diskKey, v.meta.tag},
                                   protect_, evicted);
      spill_ram_evictions(evicted);
      if (kept) {
        coverageStale_ = true;
        continue;
      }
    }
    // Not kept in RAM (full of the range being played): a frame worth a file goes to disk.
    if (v.meta.diskKey != 0 && v.meta.drawMs > 0 && disk_->enabled() && worth_disk(v.meta.drawMs, v.width, v.height) &&
        !disk_->contains(v.meta.diskKey) && disk_->store(v.meta.diskKey, v.width, v.height, std::move(*rgba))) {
      diskCoverageStale_ = true;
    }
  }
}

bool RenderThread::settle_victim(std::uint64_t key) {
  const auto pending = [this, key] {
    return std::ranges::any_of(victims_, [key](const Victim& v) { return v.key == key; });
  };
  if (!pending()) return false;
  while (pending()) drain_victims(true);
  return true;
}

void RenderThread::spill_ram_evictions(std::vector<RamFrame>& evicted) {
  for (RamFrame& f : evicted) {
    if (f.diskKey == 0 || f.rgba == nullptr || f.drawMs <= 0 || !disk_->enabled()) continue;
    if (!worth_disk(f.drawMs, f.width, f.height) || disk_->contains(f.diskKey)) continue;
    // Moved when nothing else holds the pixels (an upload in flight may).
    std::vector<std::uint8_t> bytes = f.rgba.use_count() == 1 ? std::move(*f.rgba) : *f.rgba;
    if (disk_->store(f.diskKey, f.width, f.height, std::move(bytes))) diskCoverageStale_ = true;
  }
  evicted.clear();
}

void RenderThread::queue_disk_readback(InFlight& f, std::uint64_t diskKey, const wgpu::Texture& source,
                                       std::uint32_t width, std::uint32_t height) {
  f.diskBuffer = encode_disk_readback(source, width, height, f.diskRow);
  f.diskKey = diskKey;
}

void RenderThread::spill_to_disk(InFlight& f, std::uint32_t width, std::uint32_t height) {
  if (f.diskBuffer == nullptr) return;
  wgpu::Buffer buffer = std::move(f.diskBuffer);
  f.diskBuffer = nullptr;
  write_disk_readback(std::move(buffer), f.diskRow, f.diskKey, width, height);
}

void RenderThread::queue_late_spill(std::uint64_t key, std::uint64_t diskKey, std::uint32_t width, std::uint32_t height) {
  if (!cache_ || !disk_->reserve(diskKey)) return;
  // The frame's VRAM copy, not the slot: the slot is the host's now, and may
  // carry an onion ghost. Evicted already (a small cache, a long fill) = no file.
  const wgpu::Texture source = cache_->peek(key, width, height);
  if (source == nullptr) {
    disk_->release(diskKey);
    return;
  }
  Spill s;
  s.buffer = encode_disk_readback(source, width, height, s.row);
  s.done = gpu_->queue.OnSubmittedWorkDone(wgpu::CallbackMode::WaitAnyOnly, [](wgpu::QueueWorkDoneStatus, wgpu::StringView) {});
  s.diskKey = diskKey;
  s.width = width;
  s.height = height;
  spills_.push_back(std::move(s));
  if (spills_.size() > kMaxSpills) drain_spills(true);
}

void RenderThread::drain_spills(bool block) {
  while (!spills_.empty()) {
    Spill& s = spills_.front();
    const wgpu::WaitStatus st = gpu_->instance.WaitAny(s.done, block ? UINT64_MAX : 0);
    if (st == wgpu::WaitStatus::TimedOut) break;
    if (st == wgpu::WaitStatus::Success && !gpu_->device_lost()) {
      write_disk_readback(std::move(s.buffer), s.row, s.diskKey, s.width, s.height);
    } else {
      disk_->release(s.diskKey);
    }
    spills_.pop_front();
    block = false;  // only the oldest is waited for
  }
}

void RenderThread::write_disk_readback(wgpu::Buffer buffer, std::uint32_t row, std::uint64_t diskKey,
                                       std::uint32_t width, std::uint32_t height) {
  // The disk cache's writer thread owns the bytes until they are on disk, and
  // its queue bounds how many exist (DiskCache::kMaxQueuedBytes). A frame is
  // read back once — DiskCache::wants refuses one already on disk or queued.
  std::vector<std::uint8_t> rgba;
  if (!take_readback(std::move(buffer), row, width, height, rgba)) {
    disk_->release(diskKey);
    return;
  }
  if (disk_->store(diskKey, width, height, std::move(rgba))) diskCoverageStale_ = true;
}

void RenderThread::abandon_disk(InFlight& f) {
  if (f.diskBuffer == nullptr) return;
  f.diskBuffer = nullptr;
  disk_->release(f.diskKey);
}

void RenderThread::abandon_all_disk() {
  for (InFlight& f : inflight_) abandon_disk(f);
  for (const Spill& s : spills_) disk_->release(s.diskKey);
  spills_.clear();
}

void RenderThread::seed_disk_read_cost() {
  if (diskReadMeasured_) return;
  const double readMsPerMp = disk_->read_ms_per_mp();
  if (readMsPerMp <= 0) return;
  // The cache times a file's read + decode; the upload to the GPU (a
  // WriteTexture of the decoded pixels) comes on top of it here.
  constexpr double kUploadMsPerMp = 0.25;
  diskReadMsPerMp_ = readMsPerMp + kUploadMsPerMp;
  diskReadMeasured_ = true;
}

void RenderThread::note_coverage(const RenderJob& job, std::uint64_t key, std::uint64_t diskKey) {
  std::deque<ScopeCover>& scopes = cover_[job.viewport];
  if (scopes.empty() || scopes.front().scope != job.cacheScope) {
    // Another comp, an edit, another view: the bars follow what the viewport
    // shows now. A scope seen lately comes back with what it still has cached.
    const auto it = std::ranges::find_if(scopes, [&job](const ScopeCover& c) { return c.scope == job.cacheScope; });
    ScopeCover current;
    if (it != scopes.end()) {
      current = std::move(*it);
      scopes.erase(it);
    } else {
      current.scope = job.cacheScope;
      // The same view at a new revision (Session::cache_scope: view in the high
      // word): when this frame drew under the key it had before, the change did
      // not touch it — a background update (a footage probe), an edit that
      // reaches no pixel — and the view's coverage carries over. Changed here,
      // the bar starts again from what is drawn now.
      if (!scopes.empty() && (scopes.front().scope >> 32U) == (job.cacheScope >> 32U)) {
        const auto& prev = scopes.front().frames;
        if (const auto at = prev.find(job.frame); at != prev.end() && at->second.first == key) current.frames = prev;
      }
    }
    scopes.push_front(std::move(current));
    if (scopes.size() > kScopesKept) scopes.pop_back();
    coverageStale_ = true;
  }
  auto& entry = scopes.front().frames[job.frame];
  if (entry.first != key || (diskKey != 0 && entry.second != diskKey)) coverageStale_ = true;
  entry.first = key;
  if (diskKey != 0) entry.second = diskKey;
  publish_coverage_soon();
}

void RenderThread::publish_coverage_soon() {
  if (!coverageStale_ && !diskCoverageStale_) return;
  if (SteadyClock::now() - coveragePublishedAt_ < kCoverageEvery) return;
  publish_coverage();
}

void RenderThread::composite_onion(const RenderJob& job, const wgpu::TextureView& slot, std::uint32_t width,
                                   std::uint32_t height) {
  if (!drawer_ || width == 0 || height == 0) return;
  if (onionTex_ == nullptr || onionW_ != width || onionH_ != height) {
    wgpu::TextureDescriptor td{};
    td.size = {width, height, 1};
    td.format = wgpu::TextureFormat::RGBA8Unorm;
    td.usage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::TextureBinding;
    onionTex_ = gpu_->device.CreateTexture(&td);
    onionView_ = onionTex_.CreateView();
    onionW_ = width;
    onionH_ = height;
  }
  for (const RenderJob::OnionGhost& ghost : job.onion) {
    if (!ghost.built) continue;
    std::string error;
    if (!drawer_->draw(*ghost.built, onionView_, width, height, error)) {
      PREMATION_LOG(error, "onion_draw_failed").kv("error", error);
      continue;
    }
    wgpu::CommandEncoder enc = gpu_->device.CreateCommandEncoder();
    compositor_->blend_over(enc, onionView_, slot, ghost.opacity, ghost.tintR, ghost.tintG, ghost.tintB, ghost.tintStrength);
    const wgpu::CommandBuffer cb = enc.Finish();
    gpu_->queue.Submit(1, &cb);
  }
}

void RenderThread::publish_coverage() {
  coverageStale_ = false;
  diskCoverageStale_ = false;
  coveragePublishedAt_ = SteadyClock::now();
  // Each viewport's current scope: the green bar is what VRAM or RAM holds,
  // the blue one what is on disk (a frame queued for writing joins once
  // written). A frame no tier holds any more is forgotten.
  std::vector<std::int64_t> ramFrames;
  std::vector<std::int64_t> diskFrames;
  std::vector<std::uint64_t> diskKeys;
  // Per disk key: its frame, and its scope when only the disk may still hold it (pruned if not).
  std::vector<std::pair<ScopeCover*, std::int64_t>> diskOf;
  for (auto& [viewport, scopes] : cover_) {
    if (scopes.empty()) continue;
    ScopeCover& cur = scopes.front();
    for (auto it = cur.frames.begin(); it != cur.frames.end();) {
      const auto [key, diskKey] = it->second;
      // A frame VRAM just evicted is on its way into RAM (a read-back in flight): still in memory.
      const bool inMemory = (cache_ != nullptr && cache_->contains(key)) || ram_.contains(key) ||
                            std::ranges::any_of(victims_, [key](const Victim& v) { return v.key == key && !v.diskOnly; });
      if (inMemory) ramFrames.push_back(it->first);
      if (diskKey != 0) {
        diskKeys.push_back(diskKey);
        diskOf.emplace_back(inMemory ? nullptr : &cur, it->first);
      } else if (!inMemory) {
        it = cur.frames.erase(it);
        continue;
      }
      ++it;
    }
  }
  std::vector<std::uint8_t> onDisk;
  disk_->presence(diskKeys, onDisk);
  for (std::size_t i = 0; i < diskKeys.size(); ++i) {
    if (onDisk[i] == 2) diskFrames.push_back(diskOf[i].second);
    if (onDisk[i] == 0 && diskOf[i].first != nullptr) diskOf[i].first->frames.erase(diskOf[i].second);
  }
  CacheCoverageSnap snap;
  snap.ram = coalesce_frame_indices(std::move(ramFrames));
  snap.ramBytes = (cache_ ? static_cast<std::uint64_t>(cache_->stats().bytes) : 0) + ram_.bytes();
  snap.disk = coalesce_frame_indices(std::move(diskFrames));
  snap.diskBytes = disk_->bytes();
  const std::lock_guard<std::mutex> lock(m_);
  coverage_ = std::move(snap);
  ramStats_ = ram_.stats();
}

std::string RenderThread::open_gpu() {
#if defined(PREMATION_SHARED_TEXTURE)
  // Windows (NT handles), macOS (IOSurfaces), Linux with GBM (dmabufs): a host to share with.
  const bool wantShared = options_.hostPid != 0;
#else
  const bool wantShared = false;  // Linux without GBM: no shared route — the route-A copy
#endif
  gpu_ = create_gpu(wantShared, options_.highPerformance, options_.vendorId);
  if (!gpu_) return "no GPU adapter / device (Dawn)";
  compositor_ = std::make_unique<Compositor>();
  if (!compositor_->init(*gpu_)) return "compositor pipelines failed to build";
  if (options_.makeDrawer) {
    // D2w: the render graph over the engine's own document. A drawer that
    // cannot start leaves C2's quad compositor in charge (logged, not fatal).
    std::string error;
    drawer_ = options_.makeDrawer(*gpu_, error);
    if (!drawer_) {
      PREMATION_LOG(warn, "scene_drawer_failed").kv("error", error);
    }
  }
  if (drawer_ && options_.frameCacheBytes != 0) {
    // D4: only built frames have content keys; C2's quads are never cached.
    std::size_t budget = options_.frameCacheBytes;
    if (budget == kFrameCacheAuto) {
      wgpu::AdapterInfo info{};
      gpu_->adapter.GetInfo(&info);
      budget = default_frame_cache_budget(info.vendorID, info.deviceID);
    }
    cache_ = std::make_unique<FrameCache>(gpu_->device, budget);
    PREMATION_LOG(info, "frame_cache").kv("budgetMB", static_cast<double>(budget) / (1024.0 * 1024.0));
  }
  PREMATION_LOG(info, "gpu_ready")
      .kv("adapter", gpu_->adapterName)
      .kv("backend", gpu_->backend)
      .kv("sharedTexture", gpu_->sharedTextureCapable)
      .kv("slots", options_.slots);
  const std::lock_guard<std::mutex> lock(m_);
  adapter_ = gpu_->adapterName;
  backend_ = gpu_->backend;
  sharedCapable_ = wantShared && gpu_->sharedTextureCapable;
  return {};
}

void RenderThread::close_gpu() {
  if (gpu_) wait_idle(*gpu_);
  {
    // Only the render thread touches `slots`; m_ guards the map against a
    // concurrent configure() inserting a viewport.
    const std::lock_guard<std::mutex> lock(m_);
    for (auto& [id, p] : ports_) p->slots.reset();
    coverage_ = {};
  }
  retired_.clear();
  // Buffers of this device; the RAM tier and the disk cache (files) carry on.
  for (const Spill& s : spills_) disk_->release(s.diskKey);
  spills_.clear();
  victims_.clear();
  victimsEncoding_.clear();
  diskSpare_.clear();
  diskSpareSize_ = 0;
  onionTex_ = nullptr;
  onionView_ = nullptr;
  onionW_ = 0;
  onionH_ = 0;
  cache_.reset();
  drawer_.reset();
  compositor_.reset();
  gpu_.reset();
}

bool RenderThread::recover_device() {
  ++lossesSinceFrame_;
  PREMATION_LOG(error, "device_lost").kv("losses", lossesSinceFrame_);
  close_gpu();
  if (lossesSinceFrame_ > kMaxDeviceRecoveries) return false;
  if (std::string error = open_gpu(); !error.empty()) {
    PREMATION_LOG(error, "device_recovery_failed").kv("error", error);
    close_gpu();
    return false;
  }
  return true;
}

void RenderThread::run(std::promise<std::string>& ready) {
  if (std::string error = open_gpu(); !error.empty()) {
    close_gpu();
    ready.set_value(std::move(error));
    return;
  }
  ready.set_value({});

  std::unique_lock<std::mutex> lock(m_);
  const auto anyDirty = [this] {
    return std::any_of(ports_.begin(), ports_.end(), [](const auto& e) { return e.second->dirty; });
  };
  // P7's warm-up is a synchronous pipeline compile: only in true idle time —
  // never while frames are on the GPU (their announcement would wait behind
  // it) nor while the transport plays (the next frame would).
  const auto canWarm = [this] { return inflight_.empty() && !lastJobPlaying_ && drawer_ && drawer_->warm_pending(); };
  // A step that holds this thread a second or more delays every query queued
  // behind it (render_query_late): the log says which step it was.
  const auto timed = [](const char* what, auto&& step) {
    const auto t0 = SteadyClock::now();
    step();
    const auto took = SteadyClock::now() - t0;
    if (took >= std::chrono::seconds(1)) {
      PREMATION_LOG(warn, "render_step_slow")
          .kv("what", what)
          .kv("ms", static_cast<std::int64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(took).count()));
    }
  };
  // Paused footage still decoding (Port::settling): the earliest poll, if any.
  const auto nextSettle = [this]() -> std::optional<SteadyClock::time_point> {
    std::optional<SteadyClock::time_point> at;
    for (const auto& [id, p] : ports_) {
      if (!p->settling.empty() && !p->pending && (!at || p->settleAt < *at)) at = p->settleAt;
    }
    return at;
  };
  const auto settleDue = [&nextSettle] {
    const auto at = nextSettle();
    return at && *at <= SteadyClock::now();
  };
  const auto workReady = [this, &anyDirty, &canWarm, &settleDue] {
    return quit_ || anyDirty() || !tasks_.empty() || next_ready_locked() != nullptr || canWarm() || settleDue();
  };
  for (;;) {
    if (!inflight_.empty()) {
      // P5: frames on the GPU. With nothing else to do, wait for the oldest;
      // otherwise announce whatever finished and get on with the next frame.
      const bool idle = !workReady();
      lock.unlock();
      timed("complete_frames", [&] { (void)complete_frames(idle); });
      lock.lock();
      if (idle) continue;
    } else {
      // Sleep until work, or the next settle poll (paused footage still decoding).
      // Late disk spills or VRAM evictions in flight: look again shortly (a copy is a millisecond or two).
      const bool copies = !spills_.empty() || !victims_.empty();
      auto until = SteadyClock::now() + (copies ? std::chrono::milliseconds(2) : std::chrono::milliseconds(500));
      if (const auto at = nextSettle(); at && *at < until) until = *at;
      // Coverage held back by publish_coverage_soon's throttle: out at the next slot, not after a long sleep.
      if (coverageStale_ && coveragePublishedAt_ + kCoverageEvery < until) until = coveragePublishedAt_ + kCoverageEvery;
      cv_.wait_until(lock, until, workReady);
      if ((!spills_.empty() || !victims_.empty()) && !quit_ && !gpu_->device_lost()) {
        lock.unlock();
        timed("drain_spills", [&] {
          drain_spills(false);
          drain_victims(false);
        });
        lock.lock();
      }
    }
    if (quit_) break;
    if (gpu_->device_lost()) {
      abandon_all_disk();
      inflight_.clear();  // their slots are rebuilt with the device (a new generation)
      lock.unlock();
      const bool recovered = recover_device();
      if (!recovered && onFatal_) onFatal_("GPU device lost");
      lock.lock();
      if (!recovered) break;
      // New slots (a new generation the host imports) for every viewport, and
      // each one's last frame again unless a newer one is waiting: no viewport
      // is left blank.
      for (auto& [id, p] : ports_) {
        p->dirty = true;
        if (!p->pending) std::swap(p->pending, p->lastJob);
      }
      continue;
    }
    const auto now = SteadyClock::now();
    if (!retired_.empty()) {
      lock.unlock();
      collect_retired(now);
      lock.lock();
    }
    if (anyDirty()) {
      // Frames in flight belong to the rings about to be replaced: announce them first.
      lock.unlock();
      timed("complete_all", [&] { complete_all(); });
      lock.lock();
      const bool shared = shared_;
      const bool copy = copy_;
      for (auto it = ports_.begin(); it != ports_.end();) {
        Port& p = *it->second;
        if (!p.dirty) {
          ++it;
          continue;
        }
        p.dirty = false;
        const ViewportConfig config = p.config;
        lock.unlock();
        timed("rebuild", [&] { rebuild(p, config, shared, copy); });  // a closed viewport: an empty ring, announced
        lock.lock();
        // Forget a viewport that is (still) closed once its ring is retired; its
        // late releases name a generation no ring has any more.
        if (!p.config.open && !p.dirty) {
          cover_.erase(it->first);
          coverageStale_ = true;
          it = ports_.erase(it);
        } else {
          it = std::next(it);
        }
      }
      continue;
    }
    if (!tasks_.empty()) {
      // Queries between frames: a still or a pixel read never waits behind a
      // playing viewport for more than the frame in hand.
      lock.unlock();
      timed("complete_all", [&] { complete_all(); });
      lock.lock();
      run_tasks(lock);
      continue;
    }
    if (settleDue()) {
      // Poll the footage each due port waits on; once decoded, its last job again.
      for (auto& [id, p] : ports_) {
        if (p->settling.empty() || p->pending || p->settleAt > SteadyClock::now()) continue;
        ++p->settleTries;
        if (!p->lastJob || !p->config.open) {
          p->settling.clear();
        } else if (drawer_ && drawer_->media_settled(p->settling)) {
          p->settling.clear();
          p->pending = *p->lastJob;
          p->pending->clockDropped = 0;
        } else {
          p->settleAt = SteadyClock::now() + kSettlePoll;
        }
      }
    }
    Port* port = next_ready_locked();
    if (port == nullptr) {
      // Idle: frames the disk cache finished writing join the blue lane, and
      // frames read back into the RAM tier the green one (the last frames of a
      // fill would otherwise wait for the next frame drawn).
      if (diskCoverageStale_ || coverageStale_) {
        lock.unlock();
        publish_coverage();
        diskCoverageStale_ = disk_->writing();
        lock.lock();
      }
      // Idle: one step of the drawer's warm-up (P7), then look for work again —
      // a frame that arrives waits at most one pipeline compile.
      if (canWarm()) {
        lock.unlock();
        timed("warm_step", [&] { (void)drawer_->warm_step(); });
        lock.lock();
      }
      continue;
    }
    const std::optional<std::uint32_t> slot = port->ring->acquire();
    if (!slot) continue;  // every slot is with the host: keep the newest job until one returns
    RenderJob job = std::move(*port->pending);
    port->pending.reset();
    job.clockDropped = port->droppedPending;
    port->droppedPending = 0;
    lastJobPlaying_ = job.playing;
    lastServed_ = port->config.viewport;
    const ViewportConfig config = port->config;
    lock.unlock();
    timed("render", [&] { render(*port, job, *slot, config); });
    port->lastJob = std::move(job);
    lock.lock();
  }
  // Queries still queued are dropped: their futures report a broken promise,
  // which the core answers as an internal error (the engine is stopping).
  tasks_.clear();
  lock.unlock();
  if (gpu_ && !gpu_->device_lost()) complete_all();
  abandon_all_disk();
  inflight_.clear();
  // Tear down on this thread, which created everything.
  close_gpu();
}

RenderThread::Port* RenderThread::next_ready_locked() {
  // Round-robin: the first ready viewport after the one served last, wrapping.
  const auto ready = [](const Port& p) { return p.pending && p.config.open && p.slots && p.ring->any_free(); };
  for (auto it = ports_.upper_bound(lastServed_); it != ports_.end(); ++it) {
    if (ready(*it->second)) return it->second.get();
  }
  for (auto it = ports_.begin(); it != ports_.end() && it->first <= lastServed_; ++it) {
    if (ready(*it->second)) return it->second.get();
  }
  return nullptr;
}

void RenderThread::post(std::function<void()> task) {
  {
    const std::lock_guard<std::mutex> lock(m_);
    if (quit_) return;  // the task (and its promise) is dropped: a broken promise
    // A query the core gave up on (Session::kRenderQueryTimeout) says how late it ran.
    tasks_.emplace_back([task = std::move(task), posted = SteadyClock::now()] {
      const auto late = SteadyClock::now() - posted;
      if (late >= std::chrono::seconds(1)) {
        PREMATION_LOG(warn, "render_query_late")
            .kv("ms", static_cast<std::int64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(late).count()));
      }
      task();
    });
  }
  cv_.notify_all();
}

void RenderThread::run_tasks(std::unique_lock<std::mutex>& lock) {
  while (!tasks_.empty()) {
    std::function<void()> task = std::move(tasks_.front());
    tasks_.pop_front();
    lock.unlock();
    task();
    lock.lock();
  }
}

std::future<StillImage> RenderThread::render_still(std::shared_ptr<BuiltFrame> frame, std::uint32_t width,
                                                   std::uint32_t height) {
  // shared_ptr: std::function needs a copyable closure; the promise is set
  // exactly once, on the render thread, and read through its future.
  auto promise = std::make_shared<std::promise<StillImage>>();
  std::future<StillImage> result = promise->get_future();
  post([this, promise, frame = std::move(frame), width, height] {
    StillImage out;
    if (!frame || !drawer_) {
      out.answer = HookAnswer::unsupported;
      out.error = frame ? "the render graph did not start on this GPU (C2 quads only)" : "no frame to draw";
    } else if (width == 0 || height == 0) {
      out.answer = HookAnswer::failed;
      out.error = "an empty still";
    } else {
      std::string error;
      if (drawer_->draw_still(*frame, width, height, out, error)) {
        out.answer = HookAnswer::ready;
      } else {
        out = StillImage{};
        out.answer = HookAnswer::failed;
        out.error = std::move(error);
        PREMATION_LOG(warn, "still_failed").kv("error", out.error);
      }
    }
    promise->set_value(std::move(out));
  });
  return result;
}

std::future<WorkingPixels> RenderThread::read_pixels(std::uint32_t viewport, PixelRegion region) {
  // shared_ptr: as render_still.
  auto promise = std::make_shared<std::promise<WorkingPixels>>();
  std::future<WorkingPixels> result = promise->get_future();
  post([this, promise, viewport, region] {
    WorkingPixels out;
    Port* port = nullptr;
    {
      const std::lock_guard<std::mutex> lock(m_);
      if (const auto it = ports_.find(viewport); it != ports_.end()) port = it->second.get();
    }
    // Render thread: `port` stays valid (only this thread erases one).
    const SlotSet* slots = port != nullptr ? port->slots.get() : nullptr;
    const std::optional<RenderJob>* last = port != nullptr ? &port->lastJob : nullptr;
    if (last == nullptr || !*last || slots == nullptr) {
      out.answer = HookAnswer::pending;
      out.error = "viewport " + std::to_string(viewport) + " has shown no frame yet";
    } else if (!(*last)->built || !drawer_) {
      out.answer = HookAnswer::unsupported;
      out.error = "the viewport shows C2 quads: there is no working-space frame to read";
    } else {
      // The ring may have been rebuilt since the core clamped the region.
      PixelRegion r = region;
      r.x = std::min(r.x, slots->width);
      r.y = std::min(r.y, slots->height);
      r.width = std::min(r.width, slots->width - r.x);
      r.height = std::min(r.height, slots->height - r.y);
      std::string error;
      if (r.width == 0 || r.height == 0) {
        out.answer = HookAnswer::failed;
        out.error = "the region is outside the viewport";
      } else if (drawer_->read_working(*(*last)->built, slots->width, slots->height, r, out, error)) {
        out.answer = HookAnswer::ready;
      } else {
        out = WorkingPixels{};
        out.answer = HookAnswer::failed;
        out.error = std::move(error);
        PREMATION_LOG(warn, "read_pixels_failed").kv("error", out.error);
      }
    }
    promise->set_value(std::move(out));
  });
  return result;
}

void RenderThread::rebuild(Port& port, const ViewportConfig& config, bool shared, bool copy) {
  // The slots hold frames at the preview resolution (engine_frames build draws at dpr × it);
  // the page scales them up to the viewer.
  const std::uint32_t W = preview_pixels(config.width, config.resolution);
  const std::uint32_t H = preview_pixels(config.height, config.resolution);
  // A2: a slot-SIZE switch (preview resolution, pane size) is what the HUD reports.
  const bool sizeSwitch = port.slots && (port.slots->width != W || port.slots->height != H) && W > 0 && H > 0;
  const auto rebuildStart = SteadyClock::now();
  auto next = std::make_unique<SlotSet>();
  next->generation = ++generation_;
  next->width = W;
  next->height = H;
  api::FrameSlots announce;
  announce.generation = next->generation;
  announce.viewport = config.viewport;
  announce.width = W;
  announce.height = H;
  std::uint32_t count = 0;
  if (config.open && W > 0 && H > 0) {
    count = options_.slots;
#if defined(PREMATION_SHARED_TEXTURE)
    if (shared) {
      auto pool = std::make_unique<shared::SharedTexturePool>();
      std::string error;
      if (pool->init(*gpu_, W, H, count, options_.hostPid, error)) {
        next->shared = true;
        for (auto& s : pool->slots()) {
          next->views.push_back(s.view);
          next->textures.push_back(s.texture);
          next->copyable = next->copyable && s.copyable;
          announce.handles.push_back(s.remoteHandle);
          if (s.stride != 0) {  // Linux dmabuf: the plane layout the host imports with
            announce.strides.push_back(s.stride);
            announce.offsets.push_back(s.offset);
            announce.sizes.push_back(s.planeSize);
          }
        }
        announce.modifier = pool->modifier();
        next->pool = std::move(pool);
      } else {
        pool->close_remote_handles();  // the ones duplicated before the failure
        PREMATION_LOG(warn, "shared_slots_failed").kv("error", error);
      }
    }
#else
    (void)shared;
#endif
    if (!next->shared) {
      for (std::uint32_t i = 0; i < count; ++i) {
        wgpu::TextureDescriptor td{};
        td.size = {W, H, 1};
        td.format = wgpu::TextureFormat::RGBA8Unorm;
        // CopyDst: a frame-cache hit is copied in; CopySrc: a drawn frame is copied out to the cache.
        td.usage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::CopySrc | wgpu::TextureUsage::CopyDst;
        wgpu::Texture t = gpu_->device.CreateTexture(&td);
        next->views.push_back(t.CreateView());
        next->textures.push_back(std::move(t));
        announce.handles.push_back(0);
      }
      if (copy) {
        // Route A: one read-back buffer per slot, so a slot's copy never waits
        // for another slot's map.
        next->copy = true;
        next->readbackRow = (W * 4U + 255U) & ~255U;
        for (std::uint32_t i = 0; i < count; ++i) {
          wgpu::BufferDescriptor bd{};
          bd.size = std::uint64_t{next->readbackRow} * H;
          bd.usage = wgpu::BufferUsage::MapRead | wgpu::BufferUsage::CopyDst;
          next->readback.push_back(gpu_->device.CreateBuffer(&bd));
        }
      }
    }
  }
  announce.shared = next->shared;
  if (port.slots) {
    port.slots->retiredAt = SteadyClock::now();
    retired_.push_back(std::move(port.slots));
  }
  port.slots = std::move(next);
  port.ring->reset(port.slots->generation, count);
  PREMATION_LOG(info, "slots")
      .kv("viewport", config.viewport)
      .kv("generation", port.slots->generation)
      .kv("width", W)
      .kv("height", H)
      .kv("count", count)
      .kv("shared", port.slots->shared)
      .kv("copy", port.slots->copy);
  if (send_) send_(frames::Message{.v = std::move(announce)});
  const std::lock_guard<std::mutex> lock(m_);
  if (sizeSwitch) {
    counters_.slotSwitchEpochUs = os::epoch_us();
    counters_.slotSwitchMs = std::chrono::duration<double, std::milli>(SteadyClock::now() - rebuildStart).count();
  }
  cv_.notify_all();
}

void RenderThread::collect_retired(SteadyClock::time_point now) {
  std::erase_if(retired_, [now](const std::unique_ptr<SlotSet>& s) { return now - s->retiredAt >= kRetireGrace; });
}

void RenderThread::render(Port& port, RenderJob& job, std::uint32_t slot, const ViewportConfig& /*config*/) {
  SlotSet& set = *port.slots;
  FrameRing& ring = *port.ring;
  const double startUs = os::epoch_us();
  const auto t0 = SteadyClock::now();
#if defined(PREMATION_SHARED_TEXTURE)
  shared::Slot* shared = set.pool ? &set.pool->slots()[slot] : nullptr;
  if (shared != nullptr && !set.pool->begin_access(*shared)) {
    PREMATION_LOG(error, "begin_access_failed").kv("slot", slot);
    ring.unacquire(slot);
    return;
  }
#endif
  bool drawn = false;
  InFlight f;
  if (job.built && drawer_) {
    drawer_->set_exact_media(job.exactMedia);
    const wgpu::Texture& slotTexture = set.textures[slot];
    std::optional<std::uint64_t> key;
    std::optional<std::uint64_t> diskKey;
    if (cache_ && set.copyable) key = drawer_->content_key(*job.built, set.width, set.height);
    // Every frame the disk tier could hold is keyed (a hash of the content key
    // and the footage stamps, cached for seconds): whether one is worth a file
    // is known only once it has drawn — the first frame after an open, or the
    // one a new raster lands on, is the slow one a prediction never sees.
    // The prediction is the cheaper of the running average and the last drawn
    // frame: a slow first frame (pipelines compiling) must not make the next
    // ones pay for eager read-backs the real draw time then turns down.
    seed_disk_read_cost();
    // The RAM tier keeps the frames of the range this viewport plays (ram_cache.hpp).
    if (job.recordCoverage) protect_ = ProtectedRange{job.cacheScope, job.rangeFirst, job.rangeLast};
    manage_ram_budget(false);
    const FrameTag tag{job.recordCoverage ? job.cacheScope : 0, job.frame};
    const double predictedMs = std::min(drawMsAvg_, lastDrawMs_);
    if (key && disk_->enabled()) diskKey = drawer_->disk_key(*job.built, set.width, set.height);
    const std::uint64_t dk = diskKey.value_or(0);
    if (key) {
      // D4: the same content was drawn before — a copy instead of the frame.
      wgpu::CommandEncoder enc = gpu_->device.CreateCommandEncoder();
      if (cache_->copy_to(*key, set.width, set.height, slotTexture, enc)) {
        const wgpu::CommandBuffer cb = enc.Finish();
        gpu_->queue.Submit(1, &cb);
        drawn = true;
        if (FrameMeta* m = cache_->meta(*key)) {
          m->tag = tag;
          if (dk != 0) m->diskKey = dk;
        }
        if (job.recordCoverage) note_coverage(job, *key, dk);
      }
    }
    if (!drawn && key && (ram_.contains(*key) || settle_victim(*key))) {
      // The RAM tier: a frame VRAM evicted — one upload instead of the render.
      // Back into VRAM with it, so scrubbing over it again is a copy.
      if (const std::optional<RamFrame> hit = ram_.find(*key, set.width, set.height, tag)) {
        wgpu::TexelCopyTextureInfo dst{};
        dst.texture = slotTexture;
        wgpu::TexelCopyBufferLayout layout{};
        layout.bytesPerRow = set.width * 4U;
        layout.rowsPerImage = set.height;
        const wgpu::Extent3D size{set.width, set.height, 1};
        gpu_->queue.WriteTexture(&dst, hit->rgba->data(), hit->rgba->size(), &layout, &size);
        store_vram(*key, slotTexture, set.width, set.height, FrameMeta{tag, hit->drawMs, dk != 0 ? dk : hit->diskKey});
        drawn = true;
        if (job.recordCoverage) note_coverage(job, *key, dk);
      }
    }
    if (!drawn && diskKey && disk_->contains(*diskKey) && load_from_disk(*diskKey, set.width, set.height, slotTexture)) {
      // The disk tier: a frame VRAM evicted, or one drawn in an earlier
      // session — a file read instead of the render. Back into VRAM and RAM
      // with it, so the next pass over it is a copy again.
      store_vram(*key, slotTexture, set.width, set.height, FrameMeta{tag, 0, *diskKey});
      // The read pixels move into the RAM tier (WriteTexture took its copy); the scratch is refilled next time.
      std::vector<RamFrame> evicted;
      (void)ram_.store(*key,
                       RamFrame{std::make_shared<std::vector<std::uint8_t>>(std::move(diskScratch_)), set.width, set.height,
                                0, *diskKey, tag},
                       protect_, evicted);
      diskScratch_.clear();
      spill_ram_evictions(evicted);
      drawn = true;
      if (job.recordCoverage) note_coverage(job, *key, *diskKey);
    }
    if (!drawn) {
      std::string error;
      drawn = drawer_->draw(*job.built, set.views[slot], set.width, set.height, error);
      f.drawn = drawn;
      if (!drawn) {
        PREMATION_LOG(error, "scene_draw_failed").kv("error", error).kv("frame", job.frame);
      } else if (!drawer_->last_frame_exact()) {
        // Footage from a nearest decoded frame (or a GPU error): shown, never cached.
        f.inexact = job.playing;
      } else if (key) {
        store_vram(*key, slotTexture, set.width, set.height, FrameMeta{tag, 0, dk});
        f.vramKey = *key;
        // An exact frame not on disk yet, predicted slow: read it back now
        // (before any onion ghost lands on the slot) for the writer once the
        // GPU is done. Predicted fast: complete_frames decides on its real
        // draw time, and reads a slow one back from its VRAM copy.
        if (diskKey && worth_disk(predictedMs, set.width, set.height) && disk_->reserve(*diskKey)) {
          queue_disk_readback(f, *diskKey, slotTexture, set.width, set.height);
        } else if (diskKey && !disk_->contains(*diskKey)) {
          f.lateDisk = std::make_pair(*key, *diskKey);
        }
        if (job.recordCoverage) note_coverage(job, *key, dk);
      }
    }
    f.cached = drawn && !f.drawn;
    if (drawn && !job.onion.empty() && compositor_) composite_onion(job, set.views[slot], set.width, set.height);
    // A paused frame whose footage came from a stand-in: wait for the decode, then draw it again.
    MediaWants wants = drawer_->take_media_wants();
    if (job.playing || job.exactMedia || wants.empty()) {
      port.settling.clear();
      port.settleTries = 0;
    } else if (port.settleTries < kMaxSettleTries) {
      port.settling = std::move(wants);
      port.settleAt = SteadyClock::now() + kSettlePoll;
    } else {
      port.settling.clear();
    }
  }
  if (!drawn) {
    // C2's quads (a built frame that failed to draw has none: the slot clears to black).
    wgpu::CommandEncoder enc = gpu_->device.CreateCommandEncoder();
    // The slot is already at the preview resolution (rebuild): no second reduction.
    compositor_->encode(enc, job.scene, set.views[slot], set.width, set.height, 1.0);
    const wgpu::CommandBuffer cb = enc.Finish();
    gpu_->queue.Submit(1, &cb);
  }
#if defined(PREMATION_SHARED_TEXTURE)
  if (shared != nullptr) (void)set.pool->end_access(*shared);
#endif
  if (set.copy) {
    // Route A: the drawn slot into its read-back buffer, in queue order after the draw.
    wgpu::CommandEncoder enc = gpu_->device.CreateCommandEncoder();
    wgpu::TexelCopyTextureInfo src{};
    src.texture = set.textures[slot];
    wgpu::TexelCopyBufferInfo dst{};
    dst.buffer = set.readback[slot];
    dst.layout.bytesPerRow = set.readbackRow;
    dst.layout.rowsPerImage = set.height;
    const wgpu::Extent3D size{set.width, set.height, 1};
    enc.CopyTextureToBuffer(&src, &dst, &size);
    const wgpu::CommandBuffer cb = enc.Finish();
    gpu_->queue.Submit(1, &cb);
  }
  // Electron's rgba sharedTexture import takes no fence, so a frame is
  // complete on the GPU before its slot is announced (docs/VIEWPORT_ROUTE.md,
  // implication 6). P5: the render thread does not wait for it here — the
  // completion is polled (complete_frames), and the next frame's CPU work
  // (rasters, encoding) runs while this one's GPU work does. Frames are still
  // announced in submission order, each only once its work is done.
  (void)ring;
  f.port = &port;
  f.generation = set.generation;
  f.slot = slot;
  f.copy = set.copy;
  f.t0 = t0;
  f.done = gpu_->queue.OnSubmittedWorkDone(wgpu::CallbackMode::WaitAnyOnly, [](wgpu::QueueWorkDoneStatus, wgpu::StringView) {});
  api::FrameReady& ready = f.ready;
  ready.generation = set.generation;
  ready.slot = slot;
  ready.viewport = job.viewport;
  ready.dropped = job.clockDropped;
  ready.frame = job.frame;
  ready.time = job.time;
  ready.revision = job.revision;
  ready.render_start_us = startUs;
  ready.width = set.width;
  ready.height = set.height;
  // B4 round 2: the overlays' geometry for this frame first (the host pairs it with the FrameReady that follows).
  if (job.geometrySubscribed) {
    // A job drawn again once its footage settles announces its geometry again: keep it.
    f.geometry = port.settling.empty()
                     ? doc::pack_frame_geometry(job.viewport, set.generation, job.frame, job.time, job.revision,
                                                std::move(job.geometry), std::move(job.views))
                     : doc::pack_frame_geometry(job.viewport, set.generation, job.frame, job.time, job.revision, job.geometry,
                                                job.views);
  }
  inflight_.push_back(std::move(f));
}

std::size_t RenderThread::complete_frames(bool block) {
  std::size_t n = 0;
  while (!inflight_.empty()) {
    InFlight& f = inflight_.front();
    const wgpu::WaitStatus st = gpu_->instance.WaitAny(f.done, block && n == 0 ? UINT64_MAX : 0);
    if (st == wgpu::WaitStatus::TimedOut) break;
    FrameRing& ring = *f.port->ring;
    SlotSet* set = f.port->slots.get();
    const bool sameSet = set != nullptr && set->generation == f.generation;
    // A failed wait (the device went away under it) never announces the frame.
    if (st != wgpu::WaitStatus::Success || gpu_->device_lost() || !sameSet) {
      // The slot holds nothing: never announced; the loop recovers and draws the job again.
      if (sameSet) ring.unacquire(f.slot);
      abandon_disk(f);
      inflight_.pop_front();
      ++n;
      continue;
    }
    if (f.copy && !send_copy(*set, f.slot)) {
      // No pixels, no FrameReady: the host pairs the two and would wait for pixels forever.
      ring.unacquire(f.slot);
      abandon_disk(f);
      inflight_.pop_front();
      ++n;
      continue;
    }
    lossesSinceFrame_ = 0;
    f.ready.render_done_us = os::epoch_us();
    const double gpuMs = std::chrono::duration<double, std::milli>(SteadyClock::now() - f.t0).count();
    if (send_) {
      for (api::FrameGeometry& g : f.geometry) send_(frames::Message{.v = std::move(g)});
      send_(frames::Message{.v = f.ready});
    }
    // After the announcement: the viewer never waits for the disk cache.
    if (f.drawn) {
      drawMsAvg_ = drawMsAvg_ == 0 ? gpuMs : 0.7 * drawMsAvg_ + 0.3 * gpuMs;
      lastDrawMs_ = gpuMs;
      // What the frame cost travels with it down the tiers (the disk tier takes only slow ones).
      if (f.vramKey && cache_) {
        if (FrameMeta* m = cache_->meta(*f.vramKey)) m->drawMs = gpuMs;
      }
    }
    const bool worth = f.drawn && worth_disk(gpuMs, set->width, set->height);
    if (f.diskBuffer != nullptr) {
      if (worth) {
        spill_to_disk(f, set->width, set->height);
      } else {
        abandon_disk(f);  // this one drew fast after all: VRAM is enough for it
      }
    } else if (worth && f.lateDisk) {
      queue_late_spill(f.lateDisk->first, f.lateDisk->second, set->width, set->height);
    }
    {
      const std::lock_guard<std::mutex> lock(m_);
      if (cache_) cacheStats_ = cache_->stats();
      ++counters_.rendered;
      if (f.inexact) ++counters_.inexact;
      ++windowFrames_;
      if (f.cached) ++windowCached_;
      windowGpuMs_ += gpuMs;
      // A2: VRAM per frame (the device meter + held footage + the frame cache: a few integer reads).
      counters_.vramBytes = (drawer_ ? drawer_->vram_bytes() : 0) + cacheStats_.bytes;
      const auto now = SteadyClock::now();
      const double secs = std::chrono::duration<double>(now - windowStart_).count();
      if (secs >= 1.0) {
        if (drawer_) counters_.decodeMs = drawer_->decode_ms();
        counters_.fps = static_cast<double>(windowFrames_) / secs;
        counters_.gpuFrameMs = windowGpuMs_ / static_cast<double>(std::max<std::uint64_t>(windowFrames_, 1));
        counters_.cacheHitRate = static_cast<double>(windowCached_) / static_cast<double>(std::max<std::uint64_t>(windowFrames_, 1));
        windowFrames_ = 0;
        windowCached_ = 0;
        windowGpuMs_ = 0;
        windowStart_ = now;
      }
    }
    inflight_.pop_front();
    ++n;
  }
  if (!spills_.empty() && !gpu_->device_lost()) drain_spills(false);
  if (!victims_.empty() && !gpu_->device_lost()) drain_victims(false);
  return n;
}

void RenderThread::complete_all() {
  while (!inflight_.empty()) (void)complete_frames(true);
}

bool RenderThread::send_copy(SlotSet& set, std::uint32_t slot) {
  const wgpu::Buffer& buffer = set.readback[slot];
  const std::uint64_t size = std::uint64_t{set.readbackRow} * set.height;
  bool mapped = false;
  gpu_->instance.WaitAny(buffer.MapAsync(wgpu::MapMode::Read, 0, size, wgpu::CallbackMode::WaitAnyOnly,
                                         [&mapped](wgpu::MapAsyncStatus status, wgpu::StringView) {
                                           mapped = status == wgpu::MapAsyncStatus::Success;
                                         }),
                         UINT64_MAX);
  if (!mapped) {
    PREMATION_LOG(error, "copy_map_failed").kv("slot", slot);
    return false;
  }
  const auto* src = static_cast<const std::uint8_t*>(buffer.GetConstMappedRange(0, static_cast<std::size_t>(size)));
  if (src == nullptr) {
    buffer.Unmap();
    return false;
  }
  pixels::Header header;
  header.generation = set.generation;
  header.slot = slot;
  header.width = set.width;
  header.height = set.height;
  header.bytesPerRow = set.width * 4U;  // tightly packed on the wire (VideoFrame's default layout)
  const std::size_t payload = pixels::kHeaderBytes + pixels::pixel_bytes(header);
  // One allocation per copied frame, on purpose: the pipe writer thread owns
  // the bytes until they are written, and the ring bounds how many exist at
  // once (a slot is not drawn again before the host releases it). Route A is
  // the fallback path; the shared route allocates nothing per frame.
  std::vector<std::uint8_t> framed(framing::kHeaderBytes + payload);
  const auto length = static_cast<std::uint32_t>(payload);
  for (std::size_t i = 0; i < framing::kHeaderBytes; ++i) {
    framed[i] = static_cast<std::uint8_t>((length >> (8U * i)) & 0xFFU);
  }
  const std::span<std::uint8_t> out(framed);
  pixels::encode_header(header, out.subspan(framing::kHeaderBytes, pixels::kHeaderBytes));
  std::uint8_t* rows = framed.data() + framing::kHeaderBytes + pixels::kHeaderBytes;
  const std::size_t rowBytes = header.bytesPerRow;
  for (std::uint32_t y = 0; y < set.height; ++y) {
    std::memcpy(rows + static_cast<std::size_t>(y) * rowBytes, src + static_cast<std::size_t>(y) * set.readbackRow,
                rowBytes);
  }
  buffer.Unmap();
  if (!options_.sendPixels(std::move(framed))) {
    if (!pixelPipeGone_) {
      PREMATION_LOG(warn, "pixel_stream_closed");
    }
    pixelPipeGone_ = true;
    return false;
  }
  return true;
}

}  // namespace premation::render
