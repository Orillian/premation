// Layer styles for the scene builder — src/core/effects/layerStyles.ts
// `layerStylesToEffects(styles, globalAngle, globalAltitude, animated)`: the
// layer's fx.layerStyles compiled to the structured effects the renderer draws
// (drop shadow, outer glow, inner shadow / glow, satin, bevel, overlays,
// stroke …), with their stable ids (`layerstyle:<key>`) so their keyframed
// params animate through the ordinary `effect.<id>.<key>` tracks.
#pragma once

#include <functional>
#include <string_view>
#include <vector>

#include "scene_types.hpp"

namespace premation::scene {

/// The compiled style effects, in the TypeScript's order (empty for no styles).
/// Every style the document can hold compiles: drop / inner shadow, outer /
/// inner glow, satin, bevel, colour / gradient overlay, stroke.
[[nodiscard]] std::vector<Json> layer_styles_to_effects(const Json& styles, double globalAngle, double globalAltitude,
                                                        const std::function<bool(std::string_view)>& animated);

}  // namespace premation::scene
