// The disk tier of the preview cache — After Effects' Disk Cache
// (Preferences ▸ Media & Disk Cache): finished viewport frames kept in a folder
// on disk, so a frame the VRAM cache (frame_cache.hpp) evicted, or one drawn in
// an earlier session, comes back as a file read instead of a render.
//
//  * Keyed by the frame's DISK key (BuiltFrameDrawer::disk_key): the VRAM
//    content key salted with what a file outlives — this engine build, the
//    loaded plugins' versions, and the modification stamps of the footage the
//    frame reads. A rebuilt engine, an updated plugin or a replaced file never
//    shows a stale frame; it is a miss, and the old file ages out.
//  * One file per frame, `<folder>/premation-frames-v1/<key>.pfc`: a small
//    header, then the RGBA8 pixels (zstd, frame_codec.hpp). Only files of that
//    shape in that subfolder are ever read, evicted or purged — pointing the
//    cache at a folder with other things in it never touches them.
//  * Writes go through a small pool of writer threads (compress, write a temp
//    file, rename), so the render thread hands over the pixels and carries on;
//    it never waits on a writer. The queue's byte limit is a SOFT target:
//    past it a frame is still taken and the cache is "behind" (the writers
//    catch up; reserve() stops claiming optional read-backs meanwhile). Only
//    past the HARD cap (4× the target) is a frame refused, and the caller is
//    told (StoreResult::refused) so it can keep its RAM copy — a frame evicted
//    from RAM on its way here is in no other tier, and a long fill must not
//    leave holes.
//  * Index updates are serialised under the one mutex. Jobs on the same key
//    (and alias records) run in queue order; a scan or purge is a barrier: it
//    waits for the jobs before it and holds back the ones after it.
//  * Least recently used files go first once the folder is over its size
//    limit. Recency survives restarts: a hit refreshes the file's time, and the
//    scan at start orders the index by it.
//  * Pre-build ALIASES survive restarts too (`aliases-v1.bin`, appended, loaded
//    with the scan): a frame's salted pre-build key → its content and disk
//    keys. A disk key is a hash of the BUILT frame, so without them a new
//    session had to build every frame (60+ ms on a 600-layer comp) just to
//    learn which file it was — the disk tier could never make a heavy comp
//    play after a restart. With them the frame is a file read, unbuilt (After
//    Effects' disk cache across sessions).
//
// Thread-safe: the render thread reads (contains / load) and hands frames over
// (store); the core thread configures and purges.
#pragma once

#include <array>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <list>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "joining_thread.hpp"

namespace premation::render {

struct DiskCacheStats {
  /// Bytes the cache's files take on disk (compressed).
  std::uint64_t bytes = 0;
  std::uint64_t budget = 0;
  std::uint64_t entries = 0;
  std::uint64_t hits = 0;
  std::uint64_t misses = 0;
  std::uint64_t writes = 0;
  /// Frames whose write failed (disk full, permissions). Queue overflow is `refused`.
  std::uint64_t dropped = 0;
  std::uint64_t evictions = 0;
  /// Frames taken while the queue was past its soft target (the writers were behind).
  std::uint64_t behind = 0;
  /// Frames refused at the hard cap (the caller kept them, or lost them).
  std::uint64_t refused = 0;
  /// Raw bytes handed over and not yet written (queued + being written).
  std::uint64_t queuedBytes = 0;
  /// The most `queuedBytes` has been since the cache was made.
  std::uint64_t queueHighWater = 0;
  /// The queue's soft target / hard cap, raw bytes.
  std::uint64_t queueSoftBytes = 0;
  std::uint64_t queueHardBytes = 0;
  /// Writer threads in the pool.
  std::uint32_t writers = 0;
  /// The folder the cache writes ("" = off).
  std::string folder;
  /// Why the cache cannot write ("" = it can).
  std::string error;
};

/// What `DiskCache::enqueue` did with a frame.
enum class StoreResult : std::uint8_t {
  /// Taken; the queue is within its soft target.
  queued,
  /// Taken, but the queue is past its soft target: the writers are behind.
  queuedBehind,
  /// Not taken: the queue is at its hard cap. The caller's bytes are untouched
  /// (keep the frame in RAM if it can; it is in no tier otherwise).
  refused,
  /// Not taken and not needed: the cache is off, the frame is on disk or
  /// queued already, or its size is wrong. The caller's bytes are untouched.
  skipped,
};

struct DiskCacheOptions {
  /// Writer threads; 0 = clamp(hardware_concurrency / 4, 1, 4).
  std::uint32_t writers = 0;
  /// The queue's soft target, raw bytes (0 = kSoftQueuedBytes).
  std::uint64_t softQueueBytes = 0;
  /// The queue's hard cap, raw bytes (0 = 4 × the soft target).
  std::uint64_t hardQueueBytes = 0;
};

class DiskCache {
 public:
  /// The subfolder of the chosen folder the frames live in (and the only one purged).
  static constexpr const char* kSubfolder = "premation-frames-v1";
  /// Frames handed over but not yet written, in raw bytes: past this the cache
  /// is behind (frames are still taken; reserve() stops claiming read-backs).
  static constexpr std::uint64_t kSoftQueuedBytes = 512ULL * 1024 * 1024;
  /// Past this a frame is refused (StoreResult::refused).
  static constexpr std::uint64_t kHardQueuedBytes = 4 * kSoftQueuedBytes;
  /// The limit the read-back path is bounded by (reserve / wants): the soft target.
  static constexpr std::uint64_t kMaxQueuedBytes = kSoftQueuedBytes;
  static constexpr std::uint32_t kMaxWriters = 4;

  DiskCache();
  explicit DiskCache(const DiskCacheOptions& options);
  ~DiskCache();
  DiskCache(const DiskCache&) = delete;
  DiskCache& operator=(const DiskCache&) = delete;
  DiskCache(DiskCache&&) = delete;
  DiskCache& operator=(DiskCache&&) = delete;

  /// Use `folder` (UTF-8) with a size limit of `budgetBytes`. "" or 0 turns
  /// the cache off (its files stay). A new folder is scanned on the writer
  /// thread; until the scan is done its frames read as misses. A smaller limit
  /// evicts down to it.
  void configure(const std::string& folder, std::uint64_t budgetBytes);
  [[nodiscard]] bool enabled() const;

  /// Whether `key` has a file (as far as the index knows).
  [[nodiscard]] bool contains(std::uint64_t key) const;
  /// Keep only the keys that have a file (one lock for the lot).
  void keep_present(std::vector<std::uint64_t>& keys) const;
  /// Over every frame's keys, one lock: drop the keys with no file and none
  /// queued (frames left with no key go), and list in `onDisk` the frames with
  /// a key whose file is written. A key still queued stays, so a frame joins
  /// once its write lands.
  void retain_present(std::unordered_map<std::int64_t, std::vector<std::uint64_t>>& byFrame,
                      std::vector<std::int64_t>& onDisk) const;
  /// Per key, one lock for the lot: 2 = its file is written, 1 = on its way
  /// (queued or reserved for a read-back), 0 = not on disk. `out` is resized.
  void presence(const std::vector<std::uint64_t>& keys, std::vector<std::uint8_t>& out) const;
  /// Bytes on disk (stats().bytes without copying the strings).
  [[nodiscard]] std::uint64_t bytes() const;
  /// The size limit configure() set (0 = off).
  [[nodiscard]] std::uint64_t budget() const;
  /// Frames handed over and not written yet.
  [[nodiscard]] bool writing() const;
  /// What reading a frame back costs here, ms per megapixel (file read +
  /// decode), timed on one of the folder's own files once it is scanned (or
  /// once the first frame is written); 0 = not measured yet.
  [[nodiscard]] double read_ms_per_mp() const;

  /// `key`'s pixels, width × height RGBA8 tightly packed, into `out` (resized).
  /// False on a miss, or a file that is gone, torn or of another size (it is
  /// then forgotten and deleted).
  bool load(std::uint64_t key, std::uint32_t width, std::uint32_t height, std::vector<std::uint8_t>& out);

  /// Hand `rgba` (width × height, tightly packed) to the writers as `key`'s
  /// frame (reserved or not). Never blocks on a writer. `rgba` is moved from
  /// (left empty) only when the frame is taken (queued / queuedBehind); on
  /// refused or skipped it is left as it was, so the caller can keep it. A
  /// reservation of `key` ends here either way. A frame larger than the hard
  /// cap is taken when the queue is empty (it could never be written otherwise).
  StoreResult enqueue(std::uint64_t key, std::uint32_t width, std::uint32_t height, std::vector<std::uint8_t>& rgba);
  /// enqueue() as a bool (true = taken), for callers with no RAM copy to keep.
  bool store(std::uint64_t key, std::uint32_t width, std::uint32_t height, std::vector<std::uint8_t> rgba);
  /// Claim `key` for a frame about to be read back from the GPU: true when
  /// the cache wants it (on, not on disk or claimed already, the queue within
  /// its soft target — an optional read-back waits while the writers are
  /// behind). The frame then counts as on its way (retain_present keeps it), so
  /// it is read back once. Every true is followed by `store` or `release`.
  bool reserve(std::uint64_t key);
  /// Whether the queue is past its soft target (the writers are behind).
  [[nodiscard]] bool behind() const;
  /// Give up a reservation (the read-back failed or was dropped).
  void release(std::uint64_t key);
  /// Whether `reserve` would claim `key` now (no side effect; tests).
  [[nodiscard]] bool wants(std::uint64_t key) const;

  /// Remember that the frame whose salted pre-build key is `alias` is `content`
  /// (its VRAM / RAM key) and `disk` (its file): appended to the folder's alias
  /// log by the writer thread. Only for frames whose pixels the pre-build key
  /// fully decides (no footage files: their stamps are in the disk key alone).
  void store_alias(std::uint64_t alias, std::uint64_t content, std::uint64_t disk);
  /// `alias`'s {content, disk} keys while its file is on disk; nullopt otherwise.
  [[nodiscard]] std::optional<std::pair<std::uint64_t, std::uint64_t>> find_alias(std::uint64_t alias) const;

  /// Purge Disk Cache: forget every frame and delete the folder's cache files.
  void purge();

  /// Wait until every queued job (scan, writes, deletes) is done. Tests and shutdown.
  /// Never call it while paused with jobs queued (it would wait forever).
  void flush();
  /// Tests: while paused the writers start no job (enqueue still queues).
  void pause(bool paused);

  [[nodiscard]] DiskCacheStats stats() const;

 private:
  struct Entry {
    std::uint64_t bytes = 0;  // on disk
    std::list<std::uint64_t>::iterator lru;
  };
  enum class JobKind : std::uint8_t { scan, write, touch, remove, purge, trim, alias };
  struct Job {
    JobKind kind = JobKind::write;
    std::uint64_t generation = 0;
    std::uint64_t key = 0;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::vector<std::uint8_t> rgba;
    std::uint64_t queued = 0;  // write: the raw bytes it counts in queuedBytes_ until it is done
    std::filesystem::path dir;  // scan / purge / alias: the folder; touch / remove: the file
    std::array<std::uint64_t, 3> alias{};  // alias: {alias, content, disk}
  };
  static Job job_of(JobKind kind, std::uint64_t generation, std::filesystem::path dir = {}) {
    Job j;
    j.kind = kind;
    j.generation = generation;
    j.dir = std::move(dir);
    return j;
  }

  /// An evicted frame's file, its key held busy (no job on it starts) until it is deleted.
  struct Victim {
    std::uint64_t key = 0;
    std::filesystem::path file;
  };

  /// Scan and purge: barriers (every job before them done, none after them started).
  static bool exclusive(JobKind kind) { return kind == JobKind::scan || kind == JobKind::purge; }
  /// Jobs serialised per key (job.key; an alias record's key is the alias).
  static bool keyed(JobKind kind) {
    return kind == JobKind::write || kind == JobKind::touch || kind == JobKind::remove || kind == JobKind::alias;
  }

  /// One writer of the pool.
  void run();
  /// Under m_: the first job a writer may start now into `job`; false = none.
  bool take_locked(Job& job);
  /// Under m_: the queue's byte count down by a job leaving it (written, dropped, purged).
  void unqueue_locked(std::uint64_t bytes);
  /// Delete evicted files, then free their keys (takes m_).
  void drop_files(const std::vector<Victim>& victims);
  void do_scan(const Job& job);
  void do_write(Job& job);
  void do_purge(const std::filesystem::path& dir);
  /// Writer thread: one alias record onto the folder's log.
  void do_alias(const Job& job);
  /// Writer thread, from the scan: the folder's alias log into `aliases_`
  /// (the last record of an alias wins), rewritten without the dead ones when
  /// they have come to outnumber the live ones.
  void load_aliases(const std::filesystem::path& dir, std::uint64_t generation);
  /// Writer thread: time reading `file` back (read + decode) into readMsPerMp_, if still this generation's.
  void measure_read(const std::filesystem::path& file, std::uint64_t generation);
  /// Under m_: evict least recently used entries until the cache is inside its
  /// budget; returns the files to delete (their keys held busy until drop_files).
  std::vector<Victim> trim_locked();
  /// Under m_: `key` into the index as the most recently used.
  void insert_locked(std::uint64_t key, std::uint64_t bytes);
  /// Under m_: `key` out of the index (no file deleted).
  void erase_locked(std::uint64_t key);
  [[nodiscard]] std::filesystem::path file_of(const std::filesystem::path& dir, std::uint64_t key) const;

  mutable std::mutex m_;
  std::condition_variable cv_;
  std::condition_variable idle_;
  bool quit_ = false;
  bool paused_ = false;
  /// Jobs running on the pool.
  std::uint32_t active_ = 0;
  /// A scan or purge is running (nothing else starts).
  bool exclusiveRunning_ = false;
  /// Keys a running job (or a pending file delete) works on: another job on the key waits.
  std::unordered_multiset<std::uint64_t> busyKeys_;
  std::deque<Job> jobs_;
  /// Raw bytes of write jobs queued or running.
  std::uint64_t queuedBytes_ = 0;
  std::uint64_t softQueueBytes_ = kSoftQueuedBytes;
  std::uint64_t hardQueueBytes_ = kHardQueuedBytes;
  /// The alias log is appended by one writer at a time.
  std::mutex aliasFile_;
  /// Bumps on every folder change and purge: queued jobs of an older generation are dropped.
  std::uint64_t generation_ = 0;
  std::filesystem::path dir_;  // <folder>/kSubfolder ("" = off)
  std::uint64_t budget_ = 0;
  std::uint64_t bytes_ = 0;
  /// Front = most recently used.
  std::list<std::uint64_t> lru_;
  std::unordered_map<std::uint64_t, Entry> index_;
  /// Keys queued for writing (not yet in the index).
  std::unordered_set<std::uint64_t> pending_;
  /// Keys claimed for a GPU read-back that has not reached `store` yet.
  std::unordered_set<std::uint64_t> reserved_;
  /// store_alias / find_alias: salted pre-build key → {content, disk}. Live
  /// while the disk key's file is in `index_` (an evicted frame's alias is dead weight until the log is compacted).
  std::unordered_map<std::uint64_t, std::pair<std::uint64_t, std::uint64_t>> aliases_;
  DiskCacheStats counters_;
  /// read_ms_per_mp (0 = not measured in this folder yet).
  double readMsPerMp_ = 0;
  /// The pool. Last member: destroyed (joined) first, after ~DiskCache set quit_.
  std::vector<JoiningThread> writers_;
};

}  // namespace premation::render
