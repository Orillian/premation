// frame_codec.hpp on zstd (the vcpkg port libktx already pulls in; listed in
// the engine feature of native/vcpkg.json). The only file that calls zstd.
//
// A frame is packed as independent STRIPS (Codec::zstd_strips): zstd decodes
// one stream serially at about a gigabyte a second, which is ~7 ms for a
// 1080p frame — slower than drawing many comps. Strips decode in parallel, so
// a disk hit costs a fraction of that; the size on disk barely changes.
//
//   payload = u32 count, count × u64 packed size, then the strips back to back.
//   Strip i decodes to bytes [i × raw / count, (i + 1) × raw / count) of the frame.
#include <zstd.h>

#include <algorithm>
#include <array>
#include <cstring>
#include <future>
#include <memory>
#include <thread>

#include "frame_codec.hpp"

namespace premation::render::frame_codec {
namespace {

/// Level 1: a frame of flat colour compresses at well over a gigabyte a
/// second; footage (noise) still halves. The writer thread does this, never
/// the render thread.
constexpr int kLevel = 1;
/// A strip per this many raw bytes (a 1080p frame: 8 strips), at most kMaxStrips.
constexpr std::size_t kStripBytes = std::size_t{1024} * 1024;
constexpr std::uint32_t kMaxStrips = 32;

struct CCtxFree {
  void operator()(ZSTD_CCtx* c) const noexcept { ZSTD_freeCCtx(c); }
};
struct DCtxFree {
  void operator()(ZSTD_DCtx* d) const noexcept { ZSTD_freeDCtx(d); }
};

ZSTD_CCtx* cctx() {
  // One per thread, reused: creating a context allocates its tables.
  thread_local std::unique_ptr<ZSTD_CCtx, CCtxFree> c{ZSTD_createCCtx()};
  if (c) {
    (void)ZSTD_CCtx_setParameter(c.get(), ZSTD_c_compressionLevel, kLevel);
    // A bad sector or a torn write is caught on read, not drawn.
    (void)ZSTD_CCtx_setParameter(c.get(), ZSTD_c_checksumFlag, 1);
  }
  return c.get();
}

ZSTD_DCtx* dctx() {
  thread_local std::unique_ptr<ZSTD_DCtx, DCtxFree> d{ZSTD_createDCtx()};
  return d.get();
}

bool decode_one(std::span<const std::uint8_t> src, std::span<std::uint8_t> dst) {
  ZSTD_DCtx* d = dctx();
  if (d == nullptr) return false;
  const std::size_t n = ZSTD_decompressDCtx(d, dst.data(), dst.size(), src.data(), src.size());
  return ZSTD_isError(n) == 0U && n == dst.size();
}

std::size_t strip_begin(std::size_t raw, std::uint32_t count, std::uint32_t i) {
  return raw / count * i + std::min<std::size_t>(i, raw % count);
}

template <class T>
void put(std::span<std::uint8_t> out, std::size_t at, T v) {
  std::memcpy(out.subspan(at, sizeof v).data(), &v, sizeof v);
}
template <class T>
T get(std::span<const std::uint8_t> in, std::size_t at) {
  T v{};
  std::memcpy(&v, in.subspan(at, sizeof v).data(), sizeof v);
  return v;
}

}  // namespace

Codec preferred() noexcept { return Codec::zstd_strips; }

bool compress(std::span<const std::uint8_t> src, std::vector<std::uint8_t>& dst) {
  ZSTD_CCtx* c = cctx();
  if (c == nullptr || src.empty()) return false;
  const auto count = static_cast<std::uint32_t>(std::clamp<std::size_t>(src.size() / kStripBytes, 1, kMaxStrips));
  const std::size_t table = sizeof(std::uint32_t) + std::size_t{count} * sizeof(std::uint64_t);
  dst.resize(table + ZSTD_compressBound(src.size()) + std::size_t{count} * 64U);
  put<std::uint32_t>(dst, 0, count);
  std::size_t at = table;
  for (std::uint32_t i = 0; i < count; ++i) {
    const std::size_t b = strip_begin(src.size(), count, i);
    const std::size_t e = strip_begin(src.size(), count, i + 1);
    const std::span<std::uint8_t> room = std::span<std::uint8_t>(dst).subspan(at);
    const std::span<const std::uint8_t> strip = src.subspan(b, e - b);
    const std::size_t n = ZSTD_compress2(c, room.data(), room.size(), strip.data(), strip.size());
    if (ZSTD_isError(n) != 0U) return false;
    put<std::uint64_t>(dst, sizeof(std::uint32_t) + std::size_t{i} * sizeof(std::uint64_t), n);
    at += n;
  }
  dst.resize(at);
  return true;
}

bool decompress(Codec codec, std::span<const std::uint8_t> src, std::span<std::uint8_t> dst) {
  if (codec == Codec::raw) {
    if (src.size() != dst.size()) return false;
    std::memcpy(dst.data(), src.data(), dst.size());
    return true;
  }
  if (codec == Codec::zstd) return decode_one(src, dst);
  if (codec != Codec::zstd_strips || src.size() < sizeof(std::uint32_t)) return false;
  const auto count = get<std::uint32_t>(src, 0);
  const std::size_t table = sizeof(std::uint32_t) + std::size_t{count} * sizeof(std::uint64_t);
  if (count == 0 || count > kMaxStrips || src.size() < table) return false;
  // Where each strip's packed bytes are, checked against the payload before anything decodes.
  struct Strip {
    std::span<const std::uint8_t> in;
    std::span<std::uint8_t> out;
  };
  std::array<Strip, kMaxStrips> storage{};
  const std::span<Strip> strips = std::span(storage).first(count);
  std::size_t at = table;
  for (std::uint32_t i = 0; i < count; ++i) {
    const auto n = get<std::uint64_t>(src, sizeof(std::uint32_t) + std::size_t{i} * sizeof(std::uint64_t));
    if (n > src.size() - at) return false;
    const std::size_t b = strip_begin(dst.size(), count, i);
    const std::size_t e = strip_begin(dst.size(), count, i + 1);
    strips[i] = Strip{.in = src.subspan(at, static_cast<std::size_t>(n)), .out = dst.subspan(b, e - b)};
    at += static_cast<std::size_t>(n);
  }
  if (at != src.size()) return false;
  // The strips in parallel: this thread takes the first, the others go to
  // std::async (a pooled thread on Windows' STL; a short-lived one elsewhere).
  std::array<std::future<bool>, kMaxStrips> pending{};
  const std::span<std::future<bool>> rest = std::span(pending).first(count);
  for (std::uint32_t i = 1; i < count; ++i) {
    rest[i] = std::async(std::launch::async, [s = strips[i]] { return decode_one(s.in, s.out); });
  }
  bool ok = decode_one(strips[0].in, strips[0].out);
  for (std::uint32_t i = 1; i < count; ++i) ok = rest[i].get() && ok;
  return ok;
}

}  // namespace premation::render::frame_codec
