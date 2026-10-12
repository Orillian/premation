// SceneTextures: footage a native plugin importer reads (P7b, pr_io.h). The
// plugin's READ_FRAME (through the host, native_contrib.hpp) gives straight
// RGBA float; it is stored like a decoded still — premultiplied sRGB-encoded
// RGBA8 in the raster cache, keyed by path + size + last write + source time.
// A failed read records "plugin failed to read …" for layerErrors
// (snapshot_build.cpp) and draws nothing for that layer; the frame renders.
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>

#include "image_decode.hpp"
#include "native_contrib.hpp"
#include "scene_textures.hpp"

namespace premation::scene {
namespace {

std::uint64_t fnv(std::string_view s, std::uint64_t h = 1469598103934665603ULL) {
  for (const char c : s) {
    h ^= static_cast<unsigned char>(c);
    h *= 1099511628211ULL;
  }
  return h;
}

float encode_srgb(float v) {
  if (!(v > 0)) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308F ? v * 12.92F : 1.055F * std::pow(v, 1.0F / 2.4F) - 0.055F;
}

std::uint8_t q8(float v) { return static_cast<std::uint8_t>(std::lround(std::clamp(v, 0.0F, 1.0F) * 255.0F)); }

}  // namespace

std::string SceneTextures::plugin_image_ref(const TextureRequest& r, const std::filesystem::path& p, PrepareStats& stats) {
  const FileStamp st = file_stamp(p);
  // Stills ignore the time; a moving file keys per microsecond of source time.
  const long long us = r.video ? std::llround(r.sourceTime * 1e6) : 0;
  std::array<char, 96> tail{};
  std::snprintf(tail.data(), tail.size(), "|%llu|%llu|%d|%lld", static_cast<unsigned long long>(st.size),  // NOLINT(cppcoreguidelines-pro-type-vararg)
                static_cast<unsigned long long>(st.modified), r.premultiplied ? 1 : 0, us);
  const std::string path = p.lexically_normal().string();
  std::array<char, 24> hex{};
  std::snprintf(hex.data(), hex.size(), "%016llx", static_cast<unsigned long long>(fnv(tail.data(), fnv(path))));  // NOLINT(cppcoreguidelines-pro-type-vararg)
  std::string hash = std::string("img:plg") + hex.data();
  if (const auto oe = openErrors_.find(hash); oe != openErrors_.end()) {
    stats.unsupported.emplace_back(r.key, oe->second);
    return {};
  }
  if (find(hash)) return hash;
  const auto t0 = std::chrono::steady_clock::now();
  doc::NativeImage img;
  std::string error;
  const std::string utf8 = [&] {
    const std::u8string u = p.u8string();
    return std::string(u.begin(), u.end());
  }();
  const std::string fname = [&] {
    const std::u8string u = p.filename().u8string();
    return std::string(u.begin(), u.end());
  }();
  if (!doc::NativeImporters::read_frame(utf8, r.video ? r.sourceTime : 0.0, img, error) || img.width == 0 || img.height == 0 ||
      img.rgba.size() < std::size_t{img.width} * img.height * 4) {
    const std::string why = "plugin failed to read '" + fname + "': " + (error.empty() ? "no pixels" : error);
    openErrors_.emplace(hash, why);
    doc::NativeImporters::set_failure(fname, why);
    stats.unsupported.emplace_back(r.key, why);
    return {};
  }
  doc::NativeImporters::clear_failure(fname);
  auto e = std::make_shared<RasterEntry>();
  e->width = img.width;
  e->height = img.height;
  e->rgba.resize(std::size_t{img.width} * img.height * 4);
  for (std::size_t i = 0; i < e->rgba.size(); i += 4) {
    // Straight in, premultiplied out (as image_ref premultiplies decoded stills).
    const float a = std::clamp(img.rgba[i + 3], 0.0F, 1.0F);
    for (std::size_t c = 0; c < 3; ++c) {
      float v = img.rgba[i + c];
      if (img.linear) v = encode_srgb(v);
      e->rgba[i + c] = q8(r.premultiplied ? v : v * a);
    }
    e->rgba[i + 3] = q8(a);
  }
  insert(hash, std::move(e));
  ++stats.rasterMisses;
  stats.rasterMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  return hash;
}

}  // namespace premation::scene
