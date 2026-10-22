// The effect chain's cache keys, shared by the 2D layer path (composition_pass.cpp)
// and the 3D surface path (threed.cpp):
//
//   * `chain_content_key` (E4): what a layer's chain INPUT is drawn from — its
//     textures by content hash, placement, colour, opacity, motion samples and
//     the viewport. Equal keys promise equal input pixels.
//   * `layer_fx_key` (P8): the key of the chain's whole RESULT — the content key
//     plus every parameter of every entry and the renderer switches that choose
//     the chain's passes. 0 when the chain is not a pure function of those (it
//     reads another layer, a data texture, or runs a native plugin).
//
// KeyMix is the 64-bit mix both are built with (multiply-xorshift; not
// cryptographic; never yields 0, which means "no key").
#pragma once

#include <array>
#include <bit>
#include <cstdint>
#include <optional>
#include <string_view>

#include "render_context.hpp"

namespace premation::rg {

class KeyMix {
 public:
  void u64(std::uint64_t v) noexcept {
    h_ ^= v * 0x9e3779b97f4a7c15ULL;
    h_ = std::rotl(h_, 27) * 0xc2b2ae3d27d4eb4fULL + 0x165667b19e3779f9ULL;
  }
  void f64(double v) noexcept { u64(std::bit_cast<std::uint64_t>(v)); }
  void str(std::string_view s) noexcept {
    u64(s.size());
    for (const char c : s) u64(static_cast<unsigned char>(c));
  }
  [[nodiscard]] std::uint64_t value() const noexcept {
    std::uint64_t x = h_;
    x ^= x >> 33U;
    x *= 0xff51afd7ed558ccdULL;
    x ^= x >> 33U;
    return x | 1U;  // never 0 (= no key)
  }

 private:
  std::uint64_t h_ = 0x243f6a8885a308d3ULL;
};

/// 0 where the input is not a function of the hashed fields (a precomp's
/// offscreen, an unresolved texture, a deformed mesh). `placePhase` (P8b)
/// leaves the layer's place on screen out of the key but its sub-pixel phase
/// (the fraction of its buffer placement, in viewport px): the input is drawn
/// at that phase, so only a whole-pixel move keeps it.
[[nodiscard]] std::uint64_t chain_content_key(const PassContext& ctx, const api::Renderable& r, double opacity,
                                              std::optional<std::array<double, 2>> placePhase = std::nullopt);

/// `contentKey` 0 → 0. Mixes in `r.effects` (every parameter), the renderer's
/// chain switches, and the project's precision and working space.
[[nodiscard]] std::uint64_t layer_fx_key(const PassContext& ctx, const api::Renderable& r, std::uint64_t contentKey,
                                         double opacity);

}  // namespace premation::rg
