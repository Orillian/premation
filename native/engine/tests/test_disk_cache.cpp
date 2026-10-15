// The preview cache's disk tier (src/render/disk_cache.hpp): round trips,
// persistence across instances (sessions), LRU eviction at the size limit,
// purge touching only its own files, and damaged files read as misses.
#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string>
#include <unordered_map>
#include <vector>

#include "disk_cache.hpp"
#include "frame_codec.hpp"

namespace fs = std::filesystem;
using premation::render::DiskCache;

namespace {

constexpr std::uint32_t kW = 64;
constexpr std::uint32_t kH = 64;
constexpr std::uint64_t kFrameBytes = std::uint64_t{kW} * kH * 4U;

/// A fresh folder per test (removed first: a crashed run's leftovers never leak in).
fs::path fresh_dir(const std::string& name) {
  const fs::path dir = fs::temp_directory_path() / ("premation-disk-cache-test-" + name);
  std::error_code ec;
  fs::remove_all(dir, ec);
  fs::create_directories(dir);
  return dir;
}

std::string utf8(const fs::path& p) {
  const std::u8string s = p.u8string();
  return {s.begin(), s.end()};
}

/// Seeded noise: does not compress, so a file's size is known (header + raw pixels).
std::vector<std::uint8_t> noise(std::uint32_t seed) {
  std::vector<std::uint8_t> px(kFrameBytes);
  std::uint32_t x = seed * 2654435761U + 1U;
  for (auto& b : px) {
    x = x * 1664525U + 1013904223U;
    b = static_cast<std::uint8_t>(x >> 24U);
  }
  return px;
}

/// Flat colour: compresses to almost nothing.
std::vector<std::uint8_t> flat(std::uint8_t v) { return std::vector<std::uint8_t>(kFrameBytes, v); }

std::size_t count_files(const fs::path& dir, const std::string& ext) {
  std::size_t n = 0;
  std::error_code ec;
  for (fs::directory_iterator it(dir, ec), end; !ec && it != end; it.increment(ec)) {
    if (it->path().extension() == ext) ++n;
  }
  return n;
}

}  // namespace

TEST_CASE("disk cache: a stored frame loads back byte for byte", "[disk_cache]") {
  const fs::path dir = fresh_dir("roundtrip");
  DiskCache cache;
  cache.configure(utf8(dir), 64ULL * 1024 * 1024);
  cache.flush();
  REQUIRE(cache.enabled());

  const auto a = noise(1);
  const auto b = flat(200);
  REQUIRE(cache.wants(11));
  REQUIRE(cache.store(11, kW, kH, a));
  REQUIRE(cache.store(12, kW, kH, b));
  CHECK_FALSE(cache.wants(11));  // queued: never read back twice
  cache.flush();

  std::vector<std::uint8_t> out;
  REQUIRE(cache.load(11, kW, kH, out));
  CHECK(out == a);
  REQUIRE(cache.load(12, kW, kH, out));
  CHECK(out == b);
  CHECK_FALSE(cache.load(13, kW, kH, out));      // never stored
  CHECK_FALSE(cache.load(11, kW * 2, kH, out));  // another size: a miss, not garbage

  const auto s = cache.stats();
  CHECK(s.entries == 1);  // the wrong-size read dropped 11
  CHECK(s.writes == 2);
  cache.flush();  // the dropped file's delete
  CHECK(count_files(dir / DiskCache::kSubfolder, ".pfc") == 1);
}

TEST_CASE("disk cache: frames outlive the instance (the next session reads them)", "[disk_cache]") {
  const fs::path dir = fresh_dir("persist");
  const auto a = noise(7);
  {
    DiskCache cache;
    cache.configure(utf8(dir), 64ULL * 1024 * 1024);
    REQUIRE(cache.store(42, kW, kH, a));
    cache.flush();
  }
  DiskCache next;
  next.configure(utf8(dir), 64ULL * 1024 * 1024);
  next.flush();  // the scan
  REQUIRE(next.contains(42));
  std::vector<std::uint8_t> out;
  REQUIRE(next.load(42, kW, kH, out));
  CHECK(out == a);
  CHECK(next.bytes() > 0);
}

TEST_CASE("disk cache: the read cost is measured on the folder's own files", "[disk_cache]") {
  const fs::path dir = fresh_dir("readcost");
  {
    DiskCache cache;
    cache.configure(utf8(dir), 64ULL * 1024 * 1024);
    cache.flush();
    CHECK(cache.read_ms_per_mp() == 0);  // an empty folder: nothing to time yet
    REQUIRE(cache.store(1, kW, kH, noise(1)));
    cache.flush();
    CHECK(cache.read_ms_per_mp() > 0);  // the first frame written was timed
  }
  DiskCache next;
  next.configure(utf8(dir), 64ULL * 1024 * 1024);
  next.flush();  // the scan times the newest file
  CHECK(next.read_ms_per_mp() > 0);
  next.configure("", 0);
  CHECK(next.read_ms_per_mp() == 0);  // off (another folder): not this folder's measurement
}

TEST_CASE("disk cache: the least recently used frame goes first at the limit", "[disk_cache]") {
  const fs::path dir = fresh_dir("lru");
  DiskCache cache;
  // Room for two noise frames, not three.
  cache.configure(utf8(dir), kFrameBytes * 2 + kFrameBytes / 2);
  cache.flush();
  REQUIRE(cache.store(1, kW, kH, noise(1)));
  cache.flush();
  REQUIRE(cache.store(2, kW, kH, noise(2)));
  cache.flush();
  std::vector<std::uint8_t> out;
  REQUIRE(cache.load(1, kW, kH, out));  // 1 is now the most recently used
  REQUIRE(cache.store(3, kW, kH, noise(3)));
  cache.flush();
  CHECK(cache.contains(1));
  CHECK_FALSE(cache.contains(2));
  CHECK(cache.contains(3));
  CHECK(cache.stats().evictions == 1);
  CHECK(count_files(dir / DiskCache::kSubfolder, ".pfc") == 2);

  // A smaller limit evicts down to it.
  cache.configure(utf8(dir), kFrameBytes + kFrameBytes / 2);
  cache.flush();
  CHECK(cache.contains(3));
  CHECK_FALSE(cache.contains(1));
}

TEST_CASE("disk cache: purge deletes its own files and nothing else", "[disk_cache]") {
  const fs::path dir = fresh_dir("purge");
  { std::ofstream(dir / "keep-me.txt") << "the user's file"; }
  DiskCache cache;
  cache.configure(utf8(dir), 64ULL * 1024 * 1024);
  REQUIRE(cache.store(5, kW, kH, flat(9)));
  REQUIRE(cache.store(6, kW, kH, flat(10)));
  cache.flush();
  { std::ofstream(dir / DiskCache::kSubfolder / "notes.txt") << "not a frame"; }
  cache.purge();
  cache.flush();
  CHECK_FALSE(cache.contains(5));
  CHECK(cache.bytes() == 0);
  CHECK(count_files(dir / DiskCache::kSubfolder, ".pfc") == 0);
  CHECK(fs::exists(dir / "keep-me.txt"));
  CHECK(fs::exists(dir / DiskCache::kSubfolder / "notes.txt"));
}

TEST_CASE("disk cache: a damaged file is a miss and is forgotten", "[disk_cache]") {
  const fs::path dir = fresh_dir("damaged");
  DiskCache cache;
  cache.configure(utf8(dir), 64ULL * 1024 * 1024);
  REQUIRE(cache.store(0xabcULL, kW, kH, noise(3)));
  cache.flush();
  const fs::path file = dir / DiskCache::kSubfolder / "0000000000000abc.pfc";
  REQUIRE(fs::exists(file));
  fs::resize_file(file, fs::file_size(file) / 2);  // a torn write
  std::vector<std::uint8_t> out;
  CHECK_FALSE(cache.load(0xabcULL, kW, kH, out));
  CHECK_FALSE(cache.contains(0xabcULL));
  cache.flush();
  CHECK_FALSE(fs::exists(file));
}

TEST_CASE("disk cache: a reserved frame counts as on its way until it is written or released", "[disk_cache]") {
  const fs::path dir = fresh_dir("reserve");
  DiskCache cache;
  cache.configure(utf8(dir), 64ULL * 1024 * 1024);
  cache.flush();
  REQUIRE(cache.reserve(1));
  CHECK_FALSE(cache.reserve(1));  // read back once
  CHECK_FALSE(cache.wants(1));
  CHECK(cache.writing());

  // The coverage walk keeps a reserved key (not yet a frame on disk), drops an unknown one.
  std::unordered_map<std::int64_t, std::vector<std::uint64_t>> byFrame{{0, {1}}, {1, {99}}};
  std::vector<std::int64_t> onDisk;
  cache.retain_present(byFrame, onDisk);
  CHECK(byFrame.contains(0));
  CHECK_FALSE(byFrame.contains(1));
  CHECK(onDisk.empty());

  REQUIRE(cache.store(1, kW, kH, flat(3)));  // the reservation's frame
  cache.flush();
  onDisk.clear();
  cache.retain_present(byFrame, onDisk);
  CHECK(onDisk == std::vector<std::int64_t>{0});

  REQUIRE(cache.reserve(2));
  cache.release(2);  // the read-back failed
  CHECK(cache.wants(2));
  CHECK_FALSE(cache.writing());
}

TEST_CASE("disk cache: off takes nothing", "[disk_cache]") {
  const fs::path dir = fresh_dir("off");
  DiskCache cache;
  CHECK_FALSE(cache.enabled());
  CHECK_FALSE(cache.store(1, kW, kH, flat(1)));
  cache.configure(utf8(dir), 0);  // a 0 MB limit = off
  CHECK_FALSE(cache.enabled());
  CHECK_FALSE(cache.wants(1));
  CHECK_FALSE(cache.store(1, kW, kH, flat(1)));
  CHECK_FALSE(cache.store(2, kW, kH, std::vector<std::uint8_t>(10)));  // wrong size, refused anyway
}

// Hidden (run with "[.disk_cache_bench]"): where a 1080p disk hit's time goes, without the GPU upload.
TEST_CASE("disk cache: 1080p load timing", "[.disk_cache_bench]") {
  constexpr std::uint32_t w = 1920;
  constexpr std::uint32_t h = 1080;
  const fs::path dir = fresh_dir("bench");
  DiskCache cache;
  cache.configure(utf8(dir), 8ULL * 1024 * 1024 * 1024);
  cache.flush();
  // A motion-graphics-like frame: flat background, soft shapes, a noisy band.
  std::vector<std::uint8_t> px(std::size_t{w} * h * 4U);
  std::uint32_t x = 12345;
  for (std::uint32_t y = 0; y < h; ++y) {
    for (std::uint32_t c = 0; c < w; ++c) {
      const std::size_t i = (std::size_t{y} * w + c) * 4U;
      x = x * 1664525U + 1013904223U;
      const bool noisy = y > 400 && y < 520;
      const auto v = static_cast<std::uint8_t>(noisy ? (x >> 24U) : ((c / 8U + y / 8U) & 0xFFU));
      px[i] = v;
      px[i + 1] = static_cast<std::uint8_t>(255U - v);
      px[i + 2] = 40;
      px[i + 3] = 255;
    }
  }
  REQUIRE(cache.store(1, w, h, px));
  cache.flush();
  std::vector<std::uint8_t> out;
  REQUIRE(cache.load(1, w, h, out));  // warm the OS file cache
  const auto t0 = std::chrono::steady_clock::now();
  constexpr int kRuns = 20;
  for (int i = 0; i < kRuns; ++i) REQUIRE(cache.load(1, w, h, out));
  const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count() / kRuns;
  const auto file = fs::file_size(dir / DiskCache::kSubfolder / "0000000000000001.pfc");
  std::printf("[disk_cache_bench] 1080p load %.2f ms, file %.2f MB of %.2f MB raw\n", ms,
              static_cast<double>(file) / 1048576.0, static_cast<double>(px.size()) / 1048576.0);
  CHECK(out == px);

  std::vector<std::uint8_t> packed;
  REQUIRE(premation::render::frame_codec::compress(px, packed));
  const auto t1 = std::chrono::steady_clock::now();
  for (int i = 0; i < kRuns; ++i) {
    REQUIRE(premation::render::frame_codec::decompress(premation::render::frame_codec::preferred(), packed, out));
  }
  const double dec = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t1).count() / kRuns;
  const auto t2 = std::chrono::steady_clock::now();
  for (int i = 0; i < kRuns; ++i) std::memcpy(out.data(), px.data(), px.size());
  const double copy = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t2).count() / kRuns;
  std::printf("[disk_cache_bench] decode %.2f ms, memcpy %.2f ms\n", dec, copy);
}
