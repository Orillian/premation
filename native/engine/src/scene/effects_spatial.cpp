#include "effects_spatial.hpp"

namespace premation::scene {

// The branches live in three files (effects_spatial_a.cpp: snapshotToFrameScene.ts
// up to 'rolling-shutter'; effects_spatial_b.cpp: 'card-dance' onwards;
// effects_spatial_c.cpp: the sixty effects of program E, 2026-10-10;
// effects_spatial_x.cpp: the deep effects of program X, 2026-10-19).
bool is_more_spatial(std::string_view type) {
  return spatial_a_handles(type) || spatial_b_handles(type) || spatial_c_handles(type) || spatial_x_handles(type);
}

bool extract_more_spatial(const Json& e, const Json& params, const RLayer& layer, std::vector<api::RenderEffect>& out) {
  return spatial_a(e, params, layer, out) || spatial_b(e, params, layer, out) || spatial_c(e, params, layer, out) ||
         spatial_x(e, params, layer, out);
}

}  // namespace premation::scene
