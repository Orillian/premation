// frame_codec.hpp without zstd: frames are stored as they are (and a zstd file
// written by another build reads as a miss).
#include <cstring>

#include "frame_codec.hpp"

namespace premation::render::frame_codec {

Codec preferred() noexcept { return Codec::raw; }

bool compress(std::span<const std::uint8_t> /*src*/, std::vector<std::uint8_t>& /*dst*/) { return false; }

bool decompress(Codec codec, std::span<const std::uint8_t> src, std::span<std::uint8_t> dst) {
  if (codec != Codec::raw || src.size() != dst.size()) return false;
  std::memcpy(dst.data(), src.data(), dst.size());
  return true;
}

}  // namespace premation::render::frame_codec
