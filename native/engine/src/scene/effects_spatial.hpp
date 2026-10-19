// The rest of `extractSpatialEffects` (src/core/rendering/snapshotToFrameScene.ts):
// every GPU effect kind beyond the eight effects_port.cpp writes itself (blur,
// glow, drop-shadow, gradient-ramp, fill, stroke, sharpen, noise), each ported
// branch for branch into its FrameScene chain entry (api::RenderEffect, the
// frameSceneExport.ts `effectToWire` encoding — see FxWriter).
#pragma once

#include <string>
#include <string_view>
#include <vector>

#include "engine_api.hpp"
#include "scene_types.hpp"

namespace premation::scene {

/// True when `extract_more_spatial` writes this effect type.
[[nodiscard]] bool is_more_spatial(std::string_view type);

/// Append the chain entries of one ENABLED effect `e` whose type
/// `is_more_spatial`; `params` is `paramsOf(e)` (declared defaults ← legacy
/// amount ← stored params). Returns false when the type is not handled here.
bool extract_more_spatial(const Json& e, const Json& params, const RLayer& layer, std::vector<api::RenderEffect>& out);

// The parts (effects_spatial_a.cpp, effects_spatial_b.cpp, effects_spatial_c.cpp), same contract.
[[nodiscard]] bool spatial_a_handles(std::string_view type);
bool spatial_a(const Json& e, const Json& params, const RLayer& layer, std::vector<api::RenderEffect>& out);
[[nodiscard]] bool spatial_b_handles(std::string_view type);
bool spatial_b(const Json& e, const Json& params, const RLayer& layer, std::vector<api::RenderEffect>& out);
[[nodiscard]] bool spatial_c_handles(std::string_view type);
bool spatial_c(const Json& e, const Json& params, const RLayer& layer, std::vector<api::RenderEffect>& out);
/// Program X (effects_spatial_x.cpp): the deep effects, each an `fx-graph` entry.
[[nodiscard]] bool spatial_x_handles(std::string_view type);
bool spatial_x(const Json& e, const Json& params, const RLayer& layer, std::vector<api::RenderEffect>& out);
/// Program X: a texture a deep effect reads — a raster of one mask path
/// (`mask` = {paths: [...]}) or a table of floats (`floats`, when `mask` is not
/// an object), under the key its fx-graph entry names.
struct DeepFxTexture {
  std::string key;
  Json mask;
  std::vector<float> floats;
};
/// The textures the layer's deep effects read this frame (frame_build.cpp).
[[nodiscard]] std::vector<DeepFxTexture> deep_effect_textures(const RLayer& l);
/// Program X: a deep effect whose pixels move with the layer clock (`time`).
[[nodiscard]] bool deep_effect_follows_clock(std::string_view type);

}  // namespace premation::scene
