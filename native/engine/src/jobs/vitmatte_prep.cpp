#include "vitmatte.hpp"

#include <cstddef>

namespace premation::jobs::vitmatte {

std::vector<float> prepare_input(std::span<const std::uint8_t> rgba, std::span<const float> trimap, int width, int height, int& padW,
                                 int& padH) {
  padW = (width + kMultiple - 1) / kMultiple * kMultiple;
  padH = (height + kMultiple - 1) / kMultiple * kMultiple;
  const std::size_t plane = static_cast<std::size_t>(padW) * static_cast<std::size_t>(padH);
  std::vector<float> out(plane * 4, 0.0f);
  const std::size_t n = static_cast<std::size_t>(width) * static_cast<std::size_t>(height);
  if (width <= 0 || height <= 0 || rgba.size() < n * 4 || trimap.size() < n) return out;
  for (int y = 0; y < height; ++y)
    for (int x = 0; x < width; ++x) {
      const std::size_t s = static_cast<std::size_t>(y) * static_cast<std::size_t>(width) + static_cast<std::size_t>(x);
      const std::size_t d = static_cast<std::size_t>(y) * static_cast<std::size_t>(padW) + static_cast<std::size_t>(x);
      for (std::size_t c = 0; c < 3; ++c) out[c * plane + d] = (rgba[s * 4 + c] / 255.0f - 0.5f) / 0.5f;
      out[3 * plane + d] = trimap[s];
    }
  return out;
}

}  // namespace premation::jobs::vitmatte
