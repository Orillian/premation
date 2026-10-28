#include "media_system.hpp"

#include <algorithm>
#include <exception>
#include <limits>
#include <vector>

#include "core/joining_thread.hpp"
#include "core/log.hpp"

namespace premation::media {

using Clock = std::chrono::steady_clock;

struct MediaSystem::Source {
  SourceId id = 0;
  std::string path;
  MediaInfo info;

  mutable std::mutex mu;
  std::condition_variable wake;
  std::shared_ptr<const FrameIndex> index;
  bool ready = false;    // a decoder opened at least once
  bool failed = false;   // the decoder did not open (or the worker died): never re-opened
  bool closing = false;  // the worker must exit (eviction, close, shutdown)
  bool removed = false;  // close() / shutdown(): never re-opened
  // Decoder pool (see the top of media_system.hpp). `live`: a worker thread is
  // running (or finished but not yet joined) — written under poolMu_ AND mu.
  // `busy`: the worker is decoding a request target (not readahead).
  bool live = false;
  bool busy = false;
  std::uint64_t lastUse = 0;
  std::uint64_t opens = 0;  // workers started; > 1 = a re-open
  int threads = 0;          // libavcodec threads for the worker being started
  // latest lane: one pending target (replaced, never queued) + its generation
  std::int64_t latest = -1;
  std::atomic<std::uint64_t> generation{0};
  // exact lane: FIFO
  std::deque<std::int64_t> exact;
  // playback
  std::int64_t playhead = -1;
  int direction = 0;
  Clock::time_point lastDelivery = Clock::now();
  SourceStats stats;
  std::atomic<bool> stopScan{false};
  std::optional<FrameIndex> scanned;  // under mu, taken by the worker
  // Last members: destroyed (joined) first, while everything they touch lives.
  // `worker` is assigned and joined under poolMu_. `scanner` is assigned by
  // the first worker and joined only after that worker was (under poolMu_).
  premation::JoiningThread worker;
  // Background exact-index scan (long-GOP streams the container can't index).
  // Started once, by the first worker; outlives evictions (its result is kept).
  premation::JoiningThread scanner;
};


namespace {
/// close() / shutdown(): the source is gone for good. Caller holds poolMu_.
void stop_source(MediaSystem::Source& s) {
  {
    const std::scoped_lock lock(s.mu);
    s.closing = true;
    s.removed = true;
    s.generation.fetch_add(1);
  }
  s.stopScan.store(true);
  s.wake.notify_all();
  s.worker.join();
  s.scanner.join();
}
}  // namespace

MediaSystem::MediaSystem(MediaConfig config) : config_(std::move(config)), cache_(config_.cpuCacheBytes, config_.gpuCacheBytes) {
  const unsigned hc = std::thread::hardware_concurrency();
  cores_ = hc > 0 ? hc : 4U;  // 0 = unknown
  maxOpen_ = config_.maxOpenDecoders > 0 ? static_cast<std::size_t>(config_.maxOpenDecoders)
                                         : std::max<std::size_t>(4, cores_);
}

MediaSystem::~MediaSystem() {
  try {
    shutdown();
  } catch (...) {
    // A join that throws (std::system_error) leaves a thread we cannot account
    // for: the engine process must not continue in that state.
    std::terminate();
  }
}

void MediaSystem::shutdown() {
  const std::scoped_lock pool(poolMu_);
  std::unordered_map<SourceId, std::shared_ptr<Source>> all;
  {
    const std::scoped_lock lock(mu_);
    all.swap(sources_);
  }
  // Tell every worker first so they wind down in parallel, then join each.
  for (auto& [id, s] : all) {
    {
      const std::scoped_lock lock(s->mu);
      s->closing = true;
      s->removed = true;
      s->generation.fetch_add(1);
    }
    s->stopScan.store(true);
    s->wake.notify_all();
  }
  for (auto& [id, s] : all) stop_source(*s);
  live_.store(0);
  cache_.clear();  // frames (and their GPU surfaces) before the HwContext goes
}

std::optional<SourceId> MediaSystem::open(const std::string& path, std::string& error) {
  auto s = std::make_shared<Source>();
  FrameIndex idx;
  if (!VideoDecoder::probe(path, s->info, idx, error)) return std::nullopt;
  s->path = path;
  s->index = std::make_shared<const FrameIndex>(std::move(idx));
  {
    const std::scoped_lock lock(mu_);
    s->id = next_++;
    sources_.emplace(s->id, s);
  }
  // No decoder or thread yet: the first request opens it (ensure_open).
  return s->id;
}

void MediaSystem::close(SourceId id) {
  std::shared_ptr<Source> s;
  {
    const std::scoped_lock pool(poolMu_);
    {
      const std::scoped_lock lock(mu_);
      const auto it = sources_.find(id);
      if (it == sources_.end()) return;
      s = it->second;
      sources_.erase(it);
    }
    bool wasLive = false;
    {
      const std::scoped_lock lock(s->mu);
      wasLive = s->live;
    }
    stop_source(*s);
    if (wasLive) live_.fetch_sub(1);
  }
  cache_.drop_source(id);
}

std::size_t MediaSystem::peak_open_decoders() const {
  const std::scoped_lock pool(poolMu_);
  return peak_;
}

// ── the decoder pool ────────────────────────────────────────────────────────
//
// Invariant: a worker thread is started, stopped and joined only under
// poolMu_, and no worker ever takes poolMu_ — so joining under it cannot
// deadlock. Eviction decides "idle" and sets `closing` in ONE s.mu section, and
// requests enqueue + read `live && !closing` in one s.mu section, so a request
// either lands before the check (the source is not idle: not evicted) or sees
// `closing` and calls ensure_open, which waits on poolMu_ for the eviction to
// finish and starts the worker again — the pending request is kept.

void MediaSystem::ensure_open(const std::shared_ptr<Source>& s) {
  const std::scoped_lock pool(poolMu_);
  {
    const std::scoped_lock lock(s->mu);
    if (s->removed || s->failed || s->live) return;  // (live && closing is never seen under poolMu_)
  }
  make_room(s.get(), maxOpen_ - 1);
  const std::size_t openCount = live_.load() + 1;
  int threads = config_.decodeThreads;
  if (threads <= 0) {
    // Shared libavcodec budget: the cores split among the open decoders. Set
    // at (re)open; decoders already open keep theirs (libavcodec fixes it at open).
    const std::size_t share = std::max<std::size_t>(1, cores_ / openCount);
    threads = static_cast<int>(std::clamp<std::size_t>(share, 1, static_cast<std::size_t>(std::max(1, config_.maxThreadsPerDecoder))));
  }
  Source* raw = s.get();  // not the shared_ptr: the Source owns this thread (no cycle); joined before it goes
  premation::JoiningThread worker;
  {
    // Started under s->mu: the worker's first step takes it, so it sees the
    // state below; a failed thread start (throws) changes nothing.
    const std::scoped_lock lock(s->mu);
    s->threads = threads;
    worker = premation::JoiningThread([this, raw] {
      try {
        run(*raw);
      } catch (const std::exception& e) {
        // One bad source never takes the engine down (CLAUDE.md reliability):
        // it fails, its requests resolve to nothing, the rest keep decoding.
        {
          const std::scoped_lock failLock(raw->mu);
          raw->failed = true;
          raw->stats.error = std::string("decoder thread: ") + e.what();
        }
        signal();
      }
    });
    s->opens += 1;  // read by run(): > 1 = a re-open
    s->live = true;
    s->closing = false;
    s->busy = false;
    if (s->opens > 1) ++s->stats.reopens;
  }
  s->worker = std::move(worker);
  live_.store(openCount);
  peak_ = std::max(peak_, openCount);
}

void MediaSystem::make_room(const Source* keep, std::size_t limit) {
  while (live_.load() > limit) {
    std::vector<std::shared_ptr<Source>> all;
    {
      const std::scoped_lock lock(mu_);
      all.reserve(sources_.size());
      for (const auto& [id, v] : sources_) all.push_back(v);
    }
    std::shared_ptr<Source> victim;
    std::uint64_t oldest = std::numeric_limits<std::uint64_t>::max();
    for (const auto& v : all) {
      if (v.get() == keep) continue;
      const std::scoped_lock lock(v->mu);
      if (!v->live) continue;
      if (v->failed) {  // a dead worker: reap it first
        victim = v;
        break;
      }
      if (v->closing || v->busy || v->latest >= 0 || !v->exact.empty()) continue;  // a request in flight
      if (v->lastUse < oldest) {
        oldest = v->lastUse;
        victim = v;
      }
    }
    if (!victim) return;  // soft cap: every open source is busy
    (void)evict(*victim);  // false: a request just arrived there; pick again
  }
}

bool MediaSystem::evict(Source& s) {
  {
    const std::scoped_lock lock(s.mu);
    if (!s.live || s.removed) return false;
    if (!s.failed && (s.closing || s.busy || s.latest >= 0 || !s.exact.empty())) return false;
    s.closing = true;
    s.generation.fetch_add(1);  // a readahead decode in progress stops between packets
  }
  s.wake.notify_all();
  s.worker.join();  // the decoder is destroyed on the worker before this returns
  {
    const std::scoped_lock lock(s.mu);
    s.live = false;
    s.closing = false;
    s.busy = false;
    s.stats.open = false;
    if (!s.failed) ++s.stats.evictions;
  }
  live_.fetch_sub(1);
  return true;
}

void MediaSystem::adopt_index(Source& s, FrameIndex fresh) {
  // The exact index replaces the constant-rate one. Frame numbers only move
  // for variable-rate content; drop what was cached under the old numbering then.
  const FrameIndex& old = *s.index;
  bool moved = old.size() != fresh.size();
  for (std::int64_t i = 0; i < fresh.size() && !moved; i += std::max<std::int64_t>(1, fresh.size() / 64)) {
    moved = old.pts(i) != fresh.pts(i);
  }
  s.index = std::make_shared<const FrameIndex>(std::move(fresh));
  if (s.info.video) {
    s.info.video->exactIndex = true;
    s.info.video->frameCount = s.index->size();
  }
  if (moved) cache_.drop_source(s.id);
}

std::shared_ptr<MediaSystem::Source> MediaSystem::find(SourceId id) const {
  const std::scoped_lock lock(mu_);
  const auto it = sources_.find(id);
  return it == sources_.end() ? nullptr : it->second;
}

bool MediaSystem::info(SourceId id, MediaInfo& out) const {
  const auto s = find(id);
  if (!s) return false;
  const std::scoped_lock lock(s->mu);
  out = s->info;
  return true;
}

std::shared_ptr<const FrameIndex> MediaSystem::index(SourceId id) const {
  const auto s = find(id);
  if (!s) return nullptr;
  const std::scoped_lock lock(s->mu);
  return s->index;
}

bool MediaSystem::wait_ready(SourceId id, std::chrono::milliseconds timeout) {
  const auto s = find(id);
  if (!s) return false;
  {
    const std::scoped_lock lock(s->mu);
    s->lastUse = ++useTick_;
  }
  ensure_open(s);
  std::unique_lock lock(doneMu_);
  const bool ok = done_.wait_for(lock, timeout, [&] {
    const std::scoped_lock sl(s->mu);
    return s->ready || s->failed;
  });
  const std::scoped_lock sl(s->mu);
  return ok && s->ready;
}

FramePtr MediaSystem::cached(SourceId id, std::int64_t frame) { return cache_.get(id, frame); }

FramePtr MediaSystem::nearest(SourceId id, std::int64_t frame) const { return cache_.nearest(id, frame); }

bool MediaSystem::settled(SourceId id, std::int64_t frame) {
  const auto s = find(id);
  if (!s) return true;
  {
    const std::scoped_lock lock(s->mu);
    // (A source closed for the decoder cap is NOT settled: its next request re-opens it.)
    if (s->failed || s->removed) return true;
    if (s->index) frame = s->index->clamp(frame);
  }
  return cache_.contains(id, frame);
}

FramePtr MediaSystem::request(SourceId id, std::int64_t frame, Lane lane) {
  if (FramePtr hit = cache_.get(id, frame)) return hit;
  const auto s = find(id);
  if (!s) return nullptr;
  bool needOpen = false;
  bool changed = true;
  {
    const std::scoped_lock lock(s->mu);
    if (s->failed) return nullptr;
    s->lastUse = ++useTick_;
    frame = s->index ? s->index->clamp(frame) : frame;
    if (lane == Lane::latest) {
      if (s->latest == frame) {
        changed = false;  // already the pending target
      } else {
        if (s->latest >= 0) ++s->stats.superseded;
        s->latest = frame;
        s->generation.fetch_add(1);
      }
    } else {
      if (std::find(s->exact.begin(), s->exact.end(), frame) == s->exact.end()) s->exact.push_back(frame);
    }
    // Same section as the enqueue: see the pool invariant above.
    needOpen = !s->live || s->closing;
  }
  if (needOpen) {
    ensure_open(s);
  } else if (live_.load() > maxOpen_) {
    // Over the soft cap (every source was busy when one more opened): trim now.
    const std::scoped_lock pool(poolMu_);
    make_room(nullptr, maxOpen_);
  }
  if (changed) s->wake.notify_one();
  return nullptr;
}

FramePtr MediaSystem::wait(SourceId id, std::int64_t frame, Lane lane, std::chrono::milliseconds timeout) {
  const auto s = find(id);
  if (!s) return nullptr;
  {
    const std::scoped_lock lock(s->mu);
    if (s->index) frame = s->index->clamp(frame);
  }
  if (FramePtr hit = request(id, frame, lane)) return hit;
  const auto deadline = Clock::now() + timeout;
  std::unique_lock lock(doneMu_);
  FramePtr out;
  done_.wait_until(lock, deadline, [&] {
    if (cache_.contains(id, frame)) return true;
    const std::scoped_lock sl(s->mu);
    return s->failed || s->removed;  // (an eviction's `closing` is not the end: request() re-opened it)
  });
  lock.unlock();
  return cache_.get(id, frame);
}

void MediaSystem::playhead(SourceId id, std::int64_t frame, int direction) {
  const auto s = find(id);
  if (!s) return;
  {
    const std::scoped_lock lock(s->mu);
    s->playhead = frame;
    s->direction = direction > 0 ? 1 : (direction < 0 ? -1 : 0);
  }
  s->wake.notify_one();
}

double MediaSystem::slowest_ms_per_frame() const {
  std::vector<std::shared_ptr<Source>> all;
  {
    const std::scoped_lock lock(mu_);
    all.reserve(sources_.size());
    for (const auto& [id, s] : sources_) all.push_back(s);
  }
  double ms = 0;
  for (const auto& s : all) {
    const std::scoped_lock lock(s->mu);
    ms = std::max(ms, s->stats.msPerFrame);
  }
  return ms;
}

SourceStats MediaSystem::stats(SourceId id) const {
  const auto s = find(id);
  if (!s) return {};
  const std::scoped_lock lock(s->mu);
  return s->stats;
}

void MediaSystem::note_fallback(Source& s, const std::string& why) {
  // Under s.mu. Once per source: the clip stays in software from here.
  s.stats.hwFallback = why;
  PREMATION_LOG(warn, "media_hw_fallback").kv("source", s.id).kv("path", s.path).kv("reason", why);
}

void MediaSystem::signal() {
  // Take the waiters' mutex so a waiter between its predicate check and its
  // sleep cannot miss this notification.
  { const std::scoped_lock lock(doneMu_); }
  done_.notify_all();
}

// ── the worker ──────────────────────────────────────────────────────────────

void MediaSystem::run(Source& s) {
  DecoderOptions opt;
  opt.hw = config_.hw;
  bool reopen = false;
  {
    const std::scoped_lock lock(s.mu);
    reopen = s.opens > 1;
    opt.threads = s.threads;  // the pool's share (ensure_open)
    // A clip that already left the hardware decoder stays in software.
    if (!s.stats.hwFallback.empty()) opt.hw = HwPolicy::softwareOnly;
  }
  const bool highBit = s.info.video && s.info.video->bitDepth > 8;
  opt.hwContext = highBit && config_.hwContextHighBit ? config_.hwContextHighBit : config_.hwContext;
  opt.keepOnGpu = config_.keepOnGpu;
  opt.keepHighBitOnGpu = config_.keepHighBitOnGpu;
  opt.failHwAtFrame = config_.failHwAtFrame;
  opt.scanIndex = false;  // scanned in the background below
  std::string error;
  std::unique_ptr<VideoDecoder> dec = VideoDecoder::open(s.path, opt, error);
  std::string openFallback;
  if (!dec && opt.hw == HwPolicy::automatic && opt.hwContext) {
    // A hardware open failure is never fatal in automatic mode.
    openFallback = std::string(to_string(hw_path(*opt.hwContext))) + ": open: " + error;
    opt.hw = HwPolicy::softwareOnly;
    dec = VideoDecoder::open(s.path, opt, error);
  }
  {
    const std::scoped_lock lock(s.mu);
    if (!dec) {
      s.failed = true;
      s.stats.error = error;
    } else {
      s.ready = true;
      s.stats.ready = true;
      s.stats.open = true;
      s.stats.threads = opt.threads;
      s.stats.path = dec->path();
      if (!openFallback.empty() && s.stats.hwFallback.empty()) note_fallback(s, openFallback);
      if (!reopen) {
        // The decoder's index can be exact where the probe's was constant-rate
        // (a scanned long-GOP stream). Frame numbers only move for VFR content;
        // drop anything cached under the old numbering then.
        const auto& fresh = dec->index();
        const bool moved = !s.index || s.index->size() != fresh.size() ||
                           (fresh.size() > 0 && s.index->time_us(fresh.size() - 1) != fresh.time_us(fresh.size() - 1));
        s.index = std::make_shared<const FrameIndex>(fresh);
        s.info = dec->info();
        if (moved) cache_.drop_source(s.id);
      } else if (s.index->exact() && !dec->index().exact()) {
        // Re-open after an eviction: the source keeps its info and its index —
        // incl. a finished background scan, so the stream is not scanned again.
        dec->set_index(FrameIndex(*s.index));
      }
    }
  }
  signal();
  if (!dec) return;
  if (!reopen && config_.scanIndex && !dec->index().exact() && dec->info().video) {
    const std::string path = s.path;
    const int stream = dec->info().video->streamIndex;
    // NOLINTNEXTLINE(bugprone-exception-escape): the body is one try/catch(...); the analysis still counts the closure's destructor
    s.scanner = premation::JoiningThread([this, &s, path, stream] {
      try {
        const auto t0 = Clock::now();
        FrameIndex fi;
        std::string err;
        if (!scan_index(path, stream, fi, err, &s.stopScan)) return;
        bool toWorker = false;
        {
          const std::scoped_lock lock(s.mu);
          s.stats.indexScanMs = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
          // A running worker swaps it in between decodes (its decoder needs it
          // too); a source closed for the cap takes it now (re-open passes it on).
          toWorker = s.live && !s.closing;
          if (toWorker) s.scanned = std::move(fi);
          else if (!s.removed) adopt_index(s, std::move(fi));
        }
        if (toWorker) s.wake.notify_all();
      } catch (...) {  // NOLINT(bugprone-empty-catch): out of memory scanning — the source keeps its constant-rate index
      }
    });
  }

  for (;;) {
    std::int64_t target = -1;
    Lane lane = Lane::latest;
    bool readahead = false;
    {
      std::unique_lock lock(s.mu);
      s.wake.wait(lock, [&] {
        if (s.closing || s.scanned) return true;
        if (s.latest >= 0 || !s.exact.empty()) return true;
        return s.direction != 0 && s.playhead >= 0;
      });
      if (s.scanned) {
        FrameIndex fresh = std::move(*s.scanned);
        s.scanned.reset();
        adopt_index(s, std::move(fresh));
        if (!s.closing) dec->set_index(FrameIndex(*s.index));
      }
      if (s.closing) return;  // the decoder is destroyed here, on its own thread
      const FrameIndex& idx = *s.index;
      if (s.latest >= 0) {
        target = s.latest;
        s.latest = -1;
        lane = Lane::latest;
        if (cache_.contains(s.id, target)) continue;
        s.busy = true;
      } else if (!s.exact.empty()) {
        target = s.exact.front();
        s.exact.pop_front();
        lane = Lane::exact;
        if (cache_.contains(s.id, target)) continue;
        s.busy = true;
      } else {
        // Readahead: the first missing frame within the window. The window is
        // capped by half of what the cache holds of frames this size.
        int window = std::max(1, config_.readahead);
        if (const FramePtr any = cache_.nearest(s.id, s.playhead); any) {
          const std::size_t bytes = std::max<std::size_t>(1, any->cpuBytes + any->gpuBytes);
          const std::size_t budget = any->gpuBytes > 0 ? config_.gpuCacheBytes : config_.cpuCacheBytes;
          window = std::clamp(static_cast<int>(budget / bytes / 2), 1, window);
        }
        for (int k = 1; k <= window; ++k) {
          const std::int64_t f = s.playhead + static_cast<std::int64_t>(k) * s.direction;
          if (f < 0 || f >= idx.size()) break;
          if (!cache_.contains(s.id, f)) {
            target = f;
            break;
          }
        }
        if (target < 0) {
          // Window full: sleep until a new hint or request arrives.
          const std::int64_t ph = s.playhead;
          const int dir = s.direction;
          s.wake.wait(lock, [&] { return s.closing || s.latest >= 0 || !s.exact.empty() || s.playhead != ph || s.direction != dir; });
          continue;
        }
        readahead = true;
        lane = Lane::latest;
      }
    }
    (void)decode_to(s, *dec, target, lane, readahead);
    const std::scoped_lock lock(s.mu);
    s.busy = false;
  }
}

bool MediaSystem::decode_to(Source& s, VideoDecoder& dec, std::int64_t target, Lane lane, bool readahead) {
  std::shared_ptr<const FrameIndex> idxRef;
  {
    const std::scoped_lock lock(s.mu);
    idxRef = s.index;
  }
  const FrameIndex& idx = *idxRef;
  std::string error;
  // Continue the running decode when the target is ahead in the same GOP (or
  // simply next in a sequential walk); otherwise seek to its keyframe. An
  // intra-only stream (ProRes, DNxHR) seeks unless the target IS the next
  // frame: a seek there is an index lookup, while decoding through a skipped
  // frame costs a whole frame — so a scrub decodes exactly one frame.
  const std::int64_t pos = dec.position();
  const bool intra = dec.info().video && dec.info().video->intraOnly;
  const bool reachable = pos >= 0 && pos <= target &&
                         (intra ? pos == target : (idx.gop_of(pos) == idx.gop_of(target) || target - pos <= 2));
  if (!reachable) {
    if (!dec.seek(target, error)) {
      const std::scoped_lock lock(s.mu);
      s.stats.error = error;
      return true;
    }
    const std::scoped_lock lock(s.mu);
    ++s.stats.seeks;
  }
  std::uint64_t gen = s.generation.load();
  const bool cancellable = lane == Lane::latest;
  for (;;) {
    FramePtr f;
    const auto t0 = Clock::now();
    const DecodeStatus st = dec.next(f, error, cancellable ? &s.generation : nullptr, gen);
    const double ms = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
    if (st == DecodeStatus::frame) {
      const std::int64_t got = f->index;
      const DecodePath via = f->path;
      {
        // Before the frame is cached: a waiter that sees it may at once open
        // another source, and this one must already count as idle for the pool.
        const std::scoped_lock lock(s.mu);
        if (got >= target) s.busy = false;
        s.stats.path = via;  // a hardware decoder may hand a stream back to software (refused, or failed mid-stream)
        if (s.stats.hwFallback.empty() && !dec.hw_fallback().empty()) note_fallback(s, dec.hw_fallback());
        ++s.stats.framesDecoded;
        s.stats.msPerFrame = s.stats.msPerFrame == 0 ? ms : s.stats.msPerFrame * 0.8 + ms * 0.2;
        // Metadata the first frames revealed (HDR10 SEI).
        if (s.info.video && dec.info().video && (s.info.video->color.mastering.has_value() != dec.info().video->color.mastering.has_value() ||
                                                 s.info.video->color.contentLight.has_value() != dec.info().video->color.contentLight.has_value())) {
          s.info.video->color = dec.info().video->color;
        }
        if (got >= target) s.lastDelivery = Clock::now();
      }
      cache_.put(s.id, got, std::move(f));
      signal();
      if (got >= target) return true;  // (got > target: the target frame is missing from the stream)
      continue;
    }
    if (st == DecodeStatus::eof || st == DecodeStatus::error) {
      {
        const std::scoped_lock lock(s.mu);
        if (st == DecodeStatus::error) s.stats.error = error;
        s.busy = false;
      }
      // Cache holds whatever was decoded; a missing target resolves to nothing
      // (callers fall back to nearest()). Force a seek next time.
      std::string ignored;
      (void)dec.seek(target, ignored);
      signal();
      return true;
    }
    // cancelled: a newer request arrived. Decide keep / retarget / abandon.
    std::unique_lock lock(s.mu);
    gen = s.generation.load();
    if (s.closing) return false;
    if (lane == Lane::latest && s.latest >= 0) {
      const std::int64_t next = s.latest;
      const std::int64_t at = std::max<std::int64_t>(dec.position(), 0);
      if (readahead) {
        // A scrub request always beats readahead.
        ++s.stats.abandoned;
        return false;
      }
      if (next >= at && idx.gop_of(next) == idx.gop_of(target)) {
        // Further along the same GOP: absorb it.
        s.latest = -1;
        target = next;
        ++s.stats.retargets;
        continue;
      }
      const double remainingMs = static_cast<double>(std::max<std::int64_t>(1, target - at + 1)) * s.stats.msPerFrame;
      const double starvedMs = std::chrono::duration<double, std::milli>(Clock::now() - s.lastDelivery).count();
      if (remainingMs <= config_.keepInFlightMs || starvedMs >= config_.starvationMs) {
        ++s.stats.kept;
        // Finish this one (uncancellable from here), then the worker takes `latest`.
        lock.unlock();
        for (;;) {
          FramePtr g;
          const DecodeStatus st2 = dec.next(g, error);
          if (st2 != DecodeStatus::frame) break;
          const std::int64_t got = g->index;
          cache_.put(s.id, got, std::move(g));
          {
            const std::scoped_lock l2(s.mu);
            ++s.stats.framesDecoded;
            if (got >= target) s.lastDelivery = Clock::now();
          }
          signal();
          if (got >= target) break;
        }
        return true;
      }
      ++s.stats.abandoned;
      return false;
    }
    // Not a latest request (an exact one, a playhead move): keep going.
  }
}

}  // namespace premation::media
