// Plugin SDK: the composition's camera, lights and layer world matrices read
// straight off the document at a time — what a plugin's get_comp_camera /
// get_comp_lights / get_layer_transform answer when there is no built frame to
// read them from: the SDK 1.2 checkout_time samples (scene_finish.cpp) and the
// viewer overlay (DRAW_OVERLAY / OVERLAY_DRAG at the viewer's time).
//
// The same reads the frame's own 3D setup makes (threed_port.cpp Scene3D):
// the topmost visible camera live at the time, the comp's lights through the
// light readers (lights3d.hpp), world matrices with parenting and expressions.
// Never a whole frame. Every answer is kept per (time), so many effects asking
// for the same times pay once. Core thread (it reads the document).
#pragma once

#include <map>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "engine_api.hpp"
#include "native_effects.hpp"
#include "transform.hpp"
#include "worldxf.hpp"

namespace premation::plugins {

struct EffectSpec;

class SceneEval {
 public:
  /// `comp`: the composition whose camera and lights are read (its root node id); compW / compH its size.
  SceneEval(const doc::SpaceCtx& sc, std::string comp, double compW, double compH);

  /// The comp's active camera at comp `seconds` (nullopt = none: the comp's default view). No DOF settings.
  std::optional<api::RenderCamera3D> camera(double seconds);
  /// The comp's lights at comp `seconds`, in the renderer's terms (environment lights excluded).
  std::vector<api::RenderLight3D> lights(double seconds);
  /// A layer's world 4×4 at comp `seconds` in the document's own local space (centred on the layer's
  /// origin, as layerSpace.ts resolves it; a 2D layer: its affine at z = 0).
  std::optional<motion::xf::Mat4> world(const std::string& id, double seconds);
  /// The SDK's LAYER-param matrix (pr_host.h get_layer_transform): LAYER PX — (0, 0) the layer's
  /// top-left, (w, h) its bottom-right, as drawn — → comp world px, column-major. `world` through the
  /// layer's box (layer_geometry.hpp: width, height and the box centre's offset from the origin).
  /// nullopt for a node the document cannot place (gone, no geometry, a text layer without a measurer).
  std::optional<motion::xf::Mat4> layer_world(const std::string& id, double seconds);
  /// Inside its in/out bar at comp `seconds` (the renderer's isLiveAt: own bars, else a plain group's).
  bool live_at(const doc::Node& n, double seconds);

  [[nodiscard]] double comp_w() const noexcept { return compW_; }
  [[nodiscard]] double comp_h() const noexcept { return compH_; }

 private:
  const std::vector<const doc::Node*>& nodes();

  doc::SpaceCtx sc_;
  std::string comp_;
  double compW_;
  double compH_;
  std::optional<std::vector<const doc::Node*>> nodes_;
  std::map<std::int64_t, std::optional<api::RenderCamera3D>> cameras_;
  std::map<std::int64_t, std::vector<api::RenderLight3D>> lights_;
  std::map<std::pair<std::string, std::int64_t>, std::optional<motion::xf::Mat4>> worlds_;
};

/// SDK 1.2: what DRAW_OVERLAY / OVERLAY_DRAG of `spec` may read at the request's time — the comp
/// camera (PR_OUT_FLAG_USES_CAMERA), lights (_USES_LIGHTS) and LAYER params' world matrices
/// (_USES_LAYER_TRANSFORMS) of the composition the request's layer is in — into `req.scene`.
void overlay_scene(const doc::SpaceCtx& sc, const EffectSpec& spec, doc::NativeActionRequest& req);

}  // namespace premation::plugins
