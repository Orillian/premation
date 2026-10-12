#include "asset_image.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <fstream>
#include <map>
#include <mutex>
#include <span>
#include <sstream>
#include <utility>
#include <vector>

namespace fs = std::filesystem;

namespace premation::plugins {
namespace {

std::mutex g_mutex;                            // NOLINT(cppcoreguidelines-avoid-non-const-global-variables): the process's decoder + cache
AssetImageDecoder g_decoder;                   // NOLINT(cppcoreguidelines-avoid-non-const-global-variables)
std::map<std::string, std::shared_ptr<const AssetImage>> g_cache;  // NOLINT(cppcoreguidelines-avoid-non-const-global-variables)
std::deque<std::string> g_order;               // NOLINT(cppcoreguidelines-avoid-non-const-global-variables): oldest first
std::size_t g_bytes = 0;                       // NOLINT(cppcoreguidelines-avoid-non-const-global-variables)
constexpr std::size_t kCacheBytes = std::size_t{1024} * 1024 * 1024;  // decoded float images kept at most
constexpr std::uint64_t kMaxFileBytes = std::uint64_t{512} * 1024 * 1024;
constexpr std::int64_t kMaxPixels = std::int64_t{16384} * 16384;

std::string lower_ext(const fs::path& p) {
  std::string e = p.extension().string();
  std::ranges::transform(e, e.begin(), [](char c) { return static_cast<char>(c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c); });
  return e;
}

bool read_file(const fs::path& p, std::vector<std::uint8_t>& out, std::string& why) {
  std::error_code ec;
  const std::uintmax_t n = fs::file_size(p, ec);
  if (ec) {
    why = "cannot read the file";
    return false;
  }
  if (n > kMaxFileBytes) {
    why = "larger than 512 MiB";
    return false;
  }
  out.resize(static_cast<std::size_t>(n));
  std::ifstream f(p, std::ios::binary);
  if (!f || !f.read(reinterpret_cast<char*>(out.data()), static_cast<std::streamsize>(n))) {  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): bytes
    why = "cannot read the file";
    return false;
  }
  return true;
}

/// A text header line ending in '\n' at `at` (advanced past it).
bool line_at(std::span<const std::uint8_t> b, std::size_t& at, std::string& out) {
  out.clear();
  while (at < b.size() && b[at] != '\n') out.push_back(static_cast<char>(b[at++]));
  if (at >= b.size()) return false;
  ++at;
  if (!out.empty() && out.back() == '\r') out.pop_back();
  return true;
}

bool sized(std::int64_t w, std::int64_t h) { return w > 0 && h > 0 && w * h <= kMaxPixels; }

/// Radiance RGBE (.hdr / .pic): flat or new-style run-length scanlines, -Y +X order.
bool decode_hdr(std::span<const std::uint8_t> b, DecodedAsset& out, std::string& why) {
  std::size_t at = 0;
  std::string line;
  if (!line_at(b, at, line) || !(line.starts_with("#?RADIANCE") || line.starts_with("#?RGBE"))) {
    why = "not a Radiance file";
    return false;
  }
  bool rgbe = true;
  while (line_at(b, at, line) && !line.empty()) {
    if (line.starts_with("FORMAT=")) rgbe = line == "FORMAT=32-bit_rle_rgbe";
  }
  if (!rgbe) {
    why = "only 32-bit_rle_rgbe Radiance files are read";
    return false;
  }
  if (!line_at(b, at, line)) {
    why = "no resolution line";
    return false;
  }
  long long h = 0;
  long long w = 0;
  std::string ys;
  std::string xs;
  std::istringstream res(line);
  if (!(res >> ys >> h >> xs >> w) || ys != "-Y" || xs != "+X" || !sized(w, h)) {
    why = "unsupported Radiance orientation or size";
    return false;
  }
  const auto W = static_cast<std::size_t>(w);
  const auto H = static_cast<std::size_t>(h);
  out.image.width = static_cast<std::int32_t>(w);
  out.image.height = static_cast<std::int32_t>(h);
  out.image.rgba.assign(W * H * 4, 0.0F);
  out.linear = true;
  out.premultiplied = true;  // opaque
  std::vector<std::uint8_t> scan(W * 4);
  for (std::size_t y = 0; y < H; ++y) {
    if (at + 4 > b.size()) {
      why = "truncated";
      return false;
    }
    const bool rle = W >= 8 && W < 32768 && b[at] == 2 && b[at + 1] == 2 &&
                     ((static_cast<std::size_t>(b[at + 2]) << 8U) | b[at + 3]) == W;
    if (rle) {
      at += 4;
      for (std::size_t c = 0; c < 4; ++c) {
        std::size_t x = 0;
        while (x < W) {
          if (at >= b.size()) {
            why = "truncated";
            return false;
          }
          std::size_t n = b[at++];
          if (n > 128) {
            n -= 128;
            if (at >= b.size() || x + n > W) {
              why = "corrupt run";
              return false;
            }
            const std::uint8_t v = b[at++];
            for (std::size_t k = 0; k < n; ++k) scan[(x++) * 4 + c] = v;
          } else {
            if (n == 0 || at + n > b.size() || x + n > W) {
              why = "corrupt run";
              return false;
            }
            for (std::size_t k = 0; k < n; ++k) scan[(x++) * 4 + c] = b[at++];
          }
        }
      }
    } else {
      if (at + W * 4 > b.size()) {
        why = "truncated";
        return false;
      }
      std::memcpy(scan.data(), b.data() + at, W * 4);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      at += W * 4;
    }
    for (std::size_t x = 0; x < W; ++x) {
      const std::uint8_t e = scan[x * 4 + 3];
      const float f = e == 0 ? 0.0F : std::ldexp(1.0F, static_cast<int>(e) - (128 + 8));
      float* px = &out.image.rgba[(y * W + x) * 4];
      px[0] = static_cast<float>(scan[x * 4]) * f;      // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      px[1] = static_cast<float>(scan[x * 4 + 1]) * f;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      px[2] = static_cast<float>(scan[x * 4 + 2]) * f;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      px[3] = 1.0F;                                     // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    }
  }
  return true;
}

/// The header of a binary PNM / PFM: magic, width, height, maxval / scale (whitespace-separated, # comments).
bool pnm_header(std::span<const std::uint8_t> b, std::size_t& at, std::array<std::string, 4>& tok) {
  for (std::string& t : tok) {
    for (;;) {
      while (at < b.size() && std::isspace(b[at]) != 0) ++at;
      if (at < b.size() && b[at] == '#') {
        while (at < b.size() && b[at] != '\n') ++at;
        continue;
      }
      break;
    }
    while (at < b.size() && std::isspace(b[at]) == 0) t.push_back(static_cast<char>(b[at++]));
    if (t.empty()) return false;
  }
  if (at >= b.size()) return false;
  ++at;  // the single whitespace before the raster
  return true;
}

/// Binary PPM (P6, 8 or 16 bit: sRGB, opaque) and PFM (PF colour / Pf grey: linear floats, bottom row first).
bool decode_pnm(std::span<const std::uint8_t> b, DecodedAsset& out, std::string& why) {
  std::size_t at = 0;
  std::array<std::string, 4> tok;
  if (!pnm_header(b, at, tok)) {
    why = "not a PPM / PFM file";
    return false;
  }
  const long long w = std::atoll(tok[1].c_str());  // NOLINT(cert-err34-c)
  const long long h = std::atoll(tok[2].c_str());  // NOLINT(cert-err34-c)
  if (!sized(w, h)) {
    why = "unsupported size";
    return false;
  }
  const auto W = static_cast<std::size_t>(w);
  const auto H = static_cast<std::size_t>(h);
  out.image.width = static_cast<std::int32_t>(w);
  out.image.height = static_cast<std::int32_t>(h);
  out.image.rgba.assign(W * H * 4, 1.0F);
  if (tok[0] == "P6") {
    const double maxv = std::atof(tok[3].c_str());  // NOLINT(cert-err34-c)
    const std::size_t bpc = maxv > 255 ? 2 : 1;
    if (!(maxv > 0 && maxv < 65536) || at + W * H * 3 * bpc > b.size()) {
      why = "truncated or bad maxval";
      return false;
    }
    for (std::size_t i = 0; i < W * H * 3; ++i) {
      const double v = bpc == 2 ? static_cast<double>((static_cast<std::uint32_t>(b[at + i * 2]) << 8U) | b[at + i * 2 + 1])
                                : static_cast<double>(b[at + i]);
      out.image.rgba[(i / 3) * 4 + i % 3] = static_cast<float>(v / maxv);
    }
    out.linear = false;
    out.premultiplied = true;  // opaque
    return true;
  }
  if (tok[0] == "PF" || tok[0] == "Pf") {
    const std::size_t ch = tok[0] == "PF" ? 3 : 1;
    const double scale = std::atof(tok[3].c_str());  // NOLINT(cert-err34-c)
    const bool little = scale < 0;
    if (at + W * H * ch * 4 > b.size()) {
      why = "truncated";
      return false;
    }
    for (std::size_t y = 0; y < H; ++y) {
      for (std::size_t x = 0; x < W; ++x) {
        for (std::size_t c = 0; c < ch; ++c) {
          const std::size_t o = at + ((y * W + x) * ch + c) * 4;
          const auto u8 = [&](std::size_t k) { return static_cast<std::uint32_t>(b[o + k]); };
          const std::uint32_t u = little ? (u8(0) | u8(1) << 8U | u8(2) << 16U | u8(3) << 24U) : (u8(0) << 24U | u8(1) << 16U | u8(2) << 8U | u8(3));
          const float f = std::bit_cast<float>(u);
          float* px = &out.image.rgba[((H - 1 - y) * W + x) * 4];  // bottom row first
          for (std::size_t k = (ch == 1 ? 0 : c); k < (ch == 1 ? 3 : c + 1); ++k) px[k] = std::isfinite(f) ? f : 0.0F;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
        }
      }
    }
    out.linear = true;
    out.premultiplied = true;  // opaque
    return true;
  }
  why = "only binary P6 / PF / Pf are read";
  return false;
}

float srgb_to_linear(float v) {
  if (v <= 0.04045F) return v / 12.92F;
  return std::pow((v + 0.055F) / 1.055F, 2.4F);
}

std::string stamp_key(const fs::path& file) {
  std::error_code ec;
  const std::uintmax_t size = fs::file_size(file, ec);
  const auto mtime = fs::last_write_time(file, ec);
  return file.lexically_normal().string() + "|" + std::to_string(size) + "|" +
         std::to_string(static_cast<long long>(mtime.time_since_epoch().count()));
}

bool contains_dotdot(const fs::path& rel) {
  return std::ranges::any_of(rel, [](const fs::path& part) { return part == ".."; });
}

}  // namespace

void set_asset_image_decoder(AssetImageDecoder decoder) {
  const std::scoped_lock lock(g_mutex);
  g_decoder = std::move(decoder);
}

void clear_asset_images() {
  const std::scoped_lock lock(g_mutex);
  g_cache.clear();
  g_order.clear();
  g_bytes = 0;
}

std::shared_ptr<const AssetImage> load_asset_image(const fs::path& file, std::string& key, std::string& why, bool& unsupported) {
  unsupported = false;
  std::error_code ec;
  if (!fs::is_regular_file(file, ec)) {
    why = "the file is missing";
    return nullptr;
  }
  key = stamp_key(file);
  AssetImageDecoder decoder;
  {
    const std::scoped_lock lock(g_mutex);
    if (const auto it = g_cache.find(key); it != g_cache.end()) return it->second;
    decoder = g_decoder;
  }
  DecodedAsset d;
  const std::string ext = lower_ext(file);
  bool ok = false;
  if (ext == ".hdr" || ext == ".pic" || ext == ".ppm" || ext == ".pfm") {
    std::vector<std::uint8_t> bytes;
    if (!read_file(file, bytes, why)) return nullptr;
    ok = ext == ".ppm" || ext == ".pfm" ? decode_pnm(bytes, d, why) : decode_hdr(bytes, d, why);
  } else if (decoder) {
    ok = decoder(file, d, why);
  } else {
    unsupported = true;
    why = "no decoder for '" + ext + "' files";
    return nullptr;
  }
  if (!ok) {
    unsupported = d.unsupported;
    if (why.empty()) why = "the image did not decode";
    return nullptr;
  }
  const std::size_t n = static_cast<std::size_t>(std::max(0, d.image.width)) * static_cast<std::size_t>(std::max(0, d.image.height));
  if (n == 0 || d.image.rgba.size() != n * 4) {
    why = "the decoder returned no pixels";
    return nullptr;
  }
  // → linear (the working space), then premultiplied (what every world carries).
  for (std::size_t i = 0; i < n; ++i) {
    float* px = &d.image.rgba[i * 4];
    if (!d.linear) {
      for (std::size_t c = 0; c < 3; ++c) px[c] = srgb_to_linear(px[c]);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    }
    if (!d.premultiplied) {
      for (std::size_t c = 0; c < 3; ++c) px[c] *= px[3];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    }
  }
  auto img = std::make_shared<const AssetImage>(std::move(d.image));
  const std::size_t bytes = img->rgba.size() * sizeof(float);
  const std::scoped_lock lock(g_mutex);
  if (const auto it = g_cache.find(key); it != g_cache.end()) return it->second;  // another thread decoded it meanwhile
  while (!g_order.empty() && g_bytes + bytes > kCacheBytes) {
    if (const auto old = g_cache.find(g_order.front()); old != g_cache.end()) {
      g_bytes -= old->second->rgba.size() * sizeof(float);
      g_cache.erase(old);
    }
    g_order.pop_front();
  }
  g_cache.emplace(key, img);
  g_order.push_back(key);
  g_bytes += bytes;
  return img;
}

bool resolve_sibling(const fs::path& asset, std::string_view relative, fs::path& out, std::string& why) {
  if (relative.empty() || relative.size() > 1024 || relative.find('\0') != std::string_view::npos) {
    why = "an empty or over-long path";
    return false;
  }
  std::string rel(relative);
  std::ranges::replace(rel, '\\', '/');
  if (rel.front() == '/' || rel.find(':') != std::string::npos) {
    why = "an absolute path";
    return false;
  }
  const fs::path r(std::u8string(rel.begin(), rel.end()));
  if (r.is_absolute() || r.has_root_name() || r.has_root_directory() || contains_dotdot(r)) {
    why = "a path outside the asset's folder";
    return false;
  }
  std::error_code ec;
  const fs::path base = fs::canonical(asset.parent_path(), ec);
  if (ec) {
    why = "the asset's folder is gone";
    return false;
  }
  const fs::path file = fs::canonical(base / r, ec);  // resolves symlinks: one pointing out is caught below
  if (ec) {
    why = "no such file";
    return false;
  }
  const auto [b, f] = std::ranges::mismatch(base, file);
  if (b != base.end() || f == file.end()) {
    why = "a path outside the asset's folder";
    return false;
  }
  if (!fs::is_regular_file(file, ec)) {
    why = "not a file";
    return false;
  }
  out = file;
  return true;
}

}  // namespace premation::plugins
