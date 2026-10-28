#include "disk_cache.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <chrono>
#include <cstring>
#include <fstream>
#include <optional>
#include <span>
#include <string_view>
#include <utility>

#include "frame_codec.hpp"
#include "log.hpp"

namespace premation::render {
namespace fs = std::filesystem;

namespace {

static_assert(std::endian::native == std::endian::little, "the cache file header is written as in memory");

constexpr std::uint32_t kMagic = 0x31434650U;  // "PFC1"
constexpr std::uint32_t kFileVersion = 1;

/// A cached frame's file: this header, then `payload` bytes of pixels.
struct FileHeader {
  std::uint32_t magic = kMagic;
  std::uint32_t version = kFileVersion;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::uint32_t codec = 0;
  std::uint32_t reserved = 0;
  std::uint64_t key = 0;
  std::uint64_t payload = 0;
};
static_assert(sizeof(FileHeader) == 40);

constexpr std::string_view kExt = ".pfc";
constexpr std::string_view kTmpExt = ".tmp";
/// The alias log: 24-byte records {alias, content, disk}, little-endian, appended.
constexpr std::string_view kAliasFile = "aliases-v1.bin";
constexpr std::size_t kAliasRecord = 3 * sizeof(std::uint64_t);

fs::path utf8_path(const std::string& s) { return {std::u8string(s.begin(), s.end())}; }

std::string hex16(std::uint64_t v) {
  constexpr std::string_view kDigits = "0123456789abcdef";
  std::string out(16, '0');
  for (std::size_t i = 0; i < 16; ++i) out[15 - i] = kDigits[(v >> (4U * i)) & 0xFU];
  return out;
}

std::optional<std::uint64_t> parse_hex16(std::string_view s) {
  if (s.size() != 16) return std::nullopt;
  std::uint64_t v = 0;
  for (const char c : s) {
    std::uint64_t d = 0;
    if (c >= '0' && c <= '9') {
      d = static_cast<std::uint64_t>(c) - std::uint64_t{'0'};
    } else if (c >= 'a' && c <= 'f') {
      d = static_cast<std::uint64_t>(c) - std::uint64_t{'a'} + 10U;
    } else {
      return std::nullopt;
    }
    v = (v << 4U) | d;
  }
  return v;
}

std::string ext_of(const fs::path& p) {
  const std::u8string e = p.extension().u8string();
  return {e.begin(), e.end()};
}

/// The whole file into `out` (resized). False when it cannot be read.
bool read_file(const fs::path& p, std::vector<std::uint8_t>& out) {
  std::error_code ec;
  const std::uintmax_t size = fs::file_size(p, ec);
  if (ec || size < sizeof(FileHeader)) return false;
  std::ifstream f(p, std::ios::binary);
  if (!f) return false;
  out.resize(static_cast<std::size_t>(size));
  f.read(reinterpret_cast<char*>(out.data()), static_cast<std::streamsize>(size));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): bytes in
  return std::cmp_equal(f.gcount(), size);
}

}  // namespace

DiskCache::DiskCache() : DiskCache(DiskCacheOptions{}) {}

DiskCache::DiskCache(const DiskCacheOptions& options)
    : softQueueBytes_(options.softQueueBytes != 0 ? options.softQueueBytes : kSoftQueuedBytes),
      // Declared after softQueueBytes_, so it is set by now.
      hardQueueBytes_(options.hardQueueBytes != 0 ? std::max(options.hardQueueBytes, softQueueBytes_) : 4 * softQueueBytes_) {
  // A quarter of the cores: compression is the writers' work, and the render
  // thread, the decoders and the effect pool need the rest.
  const std::uint32_t n = options.writers != 0 ? std::min(options.writers, kMaxWriters)
                                               : std::clamp<std::uint32_t>(std::thread::hardware_concurrency() / 4U, 1U, kMaxWriters);
  counters_.queueSoftBytes = softQueueBytes_;
  counters_.queueHardBytes = hardQueueBytes_;
  counters_.writers = n;
  writers_.reserve(n);
  for (std::uint32_t i = 0; i < n; ++i) writers_.emplace_back([this] { run(); });
}

DiskCache::~DiskCache() {
  {
    const std::lock_guard<std::mutex> lock(m_);
    quit_ = true;
  }
  cv_.notify_all();
  writers_.clear();  // joins
}

fs::path DiskCache::file_of(const fs::path& dir, std::uint64_t key) const {
  return dir / utf8_path(hex16(key) + std::string(kExt));
}

void DiskCache::configure(const std::string& folder, std::uint64_t budgetBytes) {
  const fs::path dir = (folder.empty() || budgetBytes == 0) ? fs::path{} : utf8_path(folder) / kSubfolder;
  {
    const std::lock_guard<std::mutex> lock(m_);
    budget_ = budgetBytes;
    counters_.budget = dir.empty() ? 0 : budgetBytes;
    if (dir != dir_) {
      // Another folder (or off): forget this one's index; its files stay.
      ++generation_;
      dir_ = dir;
      counters_.folder = dir.empty() ? std::string{} : folder;
      counters_.error.clear();
      index_.clear();
      lru_.clear();
      pending_.clear();
      reserved_.clear();
      aliases_.clear();
      bytes_ = 0;
      readMsPerMp_ = 0;
      std::erase_if(jobs_, [this](const Job& j) {
        if (j.kind == JobKind::write) unqueue_locked(j.queued);
        return j.kind == JobKind::write || j.kind == JobKind::touch || j.kind == JobKind::trim;
      });
      if (!dir_.empty()) jobs_.push_back(job_of(JobKind::scan, generation_, dir_));
    } else if (!dir_.empty()) {
      jobs_.push_back(job_of(JobKind::trim, generation_));
    }
  }
  cv_.notify_all();
}

bool DiskCache::enabled() const {
  const std::lock_guard<std::mutex> lock(m_);
  return !dir_.empty() && counters_.error.empty();
}

bool DiskCache::contains(std::uint64_t key) const {
  const std::lock_guard<std::mutex> lock(m_);
  return !dir_.empty() && index_.contains(key);
}

void DiskCache::keep_present(std::vector<std::uint64_t>& keys) const {
  const std::lock_guard<std::mutex> lock(m_);
  if (dir_.empty()) {
    keys.clear();
    return;
  }
  std::erase_if(keys, [this](std::uint64_t k) { return !index_.contains(k); });
}

void DiskCache::retain_present(std::unordered_map<std::int64_t, std::vector<std::uint64_t>>& byFrame,
                               std::vector<std::int64_t>& onDisk) const {
  const std::lock_guard<std::mutex> lock(m_);
  for (auto it = byFrame.begin(); it != byFrame.end();) {
    auto& keys = it->second;
    if (dir_.empty()) {
      keys.clear();
    } else {
      std::erase_if(keys, [this](std::uint64_t k) { return !index_.contains(k) && !pending_.contains(k) && !reserved_.contains(k); });
    }
    if (keys.empty()) {
      it = byFrame.erase(it);
      continue;
    }
    if (std::ranges::any_of(keys, [this](std::uint64_t k) { return index_.contains(k); })) {
      onDisk.push_back(it->first);
    }
    ++it;
  }
}

void DiskCache::presence(const std::vector<std::uint64_t>& keys, std::vector<std::uint8_t>& out) const {
  out.assign(keys.size(), 0);
  const std::lock_guard<std::mutex> lock(m_);
  if (dir_.empty()) return;
  for (std::size_t i = 0; i < keys.size(); ++i) {
    const std::uint64_t k = keys[i];
    if (index_.contains(k)) {
      out[i] = 2;
    } else if (pending_.contains(k) || reserved_.contains(k)) {
      out[i] = 1;
    }
  }
}

std::uint64_t DiskCache::bytes() const {
  const std::lock_guard<std::mutex> lock(m_);
  return bytes_;
}

std::uint64_t DiskCache::budget() const {
  const std::lock_guard<std::mutex> lock(m_);
  return budget_;
}

bool DiskCache::writing() const {
  const std::lock_guard<std::mutex> lock(m_);
  return !pending_.empty() || !reserved_.empty();
}

double DiskCache::read_ms_per_mp() const {
  const std::lock_guard<std::mutex> lock(m_);
  return readMsPerMp_;
}

bool DiskCache::wants(std::uint64_t key) const {
  const std::lock_guard<std::mutex> lock(m_);
  return !dir_.empty() && counters_.error.empty() && !index_.contains(key) && !pending_.contains(key) &&
         !reserved_.contains(key) && queuedBytes_ < softQueueBytes_;
}

bool DiskCache::behind() const {
  const std::lock_guard<std::mutex> lock(m_);
  return queuedBytes_ > softQueueBytes_;
}

bool DiskCache::load(std::uint64_t key, std::uint32_t width, std::uint32_t height, std::vector<std::uint8_t>& out) {
  fs::path p;
  std::uint64_t generation = 0;
  {
    const std::lock_guard<std::mutex> lock(m_);
    const auto it = dir_.empty() ? index_.end() : index_.find(key);
    if (it == index_.end()) {
      ++counters_.misses;
      return false;
    }
    lru_.splice(lru_.begin(), lru_, it->second.lru);
    p = file_of(dir_, key);
    generation = generation_;
  }
  // Read outside the lock: the writer keeps writing meanwhile. One buffer per
  // thread, reused: a 4K frame's file is tens of megabytes, and allocating it
  // per hit would be on the render thread's hot path.
  thread_local std::vector<std::uint8_t> file;
  bool ok = read_file(p, file);
  FileHeader h;
  if (ok) {
    std::memcpy(&h, file.data(), sizeof h);
    const std::uint64_t raw = std::uint64_t{width} * height * 4U;
    ok = h.magic == kMagic && h.version == kFileVersion && h.key == key && h.width == width && h.height == height &&
         h.payload == file.size() - sizeof h;
    if (ok) {
      out.resize(static_cast<std::size_t>(raw));
      ok = frame_codec::decompress(static_cast<frame_codec::Codec>(h.codec),
                                   std::span<const std::uint8_t>(file).subspan(sizeof h), out);
    }
  }
  {
    const std::lock_guard<std::mutex> lock(m_);
    if (!ok) {
      ++counters_.misses;
      // Gone, torn or another shape: forget it, and delete what is there.
      if (generation == generation_ && index_.contains(key)) {
        erase_locked(key);
        jobs_.push_back(job_of(JobKind::remove, generation, p));
        jobs_.back().key = key;  // runs before a later write of the key, never alongside it
      }
    } else {
      ++counters_.hits;
      // Recency outlives the session: the file's time is what the next scan orders by.
      jobs_.push_back(job_of(JobKind::touch, generation, p));
      jobs_.back().key = key;
    }
  }
  cv_.notify_all();
  if (!ok) {
    PREMATION_LOG(warn, "disk_cache_bad_file").kv("key", hex16(key));
  }
  return ok;
}

StoreResult DiskCache::enqueue(std::uint64_t key, std::uint32_t width, std::uint32_t height,
                               std::vector<std::uint8_t>& rgba) {
  StoreResult result = StoreResult::queued;
  {
    const std::lock_guard<std::mutex> lock(m_);
    reserved_.erase(key);  // a reservation ends here, taken or not
    if (rgba.size() != std::size_t{width} * height * 4U || rgba.empty()) return StoreResult::skipped;
    if (dir_.empty() || !counters_.error.empty() || index_.contains(key) || pending_.contains(key)) return StoreResult::skipped;
    const std::uint64_t size = rgba.size();
    // The hard cap: the only refusal. An empty queue takes any frame (one
    // larger than the cap could never be written otherwise).
    if (queuedBytes_ != 0 && queuedBytes_ + size > hardQueueBytes_) {
      ++counters_.refused;
      return StoreResult::refused;
    }
    queuedBytes_ += size;
    counters_.queueHighWater = std::max(counters_.queueHighWater, queuedBytes_);
    if (queuedBytes_ > softQueueBytes_) {
      // Past the soft target: taken all the same; the writers catch up.
      ++counters_.behind;
      result = StoreResult::queuedBehind;
    }
    pending_.insert(key);
    Job job = job_of(JobKind::write, generation_);
    job.key = key;
    job.width = width;
    job.height = height;
    job.queued = size;
    job.rgba = std::move(rgba);
    rgba.clear();  // the contract: taken = left empty (a moved-from vector is only "valid")
    jobs_.push_back(std::move(job));
  }
  cv_.notify_one();
  return result;
}

bool DiskCache::store(std::uint64_t key, std::uint32_t width, std::uint32_t height, std::vector<std::uint8_t> rgba) {
  const StoreResult r = enqueue(key, width, height, rgba);
  return r == StoreResult::queued || r == StoreResult::queuedBehind;
}

bool DiskCache::reserve(std::uint64_t key) {
  const std::lock_guard<std::mutex> lock(m_);
  if (dir_.empty() || !counters_.error.empty() || index_.contains(key) || pending_.contains(key) ||
      reserved_.contains(key) || queuedBytes_ >= softQueueBytes_) {
    return false;
  }
  reserved_.insert(key);
  return true;
}

void DiskCache::release(std::uint64_t key) {
  const std::lock_guard<std::mutex> lock(m_);
  reserved_.erase(key);
}

void DiskCache::purge() {
  {
    const std::lock_guard<std::mutex> lock(m_);
    ++generation_;
    index_.clear();
    lru_.clear();
    pending_.clear();
    reserved_.clear();
    aliases_.clear();
    bytes_ = 0;
    std::erase_if(jobs_, [this](const Job& j) {
      if (j.kind == JobKind::write) unqueue_locked(j.queued);
      return j.kind == JobKind::write || j.kind == JobKind::touch || j.kind == JobKind::trim || j.kind == JobKind::alias;
    });
    if (!dir_.empty()) jobs_.push_back(job_of(JobKind::purge, generation_, dir_));
  }
  cv_.notify_all();
}

void DiskCache::store_alias(std::uint64_t alias, std::uint64_t content, std::uint64_t disk) {
  if (alias == 0 || disk == 0) return;
  {
    const std::lock_guard<std::mutex> lock(m_);
    if (dir_.empty() || !counters_.error.empty()) return;
    const auto it = aliases_.find(alias);
    if (it != aliases_.end() && it->second == std::make_pair(content, disk)) return;  // known: nothing to append
    aliases_[alias] = {content, disk};
    Job job = job_of(JobKind::alias, generation_, dir_);
    job.key = alias;  // records of one alias land in the order they were made
    job.alias = {alias, content, disk};
    jobs_.push_back(std::move(job));
  }
  cv_.notify_all();
}

std::optional<std::pair<std::uint64_t, std::uint64_t>> DiskCache::find_alias(std::uint64_t alias) const {
  const std::lock_guard<std::mutex> lock(m_);
  if (dir_.empty()) return std::nullopt;
  const auto it = aliases_.find(alias);
  if (it == aliases_.end() || !index_.contains(it->second.second)) return std::nullopt;
  return it->second;
}

void DiskCache::flush() {
  std::unique_lock<std::mutex> lock(m_);
  idle_.wait(lock, [this] { return quit_ || (jobs_.empty() && active_ == 0); });
}

void DiskCache::pause(bool paused) {
  {
    const std::lock_guard<std::mutex> lock(m_);
    paused_ = paused;
  }
  cv_.notify_all();
}

DiskCacheStats DiskCache::stats() const {
  const std::lock_guard<std::mutex> lock(m_);
  DiskCacheStats s = counters_;
  s.bytes = bytes_;
  s.entries = index_.size();
  s.queuedBytes = queuedBytes_;
  return s;
}

void DiskCache::unqueue_locked(std::uint64_t bytes) { queuedBytes_ -= std::min(queuedBytes_, bytes); }

void DiskCache::insert_locked(std::uint64_t key, std::uint64_t bytes) {
  erase_locked(key);
  lru_.push_front(key);
  index_.emplace(key, Entry{.bytes = bytes, .lru = lru_.begin()});
  bytes_ += bytes;
}

void DiskCache::erase_locked(std::uint64_t key) {
  const auto it = index_.find(key);
  if (it == index_.end()) return;
  bytes_ -= std::min(bytes_, it->second.bytes);
  lru_.erase(it->second.lru);
  index_.erase(it);
}

std::vector<DiskCache::Victim> DiskCache::trim_locked() {
  std::vector<Victim> victims;
  while (bytes_ > budget_ && !lru_.empty()) {
    const std::uint64_t key = lru_.back();
    victims.push_back(Victim{.key = key, .file = file_of(dir_, key)});
    // Held until its file is deleted: a write of the same key queued meanwhile
    // must not land first and be deleted with it.
    busyKeys_.insert(key);
    erase_locked(key);
    ++counters_.evictions;
  }
  return victims;
}

void DiskCache::drop_files(const std::vector<Victim>& victims) {
  if (victims.empty()) return;
  std::error_code ec;
  for (const Victim& v : victims) fs::remove(v.file, ec);
  {
    const std::lock_guard<std::mutex> lock(m_);
    for (const Victim& v : victims) {
      const auto it = busyKeys_.find(v.key);
      if (it != busyKeys_.end()) busyKeys_.erase(it);
    }
  }
  cv_.notify_all();
}

bool DiskCache::take_locked(Job& job) {
  if (exclusiveRunning_) return false;
  // The earliest job that may start: one whose key no running job holds. A
  // scan or purge starts only at the front with nothing running, and nothing
  // behind it is passed over to it.
  for (auto it = jobs_.begin(); it != jobs_.end(); ++it) {
    if (exclusive(it->kind)) {
      if (it != jobs_.begin() || active_ != 0) return false;
      exclusiveRunning_ = true;
    } else if (keyed(it->kind) && busyKeys_.contains(it->key)) {
      continue;  // a later job of the same key is skipped too: order per key holds
    }
    job = std::move(*it);
    jobs_.erase(it);
    return true;
  }
  return false;
}

void DiskCache::run() {
  std::unique_lock<std::mutex> lock(m_);
  for (;;) {
    Job job;
    // Stopping drops what is queued: those frames are drawn (and written) again next session.
    cv_.wait(lock, [this, &job] { return quit_ || (!paused_ && take_locked(job)); });
    if (quit_) break;
    ++active_;
    const bool held = keyed(job.kind);
    if (held) busyKeys_.insert(job.key);
    lock.unlock();

    std::error_code ec;
    switch (job.kind) {
      case JobKind::scan: do_scan(job); break;
      case JobKind::write: do_write(job); break;
      case JobKind::touch: fs::last_write_time(job.dir, fs::file_time_type::clock::now(), ec); break;
      case JobKind::remove: fs::remove(job.dir, ec); break;
      case JobKind::purge: do_purge(job.dir); break;
      case JobKind::alias: do_alias(job); break;
      case JobKind::trim: {
        std::vector<Victim> victims;
        {
          const std::lock_guard<std::mutex> trimLock(m_);
          if (job.generation == generation_) victims = trim_locked();
        }
        drop_files(victims);
        break;
      }
    }
    // The pixels go before the queue says they have (memory is what the cap bounds).
    job.rgba = {};

    lock.lock();
    --active_;
    if (exclusive(job.kind)) exclusiveRunning_ = false;
    if (held) {
      const auto it = busyKeys_.find(job.key);
      if (it != busyKeys_.end()) busyKeys_.erase(it);
    }
    if (job.kind == JobKind::write) unqueue_locked(job.queued);
    // Other writers may be waiting on this job's key or for a barrier to clear.
    cv_.notify_all();
    idle_.notify_all();
  }
  idle_.notify_all();
}

void DiskCache::do_scan(const Job& job) {
  std::error_code ec;
  fs::create_directories(job.dir, ec);
  if (ec) {
    const std::lock_guard<std::mutex> lock(m_);
    if (job.generation == generation_) counters_.error = "Cannot create the disk cache folder: " + ec.message();
    PREMATION_LOG(warn, "disk_cache_folder_failed").kv("error", ec.message());
    return;
  }
  struct Found {
    std::uint64_t key = 0;
    std::uint64_t bytes = 0;
    fs::file_time_type time{};
  };
  std::vector<Found> found;
  for (fs::directory_iterator it(job.dir, ec), end; !ec && it != end; it.increment(ec)) {
    const fs::path& p = it->path();
    const std::string ext = ext_of(p);
    std::error_code fileEc;
    if (ext == kTmpExt) {
      fs::remove(p, fileEc);  // a write the last session did not finish
      continue;
    }
    if (ext != kExt) continue;
    const std::u8string stem = p.stem().u8string();
    const auto key = parse_hex16(std::string_view(reinterpret_cast<const char*>(stem.data()), stem.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): char8_t → char
    if (!key) continue;
    const std::uintmax_t size = it->file_size(fileEc);
    if (fileEc) continue;
    const fs::file_time_type time = it->last_write_time(fileEc);
    found.push_back(Found{.key = *key, .bytes = static_cast<std::uint64_t>(size), .time = fileEc ? fs::file_time_type{} : time});
  }
  // Oldest first, so the most recently used ends up at the front of the LRU.
  std::ranges::sort(found, {}, &Found::time);
  std::vector<Victim> victims;
  std::uint64_t bytes = 0;
  {
    const std::lock_guard<std::mutex> lock(m_);
    if (job.generation != generation_) return;
    for (const Found& f : found) insert_locked(f.key, f.bytes);
    victims = trim_locked();
    bytes = bytes_;
  }
  drop_files(victims);
  load_aliases(job.dir, job.generation);
  // The read cost the render thread weighs draws against, timed on this
  // folder's most recently used frame (a cold read, as a hit after a restart is).
  if (found.size() > victims.size()) measure_read(file_of(job.dir, found.back().key), job.generation);
  PREMATION_LOG(info, "disk_cache_ready")
      .kv("frames", static_cast<std::int64_t>(found.size() - victims.size()))
      .kv("MB", static_cast<double>(bytes) / (1024.0 * 1024.0));
}

void DiskCache::do_write(Job& job) {
  fs::path dir;
  {
    const std::lock_guard<std::mutex> lock(m_);
    if (job.generation != generation_ || dir_.empty() || index_.contains(job.key)) {
      pending_.erase(job.key);
      return;
    }
    dir = dir_;
  }
  FileHeader h;
  h.width = job.width;
  h.height = job.height;
  h.key = job.key;
  std::vector<std::uint8_t> packed;
  frame_codec::Codec codec = frame_codec::preferred();
  if (codec != frame_codec::Codec::raw && !frame_codec::compress(job.rgba, packed)) codec = frame_codec::Codec::raw;
  // A frame that does not shrink (noise) is kept raw: reading it back is a copy.
  if (codec != frame_codec::Codec::raw && packed.size() >= job.rgba.size()) codec = frame_codec::Codec::raw;
  const std::span<const std::uint8_t> payload = codec == frame_codec::Codec::raw ? std::span<const std::uint8_t>(job.rgba)
                                                                                 : std::span<const std::uint8_t>(packed);
  h.codec = static_cast<std::uint32_t>(codec);
  h.payload = payload.size();

  // Temp file + rename: a crash or a full disk mid-write never leaves a torn
  // file under a frame's name (a leftover .tmp is deleted by the next scan).
  const fs::path final = file_of(dir, job.key);
  fs::path tmp = final;
  tmp.replace_extension(utf8_path(std::string(kTmpExt)));
  bool ok = false;
  {
    std::ofstream f(tmp, std::ios::binary | std::ios::trunc);  // NOLINT(hicpp-signed-bitwise,bugprone-signed-bitwise): the standard's openmode flags
    if (f) {
      std::array<char, sizeof(FileHeader)> head{};
      std::memcpy(head.data(), &h, sizeof h);
      f.write(head.data(), static_cast<std::streamsize>(head.size()));
      f.write(reinterpret_cast<const char*>(payload.data()), static_cast<std::streamsize>(payload.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): bytes out
      f.close();
      ok = !f.fail();
    }
  }
  std::error_code ec;
  if (ok) {
    fs::rename(tmp, final, ec);
    ok = !ec;
  }
  if (!ok) {
    fs::remove(tmp, ec);
    const std::lock_guard<std::mutex> lock(m_);
    pending_.erase(job.key);
    if (counters_.dropped++ == 0) {
      const std::u8string name = final.u8string();
      PREMATION_LOG(warn, "disk_cache_write_failed").kv("file", std::string(name.begin(), name.end()));
    }
    return;
  }
  std::vector<Victim> victims;
  bool measured = true;
  {
    const std::lock_guard<std::mutex> lock(m_);
    pending_.erase(job.key);
    // Purged or moved meanwhile: the file is not this folder's frame any more (a purge deletes it).
    if (job.generation != generation_) return;
    insert_locked(job.key, sizeof h + payload.size());
    ++counters_.writes;
    victims = trim_locked();
    measured = readMsPerMp_ > 0;
  }
  drop_files(victims);
  // An empty folder had nothing to time at its scan: the first frame written is it.
  if (!measured) measure_read(final, job.generation);
}

void DiskCache::measure_read(const fs::path& file, std::uint64_t generation) {
  const auto t0 = std::chrono::steady_clock::now();
  std::vector<std::uint8_t> bytes;
  if (!read_file(file, bytes)) return;
  FileHeader h;
  std::memcpy(&h, bytes.data(), sizeof h);
  if (h.magic != kMagic || h.version != kFileVersion || h.width == 0 || h.height == 0 ||
      h.payload != bytes.size() - sizeof h) {
    return;
  }
  std::vector<std::uint8_t> rgba(std::size_t{h.width} * h.height * 4U);
  if (!frame_codec::decompress(static_cast<frame_codec::Codec>(h.codec), std::span<const std::uint8_t>(bytes).subspan(sizeof h), rgba)) {
    return;
  }
  const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  const double mp = static_cast<double>(h.width) * static_cast<double>(h.height) / 1e6;
  const std::lock_guard<std::mutex> lock(m_);
  if (generation == generation_ && mp > 0) readMsPerMp_ = std::max(ms / mp, 1e-3);  // > 0: measured
}

void DiskCache::do_purge(const fs::path& dir) {
  std::error_code ec;
  std::vector<fs::path> files;
  for (fs::directory_iterator it(dir, ec), end; !ec && it != end; it.increment(ec)) {
    const std::string ext = ext_of(it->path());
    if (ext == kExt || ext == kTmpExt) files.push_back(it->path());
  }
  for (const fs::path& f : files) fs::remove(f, ec);
  fs::remove(dir / utf8_path(std::string(kAliasFile)), ec);
  PREMATION_LOG(info, "disk_cache_purged").kv("files", static_cast<std::int64_t>(files.size()));
}

void DiskCache::do_alias(const Job& job) {
  {
    const std::lock_guard<std::mutex> lock(m_);
    if (job.generation != generation_) return;  // purged or moved meanwhile
  }
  std::array<char, kAliasRecord> rec{};
  std::memcpy(rec.data(), job.alias.data(), kAliasRecord);
  // Writers of other aliases run alongside: one append at a time keeps records whole.
  const std::lock_guard<std::mutex> fileLock(aliasFile_);
  std::ofstream f(job.dir / utf8_path(std::string(kAliasFile)), std::ios::binary | std::ios::app);  // NOLINT(hicpp-signed-bitwise,bugprone-signed-bitwise): the standard's openmode flags
  if (f) f.write(rec.data(), static_cast<std::streamsize>(rec.size()));
}

void DiskCache::load_aliases(const fs::path& dir, std::uint64_t generation) {
  const fs::path file = dir / utf8_path(std::string(kAliasFile));
  std::vector<std::uint8_t> bytes;
  {
    std::error_code ec;
    const std::uintmax_t size = fs::file_size(file, ec);
    if (ec || size < kAliasRecord) return;
    std::ifstream f(file, std::ios::binary);
    if (!f) return;
    bytes.resize(static_cast<std::size_t>(size - size % kAliasRecord));  // a torn last record is dropped
    f.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): bytes in
    if (!std::cmp_equal(f.gcount(), bytes.size())) return;
  }
  const std::size_t records = bytes.size() / kAliasRecord;
  std::unordered_map<std::uint64_t, std::pair<std::uint64_t, std::uint64_t>> map;
  map.reserve(records);
  for (std::size_t i = 0; i < records; ++i) {
    std::array<std::uint64_t, 3> r{};
    std::memcpy(r.data(), bytes.data() + i * kAliasRecord, kAliasRecord);
    map[r[0]] = {r[1], r[2]};
  }
  std::vector<std::array<std::uint64_t, 3>> live;
  {
    const std::lock_guard<std::mutex> lock(m_);
    if (generation != generation_) return;
    for (const auto& [alias, keys] : map) {
      if (!index_.contains(keys.second)) continue;  // its frame was evicted or purged
      aliases_.emplace(alias, keys);
      live.push_back({alias, keys.first, keys.second});
    }
  }
  // Compacted when the dead (superseded, evicted) records outnumber the live
  // ones: rewritten through a temp file, never in place.
  if (records > 2 * live.size() + 1024) {
    fs::path tmp = file;
    tmp.replace_extension(utf8_path(std::string(kTmpExt)));
    bool ok = false;
    {
      std::ofstream f(tmp, std::ios::binary | std::ios::trunc);  // NOLINT(hicpp-signed-bitwise,bugprone-signed-bitwise): the standard's openmode flags
      if (f) {
        for (const auto& r : live) {
          std::array<char, kAliasRecord> rec{};
          std::memcpy(rec.data(), r.data(), kAliasRecord);
          f.write(rec.data(), static_cast<std::streamsize>(rec.size()));
        }
        f.close();
        ok = !f.fail();
      }
    }
    std::error_code ec;
    if (ok) fs::rename(tmp, file, ec);
    if (!ok || ec) fs::remove(tmp, ec);
  }
  PREMATION_LOG(info, "disk_cache_aliases").kv("live", static_cast<std::int64_t>(live.size())).kv("records", static_cast<std::int64_t>(records));
}

}  // namespace premation::render
