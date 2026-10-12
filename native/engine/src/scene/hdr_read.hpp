// Radiance `.hdr` (RGBE) reader — E7 of docs/PROGRAM_3D_PERF_UX.md: the second
// HDR environment input beside EXR (exr_read.hpp). Decodes the "#?RADIANCE" /
// "#?RGBE" header (FORMAT=32-bit_rle_rgbe; EXPOSURE, GAMMA and other header
// lines are read past), the resolution string (every orientation: the planes
// come out top-down, left-to-right), and the scanlines in all three codings a
// .hdr file may use — new-style per-channel RLE (0x02 0x02 hi lo), old-style
// RLE (1 1 1 count repeats) and flat pixels — into linear float RGBA (alpha 1),
// the same `FloatRgba` layout the EXR path hands the sky projection.
//
// Pure (no I/O): bytes in, planes out; a malformed file is refused with its
// reason. Deterministic.
#pragma once

#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace premation::scene::hdr {

struct FloatRgba {
  int width = 0;
  int height = 0;
  /// width × height × 4 linear floats, rows top-down, alpha 1.
  std::vector<float> rgba;
};

/// Whether `bytes` start like a Radiance file ("#?RADIANCE" or "#?RGBE").
[[nodiscard]] bool looks_like_hdr(std::span<const std::uint8_t> bytes) noexcept;

/// Decode a Radiance RGBE file. Null (with `error`) when the header or a
/// scanline is malformed. `exposure` is a gain in stops applied to the result
/// (the file's own EXPOSURE header lines are NOT applied: Radiance tools treat
/// them as display hints, and the EXR path takes the planes as stored too).
[[nodiscard]] std::optional<FloatRgba> decode(std::span<const std::uint8_t> bytes, std::string& error, double exposure = 0);

/// One RGBE quadruple → linear RGB (Radiance's `colr_color`: mantissa / 256 · 2^(e − 128)).
void rgbe_to_float(std::uint8_t r, std::uint8_t g, std::uint8_t b, std::uint8_t e, float& fr, float& fg, float& fb) noexcept;

}  // namespace premation::scene::hdr
