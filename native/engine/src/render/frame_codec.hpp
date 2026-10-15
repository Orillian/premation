// The disk cache's frame codec (disk_cache.hpp): zstd at a fast level when the
// build has it (frame_codec_zstd_ffi.cpp), stored as is when it does not
// (frame_codec_raw.cpp). A cached frame is RGBA8, and motion graphics frames are
// mostly flat colour — zstd makes them a fraction of their size and decodes at
// gigabytes a second, so a disk hit is a few milliseconds even at 4K.
//
// Thread-safe: each thread that calls these keeps its own compression context.
#pragma once

#include <cstdint>
#include <span>
#include <vector>

namespace premation::render::frame_codec {

/// The codec a file written now carries in its header.
/// zstd_strips: independent zstd strips, decoded in parallel (frame_codec_zstd_ffi.cpp).
enum class Codec : std::uint32_t { raw = 0, zstd = 1, zstd_strips = 2 };

/// What `compress` writes (zstd when the build has it).
[[nodiscard]] Codec preferred() noexcept;

/// `src` encoded with `preferred()` into `dst` (resized). False = not encoded
/// (the caller stores the frame raw).
bool compress(std::span<const std::uint8_t> src, std::vector<std::uint8_t>& dst);

/// `src` (encoded with `codec`) decoded into exactly `dst.size()` bytes. False
/// = a corrupt or truncated file, a size mismatch or a codec this build lacks.
bool decompress(Codec codec, std::span<const std::uint8_t> src, std::span<std::uint8_t> dst);

}  // namespace premation::render::frame_codec
