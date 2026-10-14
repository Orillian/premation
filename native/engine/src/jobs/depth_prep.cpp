// The depth model's pure pre / post-processing (depth_ort.hpp, camera program
// D3): no runtime, so the job core (and its tests) carry it.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <span>
#include <vector>

#include "depth_ort.hpp"

namespace premation::jobs {

// ── the pure halves (depth_ort.hpp) ─────────────────────────────────────────

namespace depth {

std::vector<float> prepare_input(std::span<const std::uint8_t> rgba, std::uint32_t w, std::uint32_t h) {
  constexpr std::size_t kPlane = std::size_t{kInput} * kInput;
  std::vector<float> out(kPlane * 3, 0.0F);
  if (w == 0 || h == 0 || rgba.size() < std::size_t{w} * h * 4) return out;
  constexpr std::array<float, 3> kMean{0.485F, 0.456F, 0.406F};
  constexpr std::array<float, 3> kStd{0.229F, 0.224F, 0.225F};
  const auto px = [&](std::uint32_t x, std::uint32_t y, std::size_t c) {
    return static_cast<float>(rgba[(std::size_t{y} * w + x) * 4 + c]) / 255.0F;
  };
  for (std::uint32_t j = 0; j < kInput; ++j) {
    const double sy = std::clamp((j + 0.5) * h / kInput - 0.5, 0.0, h - 1.0);
    const auto y0 = static_cast<std::uint32_t>(sy);
    const std::uint32_t y1 = std::min(y0 + 1, h - 1);
    const auto fy = static_cast<float>(sy - y0);
    for (std::uint32_t i = 0; i < kInput; ++i) {
      const double sx = std::clamp((i + 0.5) * w / kInput - 0.5, 0.0, w - 1.0);
      const auto x0 = static_cast<std::uint32_t>(sx);
      const std::uint32_t x1 = std::min(x0 + 1, w - 1);
      const auto fx = static_cast<float>(sx - x0);
      for (std::size_t c = 0; c < 3; ++c) {
        const float top = px(x0, y0, c) + (px(x1, y0, c) - px(x0, y0, c)) * fx;
        const float bot = px(x0, y1, c) + (px(x1, y1, c) - px(x0, y1, c)) * fx;
        const float v = top + (bot - top) * fy;
        out[c * kPlane + std::size_t{j} * kInput + i] = (v - kMean.at(c)) / kStd.at(c);
      }
    }
  }
  return out;
}

std::vector<std::uint8_t> depth_to_gray(std::span<const float> d, std::uint32_t outW, std::uint32_t outH) {
  std::vector<std::uint8_t> out(std::size_t{outW} * outH * 4, 255);
  if (d.size() < std::size_t{kInput} * kInput || outW == 0 || outH == 0) return out;
  float lo = d[0];
  float hi = d[0];
  for (const float v : d) {
    if (!std::isfinite(v)) continue;
    lo = std::min(lo, v);
    hi = std::max(hi, v);
  }
  const float range = hi - lo;
  const auto at = [&](double u, double v) {
    const double sx = std::clamp(u * kInput - 0.5, 0.0, kInput - 1.0);
    const double sy = std::clamp(v * kInput - 0.5, 0.0, kInput - 1.0);
    const auto x0 = static_cast<std::uint32_t>(sx);
    const auto y0 = static_cast<std::uint32_t>(sy);
    const std::uint32_t x1 = std::min(x0 + 1, kInput - 1);
    const std::uint32_t y1 = std::min(y0 + 1, kInput - 1);
    const double fx = sx - x0;
    const double fy = sy - y0;
    const auto s = [&](std::uint32_t x, std::uint32_t y) {
      const float vv = d[std::size_t{y} * kInput + x];
      return std::isfinite(vv) ? static_cast<double>(vv) : static_cast<double>(lo);
    };
    const double top = s(x0, y0) + (s(x1, y0) - s(x0, y0)) * fx;
    const double bot = s(x0, y1) + (s(x1, y1) - s(x0, y1)) * fx;
    return top + (bot - top) * fy;
  };
  for (std::uint32_t y = 0; y < outH; ++y) {
    for (std::uint32_t x = 0; x < outW; ++x) {
      const double raw = at((x + 0.5) / outW, (y + 0.5) / outH);
      // Relative INVERSE depth: larger = nearer = whiter.
      const double g = range > 1e-12F ? (raw - lo) / range : 0.5;
      const auto b = static_cast<std::uint8_t>(std::clamp(std::lround(g * 255), 0L, 255L));
      const std::size_t k = (std::size_t{y} * outW + x) * 4;
      out[k] = b;
      out[k + 1] = b;
      out[k + 2] = b;
      out[k + 3] = 255;
    }
  }
  return out;
}

}  // namespace depth

}  // namespace premation::jobs
