// setViewport `view` / `customView` → the snapshot's camera
// (snapshot_build.hpp with_viewport_view): what buildSnapshot.ts read from the
// editor's camera3dMode / customViewCamera, now per viewport.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <utility>

#include "docexpr.hpp"
#include "docio.hpp"
#include "frame_scene.hpp"
#include "json.hpp"
#include "native_scene.hpp"
#include "snapshot_build.hpp"

using Catch::Approx;
using premation::CustomViewParams;
using premation::ViewportConfig;
using premation::scene::SnapshotComp;
using premation::scene::with_viewport_view;

namespace {

SnapshotComp comp_1920() {
  SnapshotComp s;
  s.rootId = "comp_root";
  s.width = 1920;
  s.height = 1080;
  return s;
}

}  // namespace

TEST_CASE("with_viewport_view: absent, '' and 'active' leave the composition's camera", "[viewport][view]") {
  ViewportConfig v;
  CHECK(with_viewport_view(comp_1920(), v).camera3dMode == "active");
  v.view = "";
  CHECK(with_viewport_view(comp_1920(), v).camera3dMode == "active");
  v.view = "active";
  const SnapshotComp s = with_viewport_view(comp_1920(), v);
  CHECK(s.camera3dMode == "active");
  CHECK_FALSE(s.customViewCamera.has_value());
}

TEST_CASE("with_viewport_view: an axis view or a camera view is the snapshot's camera3dMode", "[viewport][view]") {
  ViewportConfig v;
  v.view = "top";
  CHECK(with_viewport_view(comp_1920(), v).camera3dMode == "top");
  v.view = "camera:cam_1";
  const SnapshotComp s = with_viewport_view(comp_1920(), v);
  CHECK(s.camera3dMode == "camera:cam_1");
  CHECK_FALSE(s.customViewCamera.has_value());
}

TEST_CASE("with_viewport_view: a custom view replaces the scene camera with its orbit about the POI", "[viewport][view]") {
  ViewportConfig v;
  v.view = "custom";

  SECTION("without an orbit there is nothing to replace the scene camera with") {
    const SnapshotComp s = with_viewport_view(comp_1920(), v);
    CHECK(s.camera3dMode == "active");
    CHECK_FALSE(s.customViewCamera.has_value());
  }

  SECTION("the defaults: the comp centre on z = 0, 1.2 × the default focal length, straight on") {
    v.customView = CustomViewParams{};
    const SnapshotComp s = with_viewport_view(comp_1920(), v);
    CHECK(s.camera3dMode == "active");
    REQUIRE(s.customViewCamera.has_value());
    const motion::xf::Camera def = motion::xf::default_camera(1920, 1080);
    CHECK(s.customViewCamera->focal_length == Approx(def.focal_length));
    CHECK(s.customViewCamera->principal.x == Approx(def.principal.x));
    CHECK(s.customViewCamera->principal.y == Approx(def.principal.y));
    CHECK(s.customViewCamera->position.x == Approx(960));
    CHECK(s.customViewCamera->position.y == Approx(540));
    CHECK(s.customViewCamera->position.z == Approx(-def.focal_length * 1.2));
    CHECK_FALSE(s.customViewCamera->orientation.has_value());
  }

  SECTION("yaw = +90 puts the eye at −x of the POI (Left) and looks back at it") {
    v.customView = CustomViewParams{.yaw = 90, .pitch = 0, .distance = 500, .poi = std::array<double, 3>{100, 200, 0}};
    const SnapshotComp s = with_viewport_view(comp_1920(), v);
    REQUIRE(s.customViewCamera.has_value());
    CHECK(s.customViewCamera->position.x == Approx(100 - 500).margin(1e-6));
    CHECK(s.customViewCamera->position.y == Approx(200).margin(1e-6));
    CHECK(s.customViewCamera->position.z == Approx(0).margin(1e-6));
    REQUIRE(s.customViewCamera->orientation.has_value());
    CHECK(std::abs(s.customViewCamera->orientation->yaw) == Approx(90).margin(1e-6));
    CHECK(s.customViewCamera->orientation->pitch == Approx(0).margin(1e-6));
  }
}

// ── E6 (3D perf program): Draft 3D keeps cheap lighting ─────────────────────
// Ambient lights and the key (the first non-ambient light) stay; shadows,
// SSAO, depth of field and layer reflections go. A lit scene in Draft 3D is
// therefore shaded, not flat.

namespace {

namespace doc = premation::doc;
namespace sc = premation::scene;
namespace api = premation::api;

const char* kLitProject = R"json({"version":"1.9.0","scene":{"version":"1.0.0","nodes":[
  {"id":"comp_root","name":"C","parent":null,"children":["cam","amb","key","fill","card","floor"],"visible":true,"locked":false,
   "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},"components":[{"id":"comp_root_meta","type":"group","props":{"__kind":"group"}}]},
  {"id":"cam","name":"cam","parent":"comp_root","children":[],"visible":true,"locked":false,"transform":{"position":{"x":240,"y":180},"rotation":0,"scale":{"x":1,"y":1}},
   "components":[{"id":"cam_t","type":"Transform","props":{"__kind":"camera","x":240,"y":180,"rotation":0,"z":-1000,"focalLength":1000,"dofStrength":100,"dofAperture":60,"focusDistance":1000}}]},
  {"id":"amb","name":"amb","parent":"comp_root","children":[],"visible":true,"locked":false,"transform":{"position":{"x":240,"y":180},"rotation":0,"scale":{"x":1,"y":1}},
   "components":[{"id":"amb_t","type":"Transform","props":{"__kind":"light","x":240,"y":180,"rotation":0,"z":0,"lightType":"ambient","intensity":30}},{"id":"amb_s","type":"Style","props":{"opacity":100,"fill":"#ffffff"}}]},
  {"id":"key","name":"key","parent":"comp_root","children":[],"visible":true,"locked":false,"transform":{"position":{"x":120,"y":70},"rotation":0,"scale":{"x":1,"y":1}},
   "components":[{"id":"key_t","type":"Transform","props":{"__kind":"light","x":120,"y":70,"rotation":0,"z":-300,"lightType":"point","intensity":110,"radius":600,"castShadows":true}},{"id":"key_s","type":"Style","props":{"opacity":100,"fill":"#fff2d8"}}]},
  {"id":"fill","name":"fill","parent":"comp_root","children":[],"visible":true,"locked":false,"transform":{"position":{"x":400,"y":300},"rotation":0,"scale":{"x":1,"y":1}},
   "components":[{"id":"fill_t","type":"Transform","props":{"__kind":"light","x":400,"y":300,"rotation":0,"z":-200,"lightType":"point","intensity":50,"radius":600,"castShadows":true}},{"id":"fill_s","type":"Style","props":{"opacity":100,"fill":"#d8e4ff"}}]},
  {"id":"card","name":"card","parent":"comp_root","children":[],"visible":true,"locked":false,"transform":{"position":{"x":240,"y":180},"rotation":0,"scale":{"x":1,"y":1}},
   "components":[{"id":"card_t","type":"Transform","props":{"__kind":"shape","x":240,"y":160,"rotation":0,"width":200,"height":120,"z":0,"rotationY":20,"acceptsLights":true,"reflectsLayers":true,"reflectionIntensity":60}},
     {"id":"card_s","type":"Style","props":{"opacity":100,"fill":"#c9a05a"}}]},
  {"id":"floor","name":"floor","parent":"comp_root","children":[],"visible":true,"locked":false,"transform":{"position":{"x":240,"y":180},"rotation":0,"scale":{"x":1,"y":1}},
   "components":[{"id":"floor_t","type":"Transform","props":{"__kind":"shape","x":240,"y":300,"rotation":0,"width":600,"height":600,"z":0,"rotationX":90,"acceptsLights":true}},
     {"id":"floor_s","type":"Style","props":{"opacity":100,"fill":"#404048"}}]}]},
  "animation":{"tracks":{},"data":{},"expressions":{}},
  "comps":{"comp_root":{"id":"comp_root","name":"C","width":480,"height":360,"fps":30,"durationSeconds":10,"background":"#101014",
           "ssao":{"enabled":true,"radius":30,"intensity":1,"quality":"half"}}}})json";

struct LitScene {
  doc::Document d;
  doc::EditorView view;
  doc::ExprCache cache;
  LitScene() {
    const auto json = premation::js::parse(kLitProject);
    REQUIRE(json.has_value());
    (void)doc::restore_document(d, view, *json, {});
  }
  api::RenderFrameScene frame(bool draft3d) {
    doc::DocExprEnv env(d, view, cache);
    const sc::BuildContext ctx{d, view, env, cache, nullptr, {}};
    sc::CompOverrides ov;
    ov.draft3d = draft3d;
    sc::NativeFrame f = sc::build_native_frame(ctx, "comp_root", 0.0, sc::export_view(480, 360, 480, 360), false, {}, 0, ov);
    return std::move(f.file.scene);
  }
};

std::size_t non_ambient(const api::RenderFrameScene& s) {
  std::size_t n = 0;
  for (const api::RenderLight3D& l : s.lights3d) n += l.type != api::RenderLightType::ambient ? 1 : 0;
  return n;
}
std::size_t mapped(const api::RenderFrameScene& s) {
  std::size_t n = 0;
  for (const api::RenderLight3D& l : s.lights3d) n += l.shadow_map.value_or(false) ? 1 : 0;
  return n;
}
/// The snapshot's layers (the 3D port's shade3d carries the layer-reflection flag).
sc::Snapshot snapshot_of(LitScene& scene, bool draft3d) {
  doc::DocExprEnv env(scene.d, scene.view, scene.cache);
  const sc::BuildContext ctx{scene.d, scene.view, env, scene.cache, nullptr, {}};
  sc::SnapshotComp comp = sc::snapshot_comp_of(scene.d, "comp_root");
  comp.draft3d = draft3d;
  return sc::build_snapshot(ctx, comp, 0, std::nullopt);
}
bool any_layer_reflections(const std::vector<sc::RLayer>& layers) {
  for (const sc::RLayer& l : layers) {
    if (l.shade3d && l.shade3d->layer_reflections.value_or(false)) return true;
    if (l.precompLayers && any_layer_reflections(*l.precompLayers)) return true;
  }
  return false;
}

}  // namespace

TEST_CASE("E6: Draft 3D keeps the ambient + key light and drops shadows, SSAO, DOF and reflections", "[viewport][draft3d][e6]") {
  LitScene scene;
  const api::RenderFrameScene full = scene.frame(false);
  REQUIRE(full.camera3d.has_value());
  CHECK(full.lights3d.size() == 3);
  CHECK(non_ambient(full) == 2);
  CHECK(mapped(full) >= 1);
  CHECK(full.ssao.has_value());
  CHECK(full.camera3d->dof.has_value());
  CHECK(any_layer_reflections(snapshot_of(scene, false).layers));

  const api::RenderFrameScene draft = scene.frame(true);
  REQUIRE(draft.camera3d.has_value());
  // Lit, not flat: the ambient and ONE key light reach the shader.
  CHECK(draft.lights3d.size() == 2);
  CHECK(non_ambient(draft) == 1);
  CHECK(mapped(draft) == 0);
  CHECK_FALSE(draft.ssao.has_value());
  CHECK_FALSE(draft.camera3d->dof.has_value());
  CHECK_FALSE(any_layer_reflections(snapshot_of(scene, true).layers));
  // The key that stays is the first non-ambient light in layer order (the comp's key), at its strength.
  const auto key = std::ranges::find_if(draft.lights3d, [](const api::RenderLight3D& l) { return l.type != api::RenderLightType::ambient; });
  REQUIRE(key != draft.lights3d.end());
  CHECK(key->gain == Approx(1.1));
}

TEST_CASE("U1: a ViewSpec with clipToComp off carries no frame clip; on, the comp rect", "[viewport][u1]") {
  LitScene scene;
  doc::DocExprEnv env(scene.d, scene.view, scene.cache);
  const sc::BuildContext ctx{scene.d, scene.view, env, scene.cache, nullptr, {}};
  sc::ViewSpec vs = sc::export_view(960, 720, 480, 360);
  const sc::NativeFrame clipped = sc::build_native_frame(ctx, "comp_root", 0.0, vs, false);
  REQUIRE(clipped.file.view.frame_clip.has_value());
  CHECK(clipped.file.view.frame_clip->width == Approx(960));
  vs.clipToComp = false;
  const sc::NativeFrame open = sc::build_native_frame(ctx, "comp_root", 0.0, vs, false);
  CHECK_FALSE(open.file.view.frame_clip.has_value());
  // The layers are the same in both: only the clip (and, in the engine, the pasteboard clear) differ.
  CHECK(open.file.scene.renderables.size() == clipped.file.scene.renderables.size());
}
