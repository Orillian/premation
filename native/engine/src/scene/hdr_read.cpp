#include "hdr_read.hpp"

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdlib>
#include <string_view>

namespace premation::scene::hdr {
namespace {

constexpr std::size_t kMaxSide = 32768;  // a 32k × 32k float RGBA sky is 16 GiB: refuse anything past it

/// A byte cursor over the file: header lines, then pixel bytes.
class Cursor {
 public:
  explicit Cursor(std::span<const std::uint8_t> b) noexcept : b_(b) {}
  [[nodiscard]] bool at_end() const noexcept { return at_ >= b_.size(); }
  [[nodiscard]] std::size_t left() const noexcept { return b_.size() - at_; }
  /// The next byte (0 past the end — callers check `at_end` first).
  std::uint8_t take() noexcept { return at_ < b_.size() ? b_[at_++] : 0; }
  [[nodiscard]] std::uint8_t peek(std::size_t ahead = 0) const noexcept { return at_ + ahead < b_.size() ? b_[at_ + ahead] : 0; }
  /// One header line without its '\n' (a '\r' before it is dropped too); nullopt at the end.
  std::optional<std::string> line() noexcept {
    if (at_end()) return std::nullopt;
    std::string s;
    while (!at_end()) {
      const char c = static_cast<char>(take());
      if (c == '\n') break;
      s.push_back(c);
    }
    if (!s.empty() && s.back() == '\r') s.pop_back();
    return s;
  }

 private:
  std::span<const std::uint8_t> b_;
  std::size_t at_ = 0;
};

/// The resolution string: two axis words, each a sign, an axis letter and a
/// count. Standard files say "-Y <h> +X <w>" (rows top-down, pixels left to
/// right); the other seven orientations are read and the planes turned upright.
struct Resolution {
  std::size_t width = 0;
  std::size_t height = 0;
  bool rowsFirstY = true;  ///< the first axis word is Y (scanlines run along X)
  bool yDown = true;       ///< -Y: the first scanline is the top row
  bool xRight = true;      ///< +X: the first pixel of a scanline is the left one
};

std::optional<Resolution> parse_resolution(const std::string& s, std::string& error) {
  // Four tokens: <sign><axis> <count> <sign><axis> <count>.
  std::array<std::string, 4> tok;
  std::size_t n = 0;
  std::string cur;
  for (const char c : s + " ") {
    if (c == ' ' || c == '\t') {
      if (!cur.empty()) {
        if (n < 4) tok.at(n) = cur;
        ++n;
        cur.clear();
      }
    } else {
      cur.push_back(c);
    }
  }
  if (n != 4 || tok[0].size() != 2 || tok[2].size() != 2) {
    error = "HDR: the resolution line is not '<sign><axis> <count> <sign><axis> <count>'";
    return std::nullopt;
  }
  const auto count = [&](const std::string& t) -> std::optional<std::size_t> {
    if (t.empty()) return std::nullopt;
    for (const char c : t) {
      if (c < '0' || c > '9') return std::nullopt;
    }
    const unsigned long long v = std::strtoull(t.c_str(), nullptr, 10);
    if (v == 0 || v > kMaxSide) return std::nullopt;
    return static_cast<std::size_t>(v);
  };
  const auto a = count(tok[1]);
  const auto b = count(tok[3]);
  if (!a || !b) {
    error = "HDR: a resolution count is missing, zero or past " + std::to_string(kMaxSide);
    return std::nullopt;
  }
  Resolution r;
  const char ax0 = tok[0][1];
  const char ax1 = tok[2][1];
  const char sg0 = tok[0][0];
  const char sg1 = tok[2][0];
  if ((sg0 != '+' && sg0 != '-') || (sg1 != '+' && sg1 != '-')) {
    error = "HDR: a resolution axis has no sign";
    return std::nullopt;
  }
  if (ax0 == 'Y' && ax1 == 'X') {
    r.rowsFirstY = true;
    r.height = *a;
    r.width = *b;
    r.yDown = sg0 == '-';
    r.xRight = sg1 == '+';
  } else if (ax0 == 'X' && ax1 == 'Y') {
    // Column-major files: the "scanlines" run along Y.
    r.rowsFirstY = false;
    r.width = *a;
    r.height = *b;
    r.xRight = sg0 == '+';
    r.yDown = sg1 == '-';
  } else {
    error = "HDR: the resolution axes are not X and Y";
    return std::nullopt;
  }
  return r;
}

/// One scanline of `n` RGBE pixels into `out` (n × 4 bytes). False (with
/// `error`) on a truncated or malformed run.
bool read_scanline(Cursor& c, std::size_t n, std::vector<std::uint8_t>& out, std::string& error) {
  out.resize(n * 4);
  // New-style RLE: 0x02 0x02 <hi> <lo> with the scanline length, then each of
  // the four channels run-length coded on its own. Only for 8 ≤ n < 32768.
  if (n >= 8 && n < 32768 && c.left() >= 4 && c.peek(0) == 2 && c.peek(1) == 2 && (c.peek(2) & 0x80U) == 0) {
    const std::size_t len = (static_cast<std::size_t>(c.peek(2)) << 8U) | c.peek(3);
    if (len != n) {
      error = "HDR: a scanline header says " + std::to_string(len) + " pixels in a " + std::to_string(n) + "-pixel row";
      return false;
    }
    (void)c.take();
    (void)c.take();
    (void)c.take();
    (void)c.take();
    for (std::size_t ch = 0; ch < 4; ++ch) {
      std::size_t i = 0;
      while (i < n) {
        if (c.at_end()) {
          error = "HDR: a scanline ends early";
          return false;
        }
        const std::uint8_t code = c.take();
        if (code > 128) {
          const std::size_t run = code - 128U;
          if (c.at_end() || i + run > n) {
            error = "HDR: a run passes the end of its scanline";
            return false;
          }
          const std::uint8_t v = c.take();
          for (std::size_t k = 0; k < run; ++k) out[(i + k) * 4 + ch] = v;
          i += run;
        } else {
          const std::size_t run = code;
          if (run == 0 || i + run > n || c.left() < run) {
            error = "HDR: a literal run is empty or passes the end of its scanline";
            return false;
          }
          for (std::size_t k = 0; k < run; ++k) out[(i + k) * 4 + ch] = c.take();
          i += run;
        }
      }
    }
    return true;
  }
  // Flat pixels, with the old-style repeat code (1, 1, 1, count): the previous
  // pixel again `count << (8 · shift)` times.
  std::size_t i = 0;
  int shift = 0;
  while (i < n) {
    if (c.left() < 4) {
      error = "HDR: a scanline ends early";
      return false;
    }
    const std::uint8_t r = c.take();
    const std::uint8_t g = c.take();
    const std::uint8_t b = c.take();
    const std::uint8_t e = c.take();
    if (r == 1 && g == 1 && b == 1) {
      if (i == 0 || shift > 24) {
        error = "HDR: a repeat code with nothing to repeat";
        return false;
      }
      const std::size_t count = static_cast<std::size_t>(e) << static_cast<unsigned>(shift);
      if (i + count > n) {
        error = "HDR: a repeat passes the end of its scanline";
        return false;
      }
      for (std::size_t k = 0; k < count; ++k) {
        for (std::size_t ch = 0; ch < 4; ++ch) out[(i + k) * 4 + ch] = out[(i - 1) * 4 + ch];
      }
      i += count;
      shift += 8;
      continue;
    }
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = e;
    ++i;
    shift = 0;
  }
  return true;
}

}  // namespace

bool looks_like_hdr(std::span<const std::uint8_t> bytes) noexcept {
  const std::string_view s(reinterpret_cast<const char*>(bytes.data()), bytes.size());  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  return s.starts_with("#?RADIANCE") || s.starts_with("#?RGBE");
}

void rgbe_to_float(std::uint8_t r, std::uint8_t g, std::uint8_t b, std::uint8_t e, float& fr, float& fg, float& fb) noexcept {
  if (e == 0) {
    fr = fg = fb = 0.0F;
    return;
  }
  // Radiance: v = (mantissa + 0.5) / 256 · 2^(e − 128) in the reference; the
  // common readers (and the files' writers) use mantissa / 256. Mantissa / 256
  // round-trips the writer's frexp exactly, so it is what we read.
  const float f = std::ldexp(1.0F, static_cast<int>(e) - (128 + 8));
  fr = static_cast<float>(r) * f;
  fg = static_cast<float>(g) * f;
  fb = static_cast<float>(b) * f;
}

std::optional<FloatRgba> decode(std::span<const std::uint8_t> bytes, std::string& error, double exposure) {
  error.clear();
  if (!looks_like_hdr(bytes)) {
    error = "HDR: not a Radiance file (no #?RADIANCE / #?RGBE signature)";
    return std::nullopt;
  }
  Cursor c(bytes);
  (void)c.line();  // the signature
  // Header lines up to the blank one. FORMAT must be RGBE (XYZE is not read).
  bool formatOk = true;
  for (;;) {
    const std::optional<std::string> l = c.line();
    if (!l) {
      error = "HDR: the header never ends";
      return std::nullopt;
    }
    if (l->empty()) break;
    if (l->starts_with("FORMAT=")) formatOk = l->find("32-bit_rle_rgbe") != std::string::npos;
  }
  if (!formatOk) {
    error = "HDR: FORMAT is not 32-bit_rle_rgbe (XYZE files are not read)";
    return std::nullopt;
  }
  const std::optional<std::string> resLine = c.line();
  if (!resLine) {
    error = "HDR: no resolution line";
    return std::nullopt;
  }
  const std::optional<Resolution> res = parse_resolution(*resLine, error);
  if (!res) return std::nullopt;
  const std::size_t w = res->width;
  const std::size_t h = res->height;
  if (w * h > std::size_t{1} << 30U) {
    error = "HDR: " + std::to_string(w) + " × " + std::to_string(h) + " is too large";
    return std::nullopt;
  }
  FloatRgba out;
  out.width = static_cast<int>(w);
  out.height = static_cast<int>(h);
  out.rgba.assign(w * h * 4, 1.0F);
  const float gain = static_cast<float>(std::pow(2.0, exposure));
  std::vector<std::uint8_t> line;
  // Scanlines run along X in row-major files (one per row), along Y in
  // column-major ones (one per column); the sign of each axis says where the
  // first one lands.
  const std::size_t lines = res->rowsFirstY ? h : w;
  const std::size_t perLine = res->rowsFirstY ? w : h;
  for (std::size_t li = 0; li < lines; ++li) {
    if (!read_scanline(c, perLine, line, error)) return std::nullopt;
    for (std::size_t pi = 0; pi < perLine; ++pi) {
      std::size_t x = 0;
      std::size_t y = 0;
      if (res->rowsFirstY) {
        y = res->yDown ? li : h - 1 - li;
        x = res->xRight ? pi : w - 1 - pi;
      } else {
        x = res->xRight ? li : w - 1 - li;
        y = res->yDown ? pi : h - 1 - pi;
      }
      float r = 0;
      float g = 0;
      float b = 0;
      rgbe_to_float(line[pi * 4], line[pi * 4 + 1], line[pi * 4 + 2], line[pi * 4 + 3], r, g, b);
      const std::size_t o = (y * w + x) * 4;
      out.rgba[o] = r * gain;
      out.rgba[o + 1] = g * gain;
      out.rgba[o + 2] = b * gain;
    }
  }
  return out;
}

}  // namespace premation::scene::hdr
