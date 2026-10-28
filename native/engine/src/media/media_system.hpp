// MediaSystem — footage decode for the engine (plan §5 E1).
//
//   open(path)      probe on the caller's thread (container, codec, rate, colour,
//                   alpha, the frame index when the container has one). No
//                   decoder yet: the first request / wait / wait_ready starts the
//                   source's worker thread, which opens the decoder (hardware
//                   when the platform decoder takes the stream, else software).
//   request(i)      non-blocking: the frame if cached, else the worker is told.
//   wait(i)         blocking (export, tests, the bench).
//   playhead(i, d)  playback hint: the worker reads ahead in direction d.
//
// One worker thread per OPEN source (libavcodec's own slice/frame threads under
// it), one shared FrameCache (LRU by bytes, CPU and GPU budgets).
//
// Decoder pool. A 150-clip timeline must not hold 150 decoders and their
// threads: at most maxOpenDecoders sources are open at once. Opening past the
// cap closes the least recently requested source that has nothing in flight
// (no pending latest / exact request, no request being decoded). Closing an
// idle source releases its decoder and worker thread only: its SourceId, probe
// info, frame index (incl. a finished background scan) and cached frames stay,
// and its next request re-opens it transparently (a stand-in / settle redraw
// covers that first frame, as for any cache miss). The cap is soft: when every
// open source has a request in flight, one more opens and the pool is trimmed
// on a later request. libavcodec threads are shared out the same way:
// clamp(cores / open sources, 1, maxThreadsPerDecoder) per source at (re)open.
//
// Latest-wins (the scrub lane). The TS pipeline's known scrub problem was
// uncancelled serial GOP decodes: every scrub position queued a full GOP decode
// behind the last. Here a `latest` request REPLACES the pending one and bumps a
// generation the worker checks between packets. The in-flight decode then:
//   * RETARGETS when the new frame is further along the same GOP (no restart);
//   * FINISHES when its estimated remaining work is under keepInFlightMs, or
//     when nothing has been delivered for starvationMs (so continuous fast
//     scrubbing still shows frames — exactVideoSource.ts's two rules);
//   * otherwise is ABANDONED and the worker seeks straight to the newest target.
// `exact` requests (export, analysis) are never superseded.
// The clock reads here schedule work; they never decide a pixel (a frame is
// the same frame whichever order it was decoded in).
#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <unordered_map>

#include "decoder.hpp"
#include "frame_cache.hpp"
#include "frame_index.hpp"
#include "media_types.hpp"

namespace premation::media {

using SourceId = std::uint32_t;

enum class Lane : std::uint8_t {
  latest,  // viewport / scrub: a newer request supersedes this one
  exact,   // export / analysis: always decoded, in order
};

struct MediaConfig {
  std::size_t cpuCacheBytes = std::size_t{2} << 30U;  // 2 GiB of decoded CPU frames
  std::size_t gpuCacheBytes = std::size_t{1} << 30U;  // 1 GiB of GPU-resident hardware frames
  HwPolicy hw = HwPolicy::automatic;
  std::shared_ptr<HwContext> hwContext;  // null → software decode
  /// When set, streams deeper than 8 bits decode here instead (media_config_for:
  /// nvdec on NVIDIA when Dawn can't import P010, so d3d11va would download anyway).
  std::shared_ptr<HwContext> hwContextHighBit;
  bool keepOnGpu = true;
  bool keepHighBitOnGpu = false;  // see DecoderOptions
  /// libavcodec threads per decoder; 0 = the shared budget (see the top of this file).
  int decodeThreads = 0;
  /// Decoder pool: sources holding an open decoder + worker thread at once
  /// (0 = max(4, hardware threads)). LRU by last request; see the top of this file.
  int maxOpenDecoders = 0;
  /// With decodeThreads == 0: at most this many libavcodec threads per decoder.
  int maxThreadsPerDecoder = 4;
  /// Frames decoded ahead of the playhead during playback (capped by half the
  /// cache's capacity in frames of this source, as streamPlanFor does).
  int readahead = 12;
  double keepInFlightMs = 120;
  double starvationMs = 400;
  /// Tests: DecoderOptions::failHwAtFrame for every source (-1 = off).
  int failHwAtFrame = -1;
  /// Build the exact presentation index for long-GOP streams whose container
  /// can't give it, with a demux-only scan on a background thread (the source
  /// is usable at once on a constant-rate index; the exact one replaces it).
  bool scanIndex = true;
};

struct SourceStats {
  DecodePath path = DecodePath::software;
  bool ready = false;
  std::string error;
  std::uint64_t framesDecoded = 0;
  std::uint64_t seeks = 0;
  std::uint64_t retargets = 0;   // latest request absorbed into the running GOP decode
  std::uint64_t abandoned = 0;   // in-flight decode dropped for a newer target
  std::uint64_t kept = 0;        // in-flight decode finished despite a newer target (keep/starvation rule)
  std::uint64_t superseded = 0;  // latest requests replaced before they started
  double msPerFrame = 0;         // EMA of decode time per frame
  double indexScanMs = -1;       // background index scan time (-1: none ran / not finished)
  /// Why this source left the hardware decoder ("" = it didn't): the open failed,
  /// the decoder refused the stream, or it failed mid-stream. Also logged (media_hw_fallback).
  std::string hwFallback;
  /// Decoder pool: whether a decoder + worker are open now, how often this
  /// source was closed for the cap and opened again, and the libavcodec
  /// threads its current (or last) decoder was given (0: never opened).
  bool open = false;
  std::uint64_t evictions = 0;
  std::uint64_t reopens = 0;
  int threads = 0;
};

class MediaSystem {
 public:
  explicit MediaSystem(MediaConfig config);
  ~MediaSystem();
  MediaSystem(const MediaSystem&) = delete;
  MediaSystem& operator=(const MediaSystem&) = delete;
  MediaSystem(MediaSystem&&) = delete;
  MediaSystem& operator=(MediaSystem&&) = delete;

  [[nodiscard]] std::optional<SourceId> open(const std::string& path, std::string& error);
  void close(SourceId id);

  [[nodiscard]] bool info(SourceId id, MediaInfo& out) const;
  // shared_ptr: the index is swapped when the worker's exact scan finishes, while
  // render/scene threads may still be mapping times with the old one.
  [[nodiscard]] std::shared_ptr<const FrameIndex> index(SourceId id) const;
  /// Block until the worker has opened the decoder (or failed). False on failure.
  bool wait_ready(SourceId id, std::chrono::milliseconds timeout);

  [[nodiscard]] FramePtr cached(SourceId id, std::int64_t frame);
  [[nodiscard]] FramePtr nearest(SourceId id, std::int64_t frame) const;
  /// Whether `frame` (clamped to the source, as requests are) is decoded — or
  /// never will be (the source failed or is gone): a paused viewport drawn
  /// from a stand-in redraws once this holds (render_thread retry).
  [[nodiscard]] bool settled(SourceId id, std::int64_t frame);
  /// The frame if cached; else schedules it (latest lane: replaces the previous latest request).
  FramePtr request(SourceId id, std::int64_t frame, Lane lane = Lane::latest);
  /// Request and block until it is decoded, fails, or `timeout` passes (then nullptr).
  FramePtr wait(SourceId id, std::int64_t frame, Lane lane, std::chrono::milliseconds timeout);
  /// Playback hint: read ahead from `frame` in `direction` (+1, −1; 0 stops).
  void playhead(SourceId id, std::int64_t frame, int direction);

  [[nodiscard]] SourceStats stats(SourceId id) const;
  /// The slowest open source's decode time per frame (its EMA), ms — what the
  /// render stats report as `decodeMs` (0: nothing decoded yet).
  [[nodiscard]] double slowest_ms_per_frame() const;
  [[nodiscard]] CacheStats cache_stats() const { return cache_.stats(); }
  [[nodiscard]] FrameCache& cache() noexcept { return cache_; }
  [[nodiscard]] const MediaConfig& config() const noexcept { return config_; }
  /// Decoder pool: the cap in force, the decoders open now, and the most ever open at once.
  [[nodiscard]] std::size_t max_open_decoders() const noexcept { return maxOpen_; }
  [[nodiscard]] std::size_t open_decoders() const noexcept { return live_.load(); }
  [[nodiscard]] std::size_t peak_open_decoders() const;

 /// One source's state (defined in media_system.cpp; opaque here).
  struct Source;

 private:
  void run(Source& s);
  /// Start `s`'s worker if it is not running (evicting an idle source at the cap).
  void ensure_open(const std::shared_ptr<Source>& s);
  /// Close idle sources (LRU first, never `keep`) until at most `limit` are open. Under poolMu_.
  void make_room(const Source* keep, std::size_t limit);
  /// Close one source's decoder + worker if it is idle (or its worker died). Under poolMu_.
  bool evict(Source& s);
  /// Install a finished background index scan. Under s.mu.
  void adopt_index(Source& s, FrameIndex fresh);
  /// Decode until `target` is cached. Returns false when abandoned for a newer latest target.
  bool decode_to(Source& s, VideoDecoder& dec, std::int64_t target, Lane lane, bool readahead);
  static void note_fallback(Source& s, const std::string& why);
  [[nodiscard]] std::shared_ptr<Source> find(SourceId id) const;
  void signal();
  void shutdown();

  MediaConfig config_;
  FrameCache cache_;
  mutable std::mutex mu_;
  // shared_ptr: a Source is reached by the API (any thread), which may still
  // hold it after close() dropped the map's reference. Its worker and scanner
  // threads are always joined before that (close / shutdown / eviction).
  std::unordered_map<SourceId, std::shared_ptr<Source>> sources_;
  SourceId next_ = 1;
  // Decoder pool. poolMu_ serialises starting and stopping workers (open-on-
  // request, eviction, close, shutdown); it is taken before mu_ / a source's mu,
  // never after, and no worker ever takes it — so a worker can be joined while
  // it is held. live_ changes only under poolMu_ (read anywhere).
  mutable std::mutex poolMu_;
  std::size_t maxOpen_ = 4;
  unsigned cores_ = 4;
  std::atomic<std::size_t> live_{0};
  std::size_t peak_ = 0;  // under poolMu_
  /// LRU clock: a counter, not wall-clock (bumped by request / wait / wait_ready).
  std::atomic<std::uint64_t> useTick_{0};
  /// Signalled on every decoded frame / failure (wait()).
  std::mutex doneMu_;
  std::condition_variable done_;
};

}  // namespace premation::media
