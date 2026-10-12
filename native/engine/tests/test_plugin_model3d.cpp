// The model3d sample (plugin SDK 1.2, S8) on the host's CPU path: an Element 3D
// class effect that loads a glTF (.glb, or .gltf + its .bin through
// get_asset_sibling_bytes), renders it through the comp camera with a z-buffer,
// reports a missing model on the layer instead of crashing, and discards what is
// behind the scene depth (checkout_scene_depth, S6). The GPU path and the scene
// depth the engine draws are in test_plugin_gpu.cpp.
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <limits>
#include <string>
#include <vector>

#if !defined(_WIN32)
#include <sys/wait.h>
#endif

#include "cpu_render.hpp"
#include "host.hpp"
#include "json.hpp"
#include "native_effects.hpp"
#include "transform.hpp"
#include "values.hpp"

namespace pl = premation::plugins;
namespace fs = std::filesystem;

namespace {

constexpr const char* kModel3d = "com.premation.samples.model3d";
constexpr std::uint32_t kW = 96;
constexpr std::uint32_t kH = 64;
// model3d.cpp's param ids.
constexpr std::uint32_t kModel = 1;
constexpr std::uint32_t kOrientX = 3;
constexpr std::uint32_t kOrientY = 4;
constexpr std::uint32_t kSize = 6;
constexpr std::uint32_t kSceneDepth = 13;
constexpr std::uint32_t kRenderMode = 15;

fs::path bundles() { return fs::path(PREMATION_PLUGIN_BUNDLES); }
fs::path models() { return bundles() / "model3d" / "models"; }

pl::HostOptions options() {
  pl::HostOptions o;
  o.searchPaths = {bundles()};
  o.threads = 2;
  o.attachToDocument = false;
  o.onHang = [](const std::string&, std::string_view) { FAIL("unexpected hang"); };
  return o;
}

void set_param(pl::RenderInputs& in, const pl::EffectSpec& spec, std::uint32_t id, double v, std::size_t member = 0) {
  const int slot = pl::param_slot(spec, id);
  REQUIRE(slot >= 0);
  in.values.at(static_cast<std::size_t>(slot)).v.at(member) = v;
}

void set_file(pl::RenderInputs& in, const pl::EffectSpec& spec, const fs::path& file, bool missing = false) {
  const int slot = pl::param_slot(spec, kModel);
  REQUIRE(slot >= 0);
  pl::ParamValue& v = in.values.at(static_cast<std::size_t>(slot));
  v.fileItem = "item-" + file.filename().string();
  v.fileName = file.filename().string();
  const std::u8string u8 = file.u8string();
  v.filePath = missing ? std::string() : std::string(u8.begin(), u8.end());
  v.fileMissing = missing;
}

/// The comp is the layer (W × H at the origin), 32 bpc, the comp's default camera.
pl::RenderInputs inputs(const pl::EffectSpec& spec, const char* instance) {
  pl::RenderInputs in = pl::default_inputs(spec, instance, kW, kH, 32);
  in.compW = kW;
  in.compH = kH;
  set_param(in, spec, kSize, 40);
  return in;
}

pl::TexelImage blank() {
  pl::TexelImage img;
  img.format = pl::TexelFormat::rgba32f;
  img.width = kW;
  img.height = kH;
  img.bytes.assign(std::size_t{kW} * kH * 16, 0);
  return img;
}

std::vector<float> floats(const pl::TexelImage& img) {
  std::vector<float> f(img.bytes.size() / 4);
  std::memcpy(f.data(), img.bytes.data(), img.bytes.size());
  return f;
}

/// Opaque pixels, and the centre pixel's alpha.
std::size_t coverage(const std::vector<float>& px) {
  std::size_t n = 0;
  for (std::size_t i = 3; i < px.size(); i += 4) n += px[i] > 0.5F ? 1 : 0;
  return n;
}
float alpha_at(const std::vector<float>& px, std::uint32_t x, std::uint32_t y) { return px[(std::size_t{y} * kW + x) * 4 + 3]; }

std::vector<float> render(pl::PluginHost& host, const pl::RenderInputs& in, const pl::TexelCheckouts::DepthFn& depth = {}) {
  pl::TexelImage out;
  const pl::CallResult r = pl::run_native_cpu(host, in, blank(), {}, out, depth);
  INFO(r.message);
  REQUIRE(r.ok);
  return floats(out);
}

int run_tool(const std::string& args) {
  std::string cmd = "\"" + std::string(PREMATION_PLUGINS_TOOL) + "\" --plugins \"" + bundles().string() + "\" " + args;
#if defined(_WIN32)
  cmd = "\"" + cmd + " >NUL 2>NUL\"";
  return std::system(cmd.c_str());  // NOLINT(concurrency-mt-unsafe, cert-env33-c): a test driving the tool
#else
  cmd += " >/dev/null 2>&1";
  const int status = std::system(cmd.c_str());  // NOLINT(concurrency-mt-unsafe, cert-env33-c): a test driving the tool
  if (status == -1) return -1;
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return WEXITSTATUS(status);
#endif
}

}  // namespace

TEST_CASE("model3d: loads, declares SDK 1.2's flags and its params", "[plugins][model3d]") {
  pl::PluginHost host(options());
  host.scan();
  const pl::EffectSpec* spec = host.effect(kModel3d);
  REQUIRE(spec != nullptr);
  CHECK(spec->has(PR_OUT_FLAG_USES_SCENE_DEPTH));
  CHECK(spec->has(PR_OUT_FLAG_COMP_SPACE));
  CHECK(spec->has(PR_OUT_FLAG_USES_SHUTTER));
  CHECK(spec->has(PR_OUT_FLAG_SAMPLES_TIME));
  CHECK(spec->has(PR_OUT_FLAG_CUSTOM_OVERLAY));
  CHECK(pl::param_slot(*spec, kModel) >= 0);
  CHECK(pl::param_slot(*spec, kSceneDepth) >= 0);
}

TEST_CASE("model3d: the CPU path renders the built-in cube through the camera, deterministic", "[plugins][model3d]") {
  pl::PluginHost host(options());
  host.scan();
  const pl::EffectSpec* spec = host.effect(kModel3d);
  REQUIRE(spec != nullptr);
  const pl::RenderInputs in = inputs(*spec, "L/cube");
  const std::vector<float> a = render(host, in);
  const std::size_t n = coverage(a);
  // A 40 px cube turned 20° / 30°: more than its face, far less than the frame.
  CHECK(n > 40 * 40);
  CHECK(n < 70 * 64);
  CHECK(alpha_at(a, kW / 2, kH / 2) == 1.0F);
  CHECK(alpha_at(a, 2, 2) == 0.0F);
  CHECK(render(host, in) == a);  // the same frame twice: the same pixels

  // Size scales it; rotation turns it (another silhouette).
  pl::RenderInputs big = in;
  set_param(big, *spec, kSize, 50);
  CHECK(coverage(render(host, big)) > n);
  pl::RenderInputs turned = in;
  set_param(turned, *spec, kOrientX, 0);
  set_param(turned, *spec, kOrientY, 0);
  const std::size_t face = coverage(render(host, turned));
  CHECK(face < n);
  CHECK(face > 30 * 30);  // the front face alone, a little over 40 × 40 × (zoom / distance) … about 40²
}

TEST_CASE("model3d: a .glb and a .gltf + .bin (get_asset_sibling_bytes) give the same picture", "[plugins][model3d]") {
  pl::PluginHost host(options());
  host.scan();
  const pl::EffectSpec* spec = host.effect(kModel3d);
  REQUIRE(spec != nullptr);
  REQUIRE(fs::exists(models() / "box.glb"));
  pl::RenderInputs glb = inputs(*spec, "L/glb");
  set_file(glb, *spec, models() / "box.glb");
  pl::RenderInputs gltf = inputs(*spec, "L/gltf");
  set_file(gltf, *spec, models() / "box.gltf");
  const std::vector<float> a = render(host, glb);
  const std::vector<float> b = render(host, gltf);
  CHECK(coverage(a) > 0);
  CHECK(a == b);
  // The box's orange baseColorFactor tints it: red over blue at the centre.
  const std::size_t c = (std::size_t{kH / 2} * kW + kW / 2) * 4;
  CHECK(a[c] > a[c + 2]);
  // Not the built-in cube (a 2 × 1 × 1 box).
  CHECK(coverage(render(host, inputs(*spec, "L/cube"))) != coverage(a));
}

TEST_CASE("model3d: a missing model is the layer's error, never a crash", "[plugins][model3d]") {
  pl::PluginHost host(options());
  host.scan();
  const pl::EffectSpec* spec = host.effect(kModel3d);
  REQUIRE(spec != nullptr);
  pl::RenderInputs in = inputs(*spec, "L/missing");
  set_file(in, *spec, models() / "gone.glb", true);
  pl::TexelImage out;
  pl::CallResult r = pl::run_native_cpu(host, in, blank(), {}, out);
  CHECK_FALSE(r.ok);
  CHECK_FALSE(r.fault);
  CHECK(r.message.find("missing") != std::string::npos);
  CHECK_FALSE(host.instance_disabled(in.instance));  // an error return, not a fault: the next frame tries again

  // A file that is not a model: an error with the parser's reason.
  pl::RenderInputs bad = inputs(*spec, "L/bad");
  set_file(bad, *spec, models() / "checker.png");
  r = pl::run_native_cpu(host, bad, blank(), {}, out);
  CHECK_FALSE(r.ok);
  CHECK_FALSE(r.fault);
  CHECK(r.message.find("glTF") != std::string::npos);
}

TEST_CASE("model3d: scene depth on the CPU path — none without a GPU, occlusion with one", "[plugins][model3d][sdk12]") {
  pl::PluginHost host(options());
  host.scan();
  const pl::EffectSpec* spec = host.effect(kModel3d);
  REQUIRE(spec != nullptr);
  pl::RenderInputs in = inputs(*spec, "L/depth");
  const std::vector<float> plain = render(host, in);
  set_param(in, *spec, kSceneDepth, 1);
  // No depth source (the SDK's CPU host): PR_ERR_UNSUPPORTED, the model renders unoccluded.
  CHECK(render(host, in) == plain);

  // A depth nearer than the model everywhere: everything is behind it.
  const std::vector<float> nearDepth(std::size_t{kW} * kH, 10.0F);
  const std::vector<float> none = render(host, in, [&] { return &nearDepth; });
  CHECK(coverage(none) == 0);
  // +inf (nothing drawn) everywhere: the same as no depth.
  const std::vector<float> empty(std::size_t{kW} * kH, std::numeric_limits<float>::infinity());
  CHECK(render(host, in, [&] { return &empty; }) == plain);
  // A wall over the left half only: the left half of the model is gone.
  std::vector<float> wall = empty;
  for (std::uint32_t y = 0; y < kH; ++y) {
    for (std::uint32_t x = 0; x < kW / 2; ++x) wall[std::size_t{y} * kW + x] = 10.0F;
  }
  const std::vector<float> half = render(host, in, [&] { return &wall; });
  CHECK(coverage(half) > 0);
  CHECK(coverage(half) < coverage(plain));
  CHECK(alpha_at(half, kW / 2 - 4, kH / 2) == 0.0F);
  CHECK(alpha_at(half, kW / 2 + 4, kH / 2) == 1.0F);

  // Render Mode ▸ Scene Depth: red = z / 1000, blue where nothing is drawn.
  set_param(in, *spec, kRenderMode, 2);
  const std::vector<float> view = render(host, in, [&] { return &wall; });
  const std::size_t l = (std::size_t{kH / 2} * kW + 4) * 4;
  const std::size_t r = (std::size_t{kH / 2} * kW + kW - 4) * 4;
  CHECK(std::abs(view[l] - 0.01F) < 1e-6F);
  CHECK(view[r + 2] == 1.0F);
}

TEST_CASE("model3d: its own crash is contained (Debug ▸ Fault, child process)", "[plugins][model3d]") {
  for (const int fault : {2, 3, 5, 7}) {
    INFO("fault " << fault);
    CHECK(run_tool("--bits 32 crash-check com.premation.samples.model3d " + std::to_string(fault)) == 0);
  }
}

namespace {

namespace doc = premation::doc;
namespace api = premation::api;
using premation::js::Json;

/// comp px of world point p through a column-major projection · view.
std::array<double, 2> project(const std::vector<double>& proj, const std::vector<double>& view, const std::array<double, 3>& p) {
  std::array<double, 4> v{};
  for (std::size_t r = 0; r < 4; ++r) v.at(r) = view.at(r) * p[0] + view.at(4 + r) * p[1] + view.at(8 + r) * p[2] + view.at(12 + r);
  std::array<double, 4> c{};
  for (std::size_t r = 0; r < 4; ++r) c.at(r) = proj.at(r) * v[0] + proj.at(4 + r) * v[1] + proj.at(8 + r) * v[2] + proj.at(12 + r) * v[3];
  return {c[0] / c[3], c[1] / c[3]};
}
double view_z(const std::vector<double>& view, const std::array<double, 3>& p) {
  return view.at(2) * p[0] + view.at(6) * p[1] + view.at(10) * p[2] + view.at(14);
}

double scalar_of(const doc::NativeEdit& e, const std::string& key) {
  for (const auto& [k, v] : e.params) {
    if (k == key) return doc::get<doc::VK::scalar>(v);
  }
  FAIL("no write to " << key);
  return 0;
}

}  // namespace

TEST_CASE("model3d (SDK 1.2): the viewer handle follows the comp camera; a drag moves the model in the view plane",
          "[plugins][model3d][overlay][sdk12]") {
  pl::PluginHost host(options());
  (void)host.scan();
  const pl::EffectSpec* spec = host.effect(kModel3d);
  REQUIRE(spec != nullptr);
  // A camera off to the side, turned and tilted: Position's x / y is NOT where the model shows.
  motion::xf::Camera cam = motion::xf::default_camera(kW, kH);
  cam.position.x += 60;
  cam.orientation = motion::xf::Orientation{15, -10, std::nullopt};
  const motion::xf::Mat4 vm = motion::xf::camera_view_matrix(cam);
  const motion::xf::Mat4 pm = motion::xf::camera_projection_matrix(cam);
  api::RenderCamera3D rc;
  rc.view.assign(vm.begin(), vm.end());
  rc.projection.assign(pm.begin(), pm.end());
  rc.eye = {cam.position.x, cam.position.y, cam.position.z};

  doc::NativeActionRequest req;
  req.layer = "L";
  req.effectId = "m3d";
  req.type = kModel3d;
  req.params = Json::object();
  req.params.set("p2X", Json::number(30));  // no rendered instance: the layer size is 0, so these are world px
  req.params.set("p2Y", Json::number(20));
  req.params.set("p2Z", Json::number(50));
  req.timeSeconds = 0;
  const std::array<double, 3> pos{30, 20, 50};

  SECTION("an older host's view (no scene in the request): layer px at Position's x / y") {
    const auto r = host.draw_overlay(req);
    REQUIRE(std::holds_alternative<std::vector<doc::NativeOverlayItem>>(r));
    const auto& items = std::get<std::vector<doc::NativeOverlayItem>>(r);
    const auto h = std::ranges::find_if(items, [](const doc::NativeOverlayItem& i) { return i.kind == "handle"; });
    REQUIRE(h != items.end());
    CHECK(h->space == PR_OVERLAY_SPACE_LAYER);
    CHECK(h->points == std::vector<double>{30, 20});
  }

  doc::NativeScene scene;
  scene.compW = kW;
  scene.compH = kH;
  scene.camera = rc;
  req.scene = scene;

  SECTION("DRAW_OVERLAY reads the camera: the handle is the projected Position, in comp px") {
    const auto r = host.draw_overlay(req);
    REQUIRE(std::holds_alternative<std::vector<doc::NativeOverlayItem>>(r));
    const auto& items = std::get<std::vector<doc::NativeOverlayItem>>(r);
    REQUIRE(items.size() == 2);
    const auto expect = project(rc.projection, rc.view, pos);
    for (const doc::NativeOverlayItem& i : items) CHECK(i.space == PR_OVERLAY_SPACE_COMP);
    const auto h = std::ranges::find_if(items, [](const doc::NativeOverlayItem& i) { return i.kind == "handle"; });
    REQUIRE(h != items.end());
    REQUIRE(h->points.size() == 2);
    INFO("handle " << h->points[0] << "," << h->points[1] << " expect " << expect[0] << "," << expect[1]);
    CHECK(std::abs(h->points[0] - expect[0]) < 1e-6);
    CHECK(std::abs(h->points[1] - expect[1]) < 1e-6);
    CHECK(std::abs(h->points[0] - 30) > 5);  // not the naive layer-px spot
  }

  SECTION("OVERLAY_DRAG in comp px: the model lands under the pointer at its own camera depth") {
    const std::array<double, 2> target{70, 12};
    doc::NativeOverlayDrag d;
    d.handle = 1;
    d.phase = PR_OVERLAY_DRAG_MOVE;
    d.x = target[0];
    d.y = target[1];
    d.space = PR_OVERLAY_SPACE_COMP;
    const auto r = host.overlay_drag(req, d);
    REQUIRE(std::holds_alternative<doc::NativeEdit>(r));
    const auto& edit = std::get<doc::NativeEdit>(r);
    const std::array<double, 3> moved{scalar_of(edit, "p2X"), scalar_of(edit, "p2Y"), scalar_of(edit, "p2Z")};
    const auto at = project(rc.projection, rc.view, moved);
    INFO("moved to " << moved[0] << "," << moved[1] << "," << moved[2] << " → " << at[0] << "," << at[1]);
    CHECK(std::abs(at[0] - target[0]) < 1e-6);
    CHECK(std::abs(at[1] - target[1]) < 1e-6);
    CHECK(std::abs(view_z(rc.view, moved) - view_z(rc.view, pos)) < 1e-6);  // the view plane, at the model's depth
    CHECK(std::abs(moved[2] - pos[2]) > 1e-3);  // the camera is turned: the plane is not z = const
  }

  SECTION("a layer-px drag (an older editor) still moves x / y only") {
    doc::NativeOverlayDrag d;
    d.handle = 1;
    d.phase = PR_OVERLAY_DRAG_MOVE;
    d.x = 5;
    d.y = 6;
    const auto r = host.overlay_drag(req, d);
    REQUIRE(std::holds_alternative<doc::NativeEdit>(r));
    const auto& edit = std::get<doc::NativeEdit>(r);
    CHECK(scalar_of(edit, "p2X") == 5);
    CHECK(scalar_of(edit, "p2Y") == 6);
    CHECK(scalar_of(edit, "p2Z") == 50);
  }
}
