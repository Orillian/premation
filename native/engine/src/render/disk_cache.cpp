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

DiskCache::DiskCache() : thread_([this] { run(); }) {}

DiskCache::~DiskCache() {
  {
    const std::lock_guard<std::mutex> lock(m_);
    quit_ = true;
  }
  cv_.notify_all();
  if (thread_.joinable()) thread_.join();
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
      bytes_ = 0;
      readMsPerMp_ = 0;
      std::erase_if(jobs_, [](const Job& j) { return j.kind == JobKind::write || j.kind == JobKind::touch || j.kind == JobKind::trim; });
      queuedBytes_ = 0;
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

std::uint64_t DiskCache::bytes() const {
  const std::lock_guard<std::mutex> lock(m_);
  return bytes_;
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
         !reserved_.contains(key) && queuedBytes_ < kMaxQueuedBytes;
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
      }
    } else {
      ++counters_.hits;
      // Recency outlives the session: the file's time is what the next scan orders by.
      jobs_.push_back(job_of(JobKind::touch, generation, p));
    }
  }
  cv_.notify_all();
  if (!ok) {
    PREMATION_LOG(warn, "disk_cache_bad_file").kv("key", hex16(key));
  }
  return ok;
}

bool DiskCache::store(std::uint64_t key, std::uint32_t width, std::uint32_t height, std::vector<std::uint8_t> rgba) {
  {
    const std::lock_guard<std::mutex> lock(m_);
    reserved_.erase(key);  // a reservation ends here, taken or not
    if (rgba.size() != std::size_t{width} * height * 4U || rgba.empty()) return false;
    if (dir_.empty() || !counters_.error.empty() || index_.contains(key) || pending_.contains(key)) return false;
    if (queuedBytes_ + rgba.size() > kMaxQueuedBytes) {
      ++counters_.dropped;
      return false;
    }
    queuedBytes_ += rgba.size();
    pending_.insert(key);
    Job job = job_of(JobKind::write, generation_);
    job.key = key;
    job.width = width;
    job.height = height;
    job.rgba = std::move(rgba);
    jobs_.push_back(std::move(job));
  }
  cv_.notify_all();
  return true;
}

bool DiskCache::reserve(std::uint64_t key) {
  const std::lock_guard<std::mutex> lock(m_);
  if (dir_.empty() || !counters_.error.empty() || index_.contains(key) || pending_.contains(key) ||
      reserved_.contains(key) || queuedBytes_ >= kMaxQueuedBytes) {
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
    bytes_ = 0;
    std::erase_if(jobs_, [](const Job& j) { return j.kind == JobKind::write || j.kind == JobKind::touch || j.kind == JobKind::trim; });
    queuedBytes_ = 0;
    if (!dir_.empty()) jobs_.push_back(job_of(JobKind::purge, generation_, dir_));
  }
  cv_.notify_all();
}

void DiskCache::flush() {
  std::unique_lock<std::mutex> lock(m_);
  idle_.wait(lock, [this] { return quit_ || (jobs_.empty() && !busy_); });
}

DiskCacheStats DiskCache::stats() const {
  const std::lock_guard<std::mutex> lock(m_);
  DiskCacheStats s = counters_;
  s.bytes = bytes_;
  s.entries = index_.size();
  return s;
}

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

std::vector<fs::path> DiskCache::trim_locked() {
  std::vector<fs::path> victims;
  while (bytes_ > budget_ && !lru_.empty()) {
    const std::uint64_t key = lru_.back();
    victims.push_back(file_of(dir_, key));
    erase_locked(key);
    ++counters_.evictions;
  }
  return victims;
}

void DiskCache::run() {
  for (;;) {
    Job job;
    {
      std::unique_lock<std::mutex> lock(m_);
      cv_.wait(lock, [this] { return quit_ || !jobs_.empty(); });
      // Stopping drops what is queued: those frames are drawn (and written) again next session.
      if (quit_) break;
      job = std::move(jobs_.front());
      jobs_.pop_front();
      if (job.kind == JobKind::write) queuedBytes_ -= std::min<std::uint64_t>(queuedBytes_, job.rgba.size());
      busy_ = true;
    }
    std::error_code ec;
    switch (job.kind) {
      case JobKind::scan: do_scan(job); break;
      case JobKind::write: do_write(job); break;
      case JobKind::touch: fs::last_write_time(job.dir, fs::file_time_type::clock::now(), ec); break;
      case JobKind::remove: fs::remove(job.dir, ec); break;
      case JobKind::purge: do_purge(job.dir); break;
      case JobKind::trim: {
        std::vector<fs::path> victims;
        {
          const std::lock_guard<std::mutex> lock(m_);
          if (job.generation == generation_) victims = trim_locked();
        }
        for (const fs::path& v : victims) fs::remove(v, ec);
        break;
      }
    }
    {
      const std::lock_guard<std::mutex> lock(m_);
      busy_ = false;
    }
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
  std::vector<fs::path> victims;
  std::uint64_t bytes = 0;
  {
    const std::lock_guard<std::mutex> lock(m_);
    if (job.generation != generation_) return;
    for (const Found& f : found) insert_locked(f.key, f.bytes);
    victims = trim_locked();
    bytes = bytes_;
  }
  for (const fs::path& v : victims) fs::remove(v, ec);
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
  std::vector<fs::path> victims;
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
  for (const fs::path& v : victims) fs::remove(v, ec);
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
  PREMATION_LOG(info, "disk_cache_purged").kv("files", static_cast<std::int64_t>(files.size()));
}

}  // namespace premation::render
