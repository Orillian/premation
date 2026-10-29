// TIFF and DPX image-sequence frames (AE's TIFF / DPX/Cineon output modules).
//
// TIFF: baseline, uncompressed, one strip, little-endian RGBA with an
//   unassociated (straight) alpha — 8 or 16 bits per sample, the render's depth.
// DPX: SMPTE 268M v2.0, big-endian, one element of 10-bit RGB packed method A
//   (three samples per 32-bit word, filled from the top: R<<22 | G<<12 | B<<2),
//   Rec. 709 colorimetry — the film / finishing interchange form. DPX has no
//   alpha in this layout; the straight colour is written as it is.
//
// Inputs are the export writer's frames: straight RGBA8, or straight RGBA64
// little-endian integers at depth 16. Pure: no I/O.
#pragma once

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <span>
#include <string_view>
#include <vector>

namespace premation::exporter {

namespace tiff_detail {

inline void put16(std::vector<std::uint8_t>& b, std::size_t at, std::uint16_t v) {
  b[at] = static_cast<std::uint8_t>(v & 0xFF);
  b[at + 1] = static_cast<std::uint8_t>(v >> 8);
}
inline void put32(std::vector<std::uint8_t>& b, std::size_t at, std::uint32_t v) {
  for (int i = 0; i < 4; ++i) b[at + static_cast<std::size_t>(i)] = static_cast<std::uint8_t>((v >> (8 * i)) & 0xFF);
}

}  // namespace tiff_detail

/// One TIFF frame. `depth` 8 = `rgba` is RGBA8, 16 = RGBA64 (little-endian u16 samples).
[[nodiscard]] inline std::vector<std::uint8_t> encode_tiff_rgba(std::span<const std::uint8_t> rgba, std::uint32_t width,
                                                               std::uint32_t height, int depth) {
  using tiff_detail::put16;
  using tiff_detail::put32;
  const std::uint16_t bits = depth == 16 ? 16 : 8;
  const std::size_t bytesPerPixel = bits == 16 ? 8 : 4;
  const std::size_t dataBytes = std::size_t{width} * height * bytesPerPixel;
  constexpr std::uint16_t kEntries = 11;
  constexpr std::size_t kIfd = 8;
  const std::size_t ifdBytes = 2 + std::size_t{kEntries} * 12 + 4;
  const std::size_t bitsAt = kIfd + ifdBytes;  // BitsPerSample's four shorts
  const std::size_t dataAt = bitsAt + 8;
  std::vector<std::uint8_t> b(dataAt + dataBytes, 0);
  b[0] = 'I';
  b[1] = 'I';
  put16(b, 2, 42);
  put32(b, 4, static_cast<std::uint32_t>(kIfd));
  put16(b, kIfd, kEntries);
  std::size_t e = kIfd + 2;
  // tag, type (3 SHORT, 4 LONG), count, value — in ascending tag order.
  const auto entry = [&](std::uint16_t tag, std::uint16_t type, std::uint32_t count, std::uint32_t value) {
    put16(b, e, tag);
    put16(b, e + 2, type);
    put32(b, e + 4, count);
    if (type == 3 && count == 1) put16(b, e + 8, static_cast<std::uint16_t>(value));
    else put32(b, e + 8, value);
    e += 12;
  };
  entry(256, 4, 1, width);                                     // ImageWidth
  entry(257, 4, 1, height);                                    // ImageLength
  entry(258, 3, 4, static_cast<std::uint32_t>(bitsAt));        // BitsPerSample → offset
  entry(259, 3, 1, 1);                                         // Compression: none
  entry(262, 3, 1, 2);                                         // Photometric: RGB
  entry(273, 4, 1, static_cast<std::uint32_t>(dataAt));        // StripOffsets
  entry(277, 3, 1, 4);                                         // SamplesPerPixel
  entry(278, 4, 1, height);                                    // RowsPerStrip: one strip
  entry(279, 4, 1, static_cast<std::uint32_t>(dataBytes));     // StripByteCounts
  entry(284, 3, 1, 1);                                         // PlanarConfiguration: chunky
  entry(338, 3, 1, 2);                                         // ExtraSamples: unassociated alpha
  put32(b, e, 0);                                              // no next IFD
  for (int i = 0; i < 4; ++i) put16(b, bitsAt + static_cast<std::size_t>(i) * 2, bits);
  const std::size_t n = std::min(dataBytes, rgba.size());
  if (n > 0) std::memcpy(b.data() + dataAt, rgba.data(), n);
  return b;
}

namespace dpx_detail {

inline void be32(std::vector<std::uint8_t>& b, std::size_t at, std::uint32_t v) {
  b[at] = static_cast<std::uint8_t>(v >> 24);
  b[at + 1] = static_cast<std::uint8_t>((v >> 16) & 0xFF);
  b[at + 2] = static_cast<std::uint8_t>((v >> 8) & 0xFF);
  b[at + 3] = static_cast<std::uint8_t>(v & 0xFF);
}
inline void be16(std::vector<std::uint8_t>& b, std::size_t at, std::uint16_t v) {
  b[at] = static_cast<std::uint8_t>(v >> 8);
  b[at + 1] = static_cast<std::uint8_t>(v & 0xFF);
}
inline void text(std::vector<std::uint8_t>& b, std::size_t at, std::size_t len, std::string_view s) {
  for (std::size_t i = 0; i < len; ++i) b[at + i] = i < s.size() ? static_cast<std::uint8_t>(s[i]) : 0;
}
inline void bef(std::vector<std::uint8_t>& b, std::size_t at, float f) {
  std::uint32_t u = 0;
  std::memcpy(&u, &f, sizeof u);
  be32(b, at, u);
}

}  // namespace dpx_detail

/// One DPX frame, 10-bit RGB method A. `depth` as encode_tiff_rgba.
[[nodiscard]] inline std::vector<std::uint8_t> encode_dpx10_rgb(std::span<const std::uint8_t> rgba, std::uint32_t width,
                                                               std::uint32_t height, int depth) {
  using dpx_detail::be16;
  using dpx_detail::be32;
  using dpx_detail::bef;
  using dpx_detail::text;
  constexpr std::size_t kHeader = 2048;
  const std::size_t pixels = std::size_t{width} * height;
  std::vector<std::uint8_t> b(kHeader + pixels * 4, 0);
  // Fields the writer leaves undefined read as all ones (SMPTE 268M): the
  // orientation, film and television headers, and elements 2–8.
  std::memset(b.data() + 852, 0xFF, 1408 - 852);
  std::memset(b.data() + 1408, 0xFF, kHeader - 1408);
  // ── File information ──
  be32(b, 0, 0x53445058U);  // "SDPX": big-endian
  be32(b, 4, static_cast<std::uint32_t>(kHeader));
  text(b, 8, 8, "V2.0");
  be32(b, 16, static_cast<std::uint32_t>(b.size()));
  be32(b, 20, 1);     // ditto key: new frame
  be32(b, 24, 1664);  // generic header size
  be32(b, 28, 384);   // industry header size
  be32(b, 32, 0);     // user data
  text(b, 160, 100, "Premation");
  be32(b, 660, 0xFFFFFFFFU);  // no encryption
  // ── Image information ──
  be16(b, 768, 0);  // orientation: left to right, top to bottom
  be16(b, 770, 1);  // one element
  be32(b, 772, width);
  be32(b, 776, height);
  // Element 1 (offset 780, 72 bytes).
  be32(b, 780, 0);       // unsigned
  be32(b, 784, 0);       // reference low data code
  bef(b, 788, 0.0F);
  be32(b, 792, 1023);    // reference high data code
  bef(b, 796, 1.0F);
  b[800] = 50;           // descriptor: RGB
  b[801] = 6;            // transfer: ITU-R 709-4
  b[802] = 6;            // colorimetric: ITU-R 709-4
  b[803] = 10;           // bit size
  be16(b, 804, 1);       // packing: method A (filled to 32-bit words)
  be16(b, 806, 0);       // no encoding
  be32(b, 808, static_cast<std::uint32_t>(kHeader));
  be32(b, 812, 0);       // end-of-line padding
  be32(b, 816, 0);       // end-of-image padding
  text(b, 820, 32, "RGB 10-bit");
  // ── Pixels ──
  const bool deep = depth == 16;
  const std::size_t stride = deep ? 8 : 4;
  for (std::size_t i = 0; i < pixels && (i + 1) * stride <= rgba.size(); ++i) {
    std::array<std::uint32_t, 3> c{};
    for (std::size_t k = 0; k < 3; ++k) {
      if (deep) {
        const std::uint32_t v = rgba[i * 8 + k * 2] | (std::uint32_t{rgba[i * 8 + k * 2 + 1]} << 8);
        c[k] = (v * 1023U + 32767U) / 65535U;
      } else {
        c[k] = (std::uint32_t{rgba[i * 4 + k]} * 1023U + 127U) / 255U;
      }
    }
    be32(b, kHeader + i * 4, (c[0] << 22) | (c[1] << 12) | (c[2] << 2));
  }
  return b;
}

}  // namespace premation::exporter
