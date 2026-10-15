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
//  * Writes go through a writer thread (compress, write a temp file, rename),
//    so the render thread hands over the pixels and carries on. A full queue
//    drops the frame (it is still in VRAM; it is written next time it draws).
//  * Least recently used files go first once the folder is over its size
//    limit. Recency survives restarts: a hit refreshes the file's time, and the
//    scan at start orders the index by it.
//
// Thread-safe: the render thread reads (contains / load) and hands frames over
// (store); the core thread configures and purges.
#pragma once

#include <condition_variable>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <list>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace premation::render {

struct DiskCacheStats {
  /// Bytes the cache's files take on disk (compressed).
  std::uint64_t bytes = 0;
  std::uint64_t budget = 0;
  std::uint64_t entries = 0;
  std::uint64_t hits = 0;
  std::uint64_t misses = 0;
  std::uint64_t writes = 0;
  /// Frames not written: the queue was full, or the write failed.
  std::uint64_t dropped = 0;
  std::uint64_t evictions = 0;
  /// The folder the cache writes ("" = off).
  std::string folder;
  /// Why the cache cannot write ("" = it can).
  std::string error;
};

class DiskCache {
 public:
  /// The subfolder of the chosen folder the frames live in (and the only one purged).
  static constexpr const char* kSubfolder = "premation-frames-v1";
  /// Frames handed over but not yet written, in raw bytes: past this a frame is dropped.
  static constexpr std::uint64_t kMaxQueuedBytes = 512ULL * 1024 * 1024;

  DiskCache();
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
  /// Bytes on disk (stats().bytes without copying the strings).
  [[nodiscard]] std::uint64_t bytes() const;
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

  /// Hand `rgba` (width × height, tightly packed) to the writer thread as
  /// `key`'s frame (reserved or not). False = not taken (off, already there,
  /// or the queue is full); a reservation is released then.
  bool store(std::uint64_t key, std::uint32_t width, std::uint32_t height, std::vector<std::uint8_t> rgba);
  /// Claim `key` for a frame about to be read back from the GPU: true when
  /// the cache wants it (on, not on disk or claimed already, room in the
  /// queue). The frame then counts as on its way (retain_present keeps it), so
  /// it is read back once. Every true is followed by `store` or `release`.
  bool reserve(std::uint64_t key);
  /// Give up a reservation (the read-back failed or was dropped).
  void release(std::uint64_t key);
  /// Whether `reserve` would claim `key` now (no side effect; tests).
  [[nodiscard]] bool wants(std::uint64_t key) const;

  /// Purge Disk Cache: forget every frame and delete the folder's cache files.
  void purge();

  /// Wait until every queued job (scan, writes, deletes) is done. Tests and shutdown.
  void flush();

  [[nodiscard]] DiskCacheStats stats() const;

 private:
  struct Entry {
    std::uint64_t bytes = 0;  // on disk
    std::list<std::uint64_t>::iterator lru;
  };
  enum class JobKind : std::uint8_t { scan, write, touch, remove, purge, trim };
  struct Job {
    JobKind kind = JobKind::write;
    std::uint64_t generation = 0;
    std::uint64_t key = 0;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::vector<std::uint8_t> rgba;
    std::filesystem::path dir;  // scan / purge: the folder; touch / remove: the file
  };
  static Job job_of(JobKind kind, std::uint64_t generation, std::filesystem::path dir = {}) {
    Job j;
    j.kind = kind;
    j.generation = generation;
    j.dir = std::move(dir);
    return j;
  }

  void run();
  void do_scan(const Job& job);
  void do_write(Job& job);
  void do_purge(const std::filesystem::path& dir);
  /// Writer thread: time reading `file` back (read + decode) into readMsPerMp_, if still this generation's.
  void measure_read(const std::filesystem::path& file, std::uint64_t generation);
  /// Under m_: evict least recently used entries until the cache is inside its budget; returns the files to delete.
  std::vector<std::filesystem::path> trim_locked();
  /// Under m_: `key` into the index as the most recently used.
  void insert_locked(std::uint64_t key, std::uint64_t bytes);
  /// Under m_: `key` out of the index (no file deleted).
  void erase_locked(std::uint64_t key);
  [[nodiscard]] std::filesystem::path file_of(const std::filesystem::path& dir, std::uint64_t key) const;

  mutable std::mutex m_;
  std::condition_variable cv_;
  std::condition_variable idle_;
  bool quit_ = false;
  bool busy_ = false;  // the writer is running a job
  std::deque<Job> jobs_;
  std::uint64_t queuedBytes_ = 0;
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
  DiskCacheStats counters_;
  /// read_ms_per_mp (0 = not measured in this folder yet).
  double readMsPerMp_ = 0;
  std::thread thread_;
};

}  // namespace premation::render
