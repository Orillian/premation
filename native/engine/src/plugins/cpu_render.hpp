// One native plugin effect rendered on the CPU over the render graph's texels
// (G1) — the GPU-free half of the render glue (render_glue.cpp reads the
// chain's buffer and the checked-out layers back into TexelImages, calls this,
// and uploads `out`). Also what the host tests and tools render with.
//
// Every world is full-frame at the chain buffer's size, in the depth the
// effect processes in this project (PluginHost::world_format: AE's
// down-conversion — an 8-bit-only effect in a 32-bpc project gets 8-bit
// worlds). The conversions are world_convert.hpp's pure functions, so a frame
// renders identically every time.
#pragma once

#include <algorithm>
#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "host.hpp"
#include "world_convert.hpp"

namespace premation::plugins {

/// Tightly packed texels (rows top-down) in one of the graph's formats.
struct TexelImage {
  TexelFormat format = TexelFormat::rgba8;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::vector<std::uint8_t> bytes;
};

/// Worlds over TexelImages: checkout id → the image it reads (id 0 is the
/// effect's input by convention of the chain glue, but any id works — the
/// caller maps each CheckoutRequest to an image). A missing id checks out
/// empty (nullptr), as the SDK allows.
class TexelCheckouts final : public CheckoutSource {
 public:
  TexelCheckouts(PrPixelFormat format, std::uint32_t width, std::uint32_t height);
  void set(std::uint32_t checkoutId, const TexelImage& image);
  PrWorld* cpu_checkout(std::uint32_t checkoutId) override;
  PrWorld* cpu_output() override;
  const PrGpuWorld* gpu_checkout(std::uint32_t /*checkoutId*/) override { return nullptr; }
  [[nodiscard]] const PrWorld& output() const noexcept { return output_; }
  /// SDK 1.2 (S6): where checkout_scene_depth comes from — width × height floats, asked for when
  /// the plugin first calls it (nullptr / unset = none: PR_ERR_UNSUPPORTED).
  using DepthFn = std::function<const std::vector<float>*()>;
  void set_scene_depth(DepthFn fn) { depthFn_ = std::move(fn); }
  PrWorld* cpu_scene_depth() override;

 private:
  struct Slot {
    std::vector<std::uint8_t> bytes;
    PrWorld world{};
  };
  PrWorld make_world(std::vector<std::uint8_t>& bytes) const;
  PrPixelFormat format_;
  std::uint32_t width_;
  std::uint32_t height_;
  std::map<std::uint32_t, Slot> slots_;
  std::vector<std::uint8_t> outBytes_;
  PrWorld output_{};
  DepthFn depthFn_;
  std::optional<PrWorld> depth_;
};

/// Render inputs for `spec` with every param at its declared default: a
/// full-frame layer of w × h at identity placement, 30 fps, time 0.
[[nodiscard]] RenderInputs default_inputs(const EffectSpec& spec, std::string instance, std::uint32_t w, std::uint32_t h,
                                          std::uint32_t projectBits);
/// The index into RenderInputs::values of the param with SDK id `id`, or -1.
[[nodiscard]] int param_slot(const EffectSpec& spec, std::uint32_t id) noexcept;

/// Run `in`'s effect: SMART_PRE_RENDER for the checkouts it wants, `checkout`
/// supplies each (nullptr = empty), SMART_RENDER (or RENDER) into a world the
/// size of `input`, converted back to `input.format` in `out`. On failure `out`
/// is untouched and the result says why (a fault has disabled the instance).
using CheckoutImageFn = std::function<const TexelImage*(const CheckoutRequest&)>;
/// `depth` (SDK 1.2, S6): the scene depth checkout_scene_depth hands out (TexelCheckouts::DepthFn;
/// empty = none).
CallResult run_native_cpu(PluginHost& host, const RenderInputs& in, const TexelImage& input, const CheckoutImageFn& checkout,
                          TexelImage& out, const TexelCheckouts::DepthFn& depth = {});

}  // namespace premation::plugins
