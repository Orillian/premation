// setViewport `view` / `customView` → the snapshot's camera
// (snapshot_build.hpp with_viewport_view): what buildSnapshot.ts read from the
// editor's camera3dMode / customViewCamera, now per viewport.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <array>
#include <cstring>
#include <cmath>
#include <cstddef>
#include <filesystem>
#include <fstream>
#include <string>
#include <utility>
#include <vector>

#include "docexpr.hpp"
#include "worldxf.hpp"
#include "docio.hpp"
#include "env_asset.hpp"
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

// ── E8 (3D perf program): the engine-drawn ground grid is a viewport's, never an export's ──

TEST_CASE("E8: ViewSpec.groundGrid puts the comp's ground plane on the frame; an export view never has one", "[viewport][e8]") {
  LitScene scene;
  doc::DocExprEnv env(scene.d, scene.view, scene.cache);
  const sc::BuildContext ctx{scene.d, scene.view, env, scene.cache, nullptr, {}};
  sc::ViewSpec vs = sc::export_view(480, 360, 480, 360);
  const sc::NativeFrame exported = sc::build_native_frame(ctx, "comp_root", 0.0, vs, false);
  REQUIRE(exported.file.scene.camera3d.has_value());
  CHECK_FALSE(exported.file.scene.ground_grid.has_value());
  vs.groundGrid = true;
  const sc::NativeFrame viewed = sc::build_native_frame(ctx, "comp_root", 0.0, vs, false);
  REQUIRE(viewed.file.scene.ground_grid.has_value());
  CHECK(viewed.file.scene.ground_grid->y == Approx(360));  // comp height + Ground Level 0
  CHECK(viewed.file.scene.ground_grid->center_x == Approx(240));
  CHECK(viewed.file.scene.ground_grid->center_z == Approx(0));
  // The layers are the same: the grid is a render-graph pass, not a renderable.
  CHECK(viewed.file.scene.renderables.size() == exported.file.scene.renderables.size());
}

// ── E7 (3D perf program): a Radiance .hdr image asset is an environment sky ──

TEST_CASE("E7: an .hdr image asset projects its linear RGBE planes into the sky's SH and atlases", "[scene][env][e7]") {
  namespace fs = std::filesystem;
  const fs::path file = fs::temp_directory_path() / "premation-e7-sky.hdr";
  {
    // 16 × 8, flat RGBE: a bright upper half (≈ 2.0) over a dark lower half (0.125).
    std::string h = "#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 8 +X 16\n";
    std::vector<unsigned char> bytes(h.begin(), h.end());
    for (int y = 0; y < 8; ++y) {
      for (int x = 0; x < 16; ++x) {
        if (y < 4) bytes.insert(bytes.end(), {255, 255, 255, 129});
        else bytes.insert(bytes.end(), {32, 32, 32, 128});
      }
    }
    std::ofstream out(file, std::ios::binary);
    REQUIRE(out.good());
    out.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  }
  doc::Document d;
  premation::js::Json asset = premation::js::Json::object();
  asset.set("id", premation::js::Json::string("sky1"));
  asset.set("type", premation::js::Json::string("image"));
  asset.set("name", premation::js::Json::string("sky.hdr"));
  asset.set("src", premation::js::Json::string(file.string()));
  asset.set("path", premation::js::Json::string(file.string()));
  d.items_mut().assets.push_back(asset);
  std::string why;
  const std::shared_ptr<const sc::EnvAsset> sky = sc::environment_asset(d, "asset:sky1", why);
  INFO(why);
  REQUIRE(sky);
  CHECK(why.empty());
  // Energy in the mean band, finite, and the HDR atlas built.
  CHECK(sky->sh[0] > 0.05F);
  CHECK(std::isfinite(sky->sh[0]));
  CHECK(sky->hdr.width > 0);
  CHECK(sky->specular.width > 0);
  // A missing file says why (no fallback to a PNG src that is not there either).
  std::error_code ec;
  fs::remove(file, ec);
  sc::clear_environment_assets();
  why.clear();
  CHECK_FALSE(sc::environment_asset(d, "asset:sky1", why));
  CHECK_FALSE(why.empty());
}

// ── Camera program R1: procedural camera shake ──────────────────────────────

namespace {

/// The lit scene's camera eye + view at `t`, with `shake` spliced into the camera's Transform props.
std::pair<std::vector<double>, std::vector<double>> shaken_camera(const std::string& shake, double t) {
  std::string src = kLitProject;
  const std::string key = "\"focusDistance\":1000";
  const std::size_t at = src.find(key);
  REQUIRE(at != std::string::npos);
  src.insert(at + key.size(), shake);
  const auto json = premation::js::parse(src);
  REQUIRE(json.has_value());
  doc::Document d;
  doc::EditorView view;
  doc::ExprCache cache;
  (void)doc::restore_document(d, view, *json, {});
  doc::DocExprEnv env(d, view, cache);
  const sc::BuildContext ctx{d, view, env, cache, nullptr, {}};
  sc::NativeFrame f = sc::build_native_frame(ctx, "comp_root", t, sc::export_view(480, 360, 480, 360), false, {}, 0, {});
  REQUIRE(f.file.scene.camera3d.has_value());
  return {f.file.scene.camera3d->eye, f.file.scene.camera3d->view};
}

}  // namespace

TEST_CASE("R1: camera shake is seeded noise after the aim — zero at amount 0, deterministic, differs by seed", "[camera][shake][r1]") {
  const auto plain = shaken_camera("", 0.5);
  // Amount 0 (rotation 0) = byte-identical to a camera with no shake props.
  CHECK(shaken_camera(R"(,"shakeAmount":0,"shakeRotation":0,"shakeSeed":9)", 0.5) == plain);
  const std::string on = R"(,"shakeAmount":25,"shakeRotation":1,"shakeSeed":3)";
  const auto a = shaken_camera(on, 0.5);
  CHECK(a == shaken_camera(on, 0.5));  // deterministic
  CHECK(a.first != plain.first);       // the eye moved
  CHECK(a.second != plain.second);     // and turned
  const double moved = std::hypot(a.first[0] - plain.first[0], a.first[1] - plain.first[1], a.first[2] - plain.first[2]);
  CHECK(moved > 0.01);
  CHECK(moved < 25 * 1.5 + 1e-6);
  CHECK(shaken_camera(R"(,"shakeAmount":25,"shakeRotation":1,"shakeSeed":4)", 0.5) != a);  // seed matters
  CHECK(shaken_camera(on, 1.5) != a);                                                         // time matters
}

// ── Camera program R3b: Auto-Orient Along Path for a one-node camera ────────

namespace {

/// A one-node camera keyed from x = 100 to x = 700 over 2 s, `fx` its fx props;
/// a card ahead on +x stays in view once the camera turns along its path.
std::string travelling_camera(const std::string& fx, bool poi) {
  return std::string(R"json({"version":"1.9.0","scene":{"version":"1.0.0","nodes":[
  {"id":"comp_root","name":"C","parent":null,"children":["cam","card","ahead"],"visible":true,"locked":false,
   "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},"components":[{"id":"comp_root_meta","type":"group","props":{"__kind":"group"}}]},
  {"id":"cam","name":"cam","parent":"comp_root","children":[],"visible":true,"locked":false,"transform":{"position":{"x":100,"y":180},"rotation":0,"scale":{"x":1,"y":1}},
   "components":[{"id":"cam_t","type":"Transform","props":{"__kind":"camera","x":100,"y":180,"rotation":0,"z":-1000,"focalLength":1000)json") +
         (poi ? R"json(,"poiX":240,"poiY":180,"poiZ":0)json" : "") + R"json(}},
     {"id":"cam_fx","type":"fx","props":)json" + fx + R"json(}]},
  {"id":"card","name":"card","parent":"comp_root","children":[],"visible":true,"locked":false,"transform":{"position":{"x":240,"y":180},"rotation":0,"scale":{"x":1,"y":1}},
   "components":[{"id":"card_t","type":"Transform","props":{"__kind":"shape","x":240,"y":180,"rotation":0,"width":100,"height":100,"z":0}},
     {"id":"card_s","type":"Style","props":{"opacity":100,"fill":"#c9a05a"}}]},
  {"id":"ahead","name":"ahead","parent":"comp_root","children":[],"visible":true,"locked":false,"transform":{"position":{"x":1400,"y":180},"rotation":0,"scale":{"x":1,"y":1}},
   "components":[{"id":"ahead_t","type":"Transform","props":{"__kind":"shape","x":1400,"y":180,"rotation":0,"width":100,"height":100,"z":-1000,"rotationY":90}},
     {"id":"ahead_s","type":"Style","props":{"opacity":100,"fill":"#5ac9a0"}}]}]},
  "animation":{"tracks":{"cam":{"x":[{"t":0,"value":100},{"t":2,"value":700}]}},"data":{},"expressions":{}},
  "comps":{"comp_root":{"id":"comp_root","name":"C","width":480,"height":360,"fps":30,"durationSeconds":10,"background":"#101014"}}})json";
}

struct OrientScene {
  doc::Document d;
  doc::EditorView view;
  doc::ExprCache cache;
  explicit OrientScene(const std::string& src) {
    const auto json = premation::js::parse(src);
    REQUIRE(json.has_value());
    (void)doc::restore_document(d, view, *json, {});
  }
  motion::xf::Camera camera(double t) {
    doc::DocExprEnv env(d, view, cache);
    const doc::SpaceCtx sc{d, view, env, cache};
    return doc::camera_at(sc, *d.node("cam"), 480, 360, t);
  }
  std::vector<double> frame_view(double t) {
    doc::DocExprEnv env(d, view, cache);
    const sc::BuildContext ctx{d, view, env, cache, nullptr, {}};
    sc::NativeFrame f = sc::build_native_frame(ctx, "comp_root", t, sc::export_view(480, 360, 480, 360), false, {}, 0, {});
    REQUIRE(f.file.scene.camera3d.has_value());
    return f.file.scene.camera3d->view;
  }
};

double yaw_of(const motion::xf::Camera& c) { return c.orientation ? c.orientation->yaw : 0; }

}  // namespace

TEST_CASE("R3b: a one-node camera oriented along its path faces its direction of travel", "[camera][autoorient][r3b]") {
  OrientScene off(travelling_camera(R"({})", false));
  OrientScene along(travelling_camera(R"({"autoOrient":"path"})", false));
  // Travelling +x: look_at yaw = atan2(dx, dz) = 90°.
  CHECK(yaw_of(off.camera(1)) == Approx(0).margin(1e-9));
  CHECK(yaw_of(along.camera(1)) == Approx(90).margin(1e-6));
  // The tangent is held past the last key (AE holds the end tangents), not dropped.
  CHECK(yaw_of(along.camera(5)) == Approx(90).margin(1e-6));
  CHECK(yaw_of(along.camera(0)) == Approx(90).margin(1e-6));
  // The rendered frame's camera turns with it.
  CHECK(along.frame_view(1) != off.frame_view(1));
  // The legacy boolean `true` reads as Along Path too.
  OrientScene legacy(travelling_camera(R"({"autoOrient":true})", false));
  CHECK(yaw_of(legacy.camera(1)) == Approx(90).margin(1e-6));
  // A two-node camera keeps aiming at its Point of Interest.
  OrientScene twoNode(travelling_camera(R"({"autoOrient":"path"})", true));
  OrientScene twoNodeOff(travelling_camera(R"({})", true));
  CHECK(yaw_of(twoNode.camera(1)) == Approx(yaw_of(twoNodeOff.camera(1))));
}

// ── Camera program D3: Photo → 3D parallax over a synthetic depth map ──────

namespace {

/// An 8×4 depth map: the left half white (near), the right half black (far).
constexpr const char* kDepthPng =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAEElEQVR4nGP4jwQYkAH1JAB2ei/Rlzh6MAAAAABJRU5ErkJggg==";

sc::Snapshot parallax_snapshot(const std::string& props) {
  const std::string src = std::string(R"json({"version":"1.9.0","scene":{"version":"1.0.0","nodes":[
  {"id":"comp_root","name":"C","parent":null,"children":["cam","photo"],"visible":true,"locked":false,
   "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},"components":[{"id":"comp_root_meta","type":"group","props":{"__kind":"group"}}]},
  {"id":"cam","name":"cam","parent":"comp_root","children":[],"visible":true,"locked":false,"transform":{"position":{"x":240,"y":180},"rotation":0,"scale":{"x":1,"y":1}},
   "components":[{"id":"cam_t","type":"Transform","props":{"__kind":"camera","x":240,"y":180,"rotation":0,"z":-1000,"focalLength":1000}}]},
  {"id":"photo","name":"photo","parent":"comp_root","children":[],"visible":true,"locked":false,"transform":{"position":{"x":240,"y":180},"rotation":0,"scale":{"x":1,"y":1}},
   "components":[{"id":"photo_t","type":"Transform","props":{"__kind":"image","x":240,"y":180,"rotation":0,"width":320,"height":160,"z":0,"src":")json") +
                          kDepthPng + R"json(")json" + props + R"json(}}]}]},
  "animation":{"tracks":{},"data":{},"expressions":{}},
  "comps":{"comp_root":{"id":"comp_root","name":"C","width":480,"height":360,"fps":30,"durationSeconds":10,"background":"#101014"}}})json";
  const auto json = premation::js::parse(src);
  REQUIRE(json.has_value());
  doc::Document d;
  doc::EditorView view;
  doc::ExprCache cache;
  (void)doc::restore_document(d, view, *json, {});
  doc::DocExprEnv env(d, view, cache);
  const sc::BuildContext ctx{d, view, env, cache, nullptr, {}};
  return sc::build_snapshot(ctx, sc::snapshot_comp_of(d, "comp_root"), 0, std::nullopt);
}

const sc::RLayer* photo_of(const sc::Snapshot& s) {
  for (const sc::RLayer& l : s.layers) {
    if (l.id == "photo") return &l;
  }
  return nullptr;
}

std::vector<float> mesh_floats(const sc::RLayer& l) {
  const auto& bytes = l.extrudedMesh->geometry.vertices;
  std::vector<float> v(bytes.size() / sizeof(float));
  std::memcpy(v.data(), bytes.data(), v.size() * sizeof(float));
  return v;
}

}  // namespace

TEST_CASE("D3: a depth map turns an image layer into a camera-facing displaced grid", "[depth][parallax][d3]") {
  // Flat without a Depth Scale: the ordinary quad.
  const sc::Snapshot flat = parallax_snapshot(std::string(R"(,"depthSource":"src:)") + kDepthPng + "\"");
  REQUIRE(photo_of(flat) != nullptr);
  CHECK(photo_of(flat)->extrudedMesh == nullptr);

  const sc::Snapshot s = parallax_snapshot(std::string(R"(,"depthScale":200,"depthMeshDetail":8,"depthSource":"src:)") + kDepthPng + "\"");
  const sc::RLayer* photo = photo_of(s);
  REQUIRE(photo != nullptr);
  REQUIRE(photo->extrudedMesh != nullptr);
  const std::vector<float> v = mesh_floats(*photo);
  // 8 × 4 cells (the layer's 2:1 aspect) → 9 × 5 vertices, x y z nx ny nz u v.
  REQUIRE(v.size() == std::size_t{9} * 5 * 8);
  // White (near) comes toward the camera (−z), black (far) goes back; x spans the layer.
  CHECK(v[0] == Catch::Approx(-160));
  CHECK(v[2] == Catch::Approx(-100));            // u = 0: white
  CHECK(v[8 * 8 + 2] == Catch::Approx(100));     // u = 1: black
  CHECK(photo->extrudedMesh->ranges.size() == 1);
  CHECK(photo->extrudedMesh->ranges[0].textured);

  // Edge Cut: the triangles across the jump are refilled from their far side (extra vertices).
  const sc::Snapshot cut = parallax_snapshot(std::string(R"(,"depthScale":200,"depthMeshDetail":8,"depthEdgeCut":0.3,"depthSource":"src:)") + kDepthPng + "\"");
  REQUIRE(photo_of(cut)->extrudedMesh != nullptr);
  CHECK(mesh_floats(*photo_of(cut)).size() > v.size());

  // A depth source that cannot be read leaves the layer flat and says why.
  const sc::Snapshot missing = parallax_snapshot(R"(,"depthScale":200,"depthSource":"src:C:/no/such/depth.png")");
  CHECK(photo_of(missing)->extrudedMesh == nullptr);
  bool reported = false;
  for (const sc::LayerError& e : missing.layerErrors) reported = reported || e.message.find("depth parallax") != std::string::npos;
  CHECK(reported);
}

// ── Camera program R2b: a one-node camera turns with its parents ───────────

namespace {

/// A camera under a 3D null turned `rotY` degrees about Y; `poi` makes it two-node.
std::string parented_camera(double rotY, bool poi) {
  return std::string(R"json({"version":"1.9.0","scene":{"version":"1.0.0","nodes":[
  {"id":"comp_root","name":"C","parent":null,"children":["rig","card"],"visible":true,"locked":false,
   "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},"components":[{"id":"comp_root_meta","type":"group","props":{"__kind":"group"}}]},
  {"id":"rig","name":"rig","parent":"comp_root","children":["cam"],"visible":true,"locked":false,"transform":{"position":{"x":240,"y":180},"rotation":0,"scale":{"x":1,"y":1}},
   "components":[{"id":"rig_t","type":"Transform","props":{"__kind":"null","x":240,"y":180,"rotation":0,"z":0,"rotationY":)json") +
         std::to_string(rotY) + R"json(}},{"id":"rig_fx","type":"fx","props":{"threeD":true}}]},
  {"id":"cam","name":"cam","parent":"rig","children":[],"visible":true,"locked":false,"transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
   "components":[{"id":"cam_t","type":"Transform","props":{"__kind":"camera","x":0,"y":0,"rotation":0,"z":-1000,"focalLength":1000)json" +
         (poi ? R"json(,"poiX":0,"poiY":0,"poiZ":0)json" : "") + R"json(}}]},
  {"id":"card","name":"card","parent":"comp_root","children":[],"visible":true,"locked":false,"transform":{"position":{"x":240,"y":180},"rotation":0,"scale":{"x":1,"y":1}},
   "components":[{"id":"card_t","type":"Transform","props":{"__kind":"shape","x":240,"y":180,"rotation":0,"width":100,"height":100,"z":0}},
     {"id":"card_s","type":"Style","props":{"opacity":100,"fill":"#c9a05a"}}]}]},
  "animation":{"tracks":{},"data":{},"expressions":{}},
  "comps":{"comp_root":{"id":"comp_root","name":"C","width":480,"height":360,"fps":30,"durationSeconds":10,"background":"#101014"}}})json";
}

}  // namespace

TEST_CASE("R2b: a one-node camera inherits its parent's rotation; unrotated parents change nothing", "[camera][parent][r2b]") {
  OrientScene turned(parented_camera(90, false));
  const motion::xf::Camera c = turned.camera(0);
  // The rig turns the camera about the rig's centre: the eye arcs AND the view turns with it.
  CHECK(std::abs(yaw_of(c)) == Approx(90).margin(1e-6));
  // Looking from the arced eye back through the rig centre (the eye is 1000 px off on x).
  CHECK(std::abs(c.position.x - 240) == Approx(1000).margin(1e-6));
  const bool eyeLeft = c.position.x < 240;
  CHECK(eyeLeft == (yaw_of(c) > 0));
  // An unrotated parent leaves the camera exactly as an unparented one at the same world place.
  OrientScene flat(parented_camera(0, false));
  const motion::xf::Camera f = flat.camera(0);
  CHECK_FALSE(f.orientation.has_value());
  CHECK(f.position.x == 240);
  CHECK(f.position.z == -1000);
  // A two-node camera keeps aiming at its (lifted) Point of Interest.
  OrientScene twoNode(parented_camera(90, true));
  CHECK(std::abs(yaw_of(twoNode.camera(0))) == Approx(90).margin(1e-6));
  // The rendered frame turns with it.
  CHECK(turned.frame_view(0) != flat.frame_view(0));
}
