// Plugin SDK 1.2 — the frame hook (plugins/scene_finish.cpp) over a real
// document: the golden scene render-tests/scenes/plugin-particles-orbit.json
// (the `particles` sample on a comp-sized solid, the comp camera orbiting it).
//
//   S3  the chain entry carries the LAYER's time (start offset) and layer_start;
//   S1  checkout_time samples are evaluated off the document — the camera and
//       the params at each requested time, sub-frame exact, the same values a
//       frame built at that time carries — and travel in the entry;
//   S2  the shutter reaches the effect, and a USES_SHUTTER effect's layer is
//       not supersampled through it;
//   S4  a COMP_SPACE effect's reach grows its layer's buffer.
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <filesystem>
#include <fstream>
#include <memory>
#include <optional>
#include <sstream>
#include <string>

#include "docexpr.hpp"
#include "docio.hpp"
#include "fx_wire.hpp"
#include "host.hpp"
#include "json.hpp"
#include "model.hpp"
#include "native_scene.hpp"
#include "scene_finish.hpp"
#include "timeline.hpp"

namespace pl = premation::plugins;
namespace doc = premation::doc;
namespace sc = premation::scene;
namespace api = premation::api;
namespace fs = std::filesystem;
using premation::js::Json;

namespace {

constexpr const char* kParticles = "com.premation.samples.particles";
constexpr double kFlicks = PR_TIME_SCALE;

Json scene_json() {
  std::ifstream f(fs::path(PREMATION_GOLDEN_SCENES) / "plugin-particles-orbit.json", std::ios::binary);
  std::stringstream ss;
  ss << f.rdbuf();
  auto j = premation::js::parse(ss.str());
  REQUIRE(j.has_value());
  return *j;
}

Json* find_node(Json& doc, std::string_view id) {
  for (Json& n : doc.find_mut("scene")->find_mut("nodes")->arr_mut()) {
    if (n.at("id").str() == id) return &n;
  }
  return nullptr;
}

Json& fx_props(Json& node) {
  for (Json& c : node.find_mut("components")->arr_mut()) {
    if (c.at("type").str() == "fx") return *c.find_mut("props");
  }
  FAIL("no fx component");
  return node;
}

Json keys(std::initializer_list<std::pair<double, double>> list) {
  Json::Array a;
  for (const auto& [t, v] : list) {
    Json k = Json::object();
    k.set("t", Json::number(t));
    k.set("value", Json::number(v));
    a.push_back(std::move(k));
  }
  return Json::array(std::move(a));
}

void add_track(Json& doc, const std::string& node, const std::string& prop, Json keyframes) {
  Json& tracks = *doc.find_mut("animation")->find_mut("tracks");
  if (tracks.at(node).is_undefined()) tracks.set(node, Json::object());
  Json t = Json::object();
  t.set("nodeId", Json::string(node));
  t.set("prop", Json::string(prop));
  t.set("keyframes", std::move(keyframes));
  tracks.find_mut(node)->set(prop, std::move(t));
}

struct Fixture {
  explicit Fixture(Json document) {
    pl::HostOptions o;
    o.searchPaths = {fs::path(PREMATION_PLUGIN_BUNDLES)};
    o.threads = 2;
    o.onHang = [](const std::string&, std::string_view) { FAIL("unexpected hang"); };
    host = std::make_unique<pl::PluginHost>(std::move(o));  // registers the effects before the document opens
    (void)host->scan();
    REQUIRE(host->effect(kParticles) != nullptr);
    (void)doc::restore_document(d, view, document, {});
    env = std::make_unique<doc::DocExprEnv>(d, view, cache);
  }

  struct Built {
    api::Renderable solid;
    api::RenderEffect entry;
  };
  Built frame(double t, bool motionBlur = false) {
    const sc::BuildContext ctx{d, view, *env, cache, nullptr, {}};
    const sc::ViewSpec vs = sc::export_view(480, 360, 480, 360);
    sc::NativeFrame nf = sc::build_native_frame(ctx, "comp_root", t, vs, motionBlur);
    pl::finish_native_frame(ctx, "comp_root", t, vs, motionBlur, nf, host.get());
    const api::Renderable* r = pl::find_renderable_in(nf.file.scene.renderables, "solid");
    REQUIRE(r != nullptr);
    Built b;
    b.solid = *r;
    for (const api::RenderEffect& e : r->effects) {
      if (e.type == pl::kNativeFxType) b.entry = e;
    }
    REQUIRE(b.entry.type == pl::kNativeFxType);
    return b;
  }
  pl::RenderInputs decode(const api::RenderEffect& e) const {
    pl::RenderInputs in;
    pl::decode_native_fx(e, *host->effect(kParticles), in);
    return in;
  }

  std::unique_ptr<pl::PluginHost> host;
  doc::Document d;
  doc::EditorView view;
  doc::ExprCache cache;
  std::unique_ptr<doc::DocExprEnv> env;
};

double num(const api::RenderEffect& e, std::string_view name) {
  for (const auto& p : e.params) {
    if (p.name == name) return p.number;
  }
  return NAN;
}

std::int64_t flicks(double s) { return static_cast<std::int64_t>(std::llround(s * kFlicks)); }

}  // namespace

TEST_CASE("SDK 1.2 S3: the effect gets its layer's time", "[plugins][finish]") {
  Fixture f(scene_json());
  // At first the layer starts with the comp: layer time = comp time.
  pl::RenderInputs in = f.decode(f.frame(1.0).entry);
  CHECK(in.compTime == flicks(1.0));
  CHECK(in.layerTime == flicks(1.0));
  CHECK(in.layerStart == 0);
  CHECK(in.compW == 480);
  CHECK(in.compH == 360);
  CHECK_FALSE(in.layer3d);

  // Slide the layer to start at frame 15 (0.5 s): at comp 1 s it is 0.5 s into its own time.
  REQUIRE(doc::tl_ensure(f.d, "comp_root"));  // the layers' bars (the golden document carries none)
  bool moved = false;
  for (doc::Bar& b : f.d.timeline_mut("comp_root").bars) {
    if (b.sourceId && *b.sourceId == "solid") {
      b.clip.start = 15;
      moved = true;
    }
  }
  REQUIRE(moved);
  in = f.decode(f.frame(1.0).entry);
  CHECK(in.compTime == flicks(1.0));
  CHECK(in.layerTime == flicks(0.5));
  CHECK(in.layerStart == flicks(0.5));
}

TEST_CASE("SDK 1.2 S1: checkout_time samples are evaluated off the document", "[plugins][finish]") {
  Json document = scene_json();
  // Velocity keyed 100 → 200 over the first second: a sample must carry ITS time's value.
  add_track(document, "solid", "effect.fx.p3", keys({{0, 100}, {1, 200}}));
  Fixture f(std::move(document));
  const double t = 0.5;
  const Fixture::Built b = f.frame(t);
  const pl::RenderInputs in = f.decode(b.entry);
  // Trail Length 3: the three frames before this one, everything sampled.
  REQUIRE(in.samples.size() == 3);
  const std::int64_t step = flicks(1.0 / 30);
  for (std::size_t i = 0; i < 3; ++i) {
    const pl::TimeSample& s = in.samples[i];
    INFO("sample " << i);
    CHECK(s.time == in.layerTime - static_cast<std::int64_t>(3 - i) * step);
    CHECK(s.what == PR_SAMPLE_ALL);
    // The same values a frame built at that time carries — camera and params.
    const pl::RenderInputs at = f.decode(f.frame(static_cast<double>(s.time) / kFlicks).entry);
    REQUIRE(s.camera.has_value());
    REQUIRE(at.camera.has_value());
    CHECK(s.camera->hasCamera);
    for (std::size_t k = 0; k < 16; ++k) {
      CHECK(std::abs(s.camera->view.at(k) - at.camera->view.at(k)) < 1e-6 * std::max(1.0, std::abs(at.camera->view.at(k))));
      CHECK(std::abs(s.camera->projection.at(k) - at.camera->projection.at(k)) < 1e-6 * std::max(1.0, std::abs(at.camera->projection.at(k))));
    }
    REQUIRE(s.values.size() == at.values.size());
    CHECK(std::abs(s.values[2].v[0] - at.values[2].v[0]) < 1e-9);  // p3 (Velocity)
  }
  // The camera orbits: the samples are not the frame's camera.
  REQUIRE(in.camera.has_value());
  CHECK(std::abs(in.samples[0].camera->view[12] - in.camera->view[12]) > 1);
  // Velocity at t - 3 frames: 100 + 100 × (0.5 − 0.1).
  CHECK(std::abs(in.samples[0].values[2].v[0] - 140) < 1e-6);
  CHECK(std::abs(in.values[2].v[0] - 150) < 1e-6);

  SECTION("between frames (a shutter), the time is exact, not the nearest frame") {
    // Comp motion blur on, the layer's switch on: the shutter's sub-frame times come back.
    Json mbDoc = scene_json();
    add_track(mbDoc, "solid", "effect.fx.p3", keys({{0, 100}, {1, 200}}));
    mbDoc.find_mut("motionBlur")->set("enabled", Json::boolean(true));
    fx_props(*find_node(mbDoc, "solid")).set("motionBlur", Json::boolean(true));
    Fixture g(std::move(mbDoc));
    const pl::RenderInputs mb = g.decode(g.frame(t, true).entry);
    CHECK(mb.motionBlur);
    CHECK(mb.shutterAngle == 180);
    CHECK(mb.shutterPhase == -90);
    // 8 shutter samples (the comp's), the frame's own time among none of them, plus the trail.
    REQUIRE(mb.samples.size() == 3 + 8);
    bool between = false;
    for (const pl::TimeSample& s : mb.samples) {
      if (s.time % step == 0) continue;
      between = true;
      const double expect = 100 + 100 * (static_cast<double>(s.time) / kFlicks);
      CHECK(std::abs(s.values[2].v[0] - expect) < 1e-6);
    }
    CHECK(between);
  }
}

TEST_CASE("SDK 1.2 S2: a USES_SHUTTER effect's layer is not supersampled through it", "[plugins][finish]") {
  Json document = scene_json();
  document.find_mut("motionBlur")->set("enabled", Json::boolean(true));
  fx_props(*find_node(document, "solid")).set("motionBlur", Json::boolean(true));
  // The solid moves fast: the comp's motion blur would draw it at 8 shutter samples.
  add_track(document, "solid", "x", keys({{0, 0}, {1, 480}}));
  Fixture f(std::move(document));
  const Fixture::Built blurred = f.frame(0.5, true);
  CHECK(num(blurred.entry, "mb") == 1);
  CHECK(blurred.solid.motion_samples.empty());  // particles blurs itself (PR_OUT_FLAG_USES_SHUTTER)
  // The viewer's motion blur off: the effect is told so.
  CHECK(num(f.frame(0.5, false).entry, "mb") == 0);
}

TEST_CASE("SDK 1.2 S4: a COMP_SPACE effect reaches the comp", "[plugins][finish]") {
  Fixture f(scene_json());
  CHECK(std::abs(num(f.frame(0).entry, "reachPx") - std::hypot(480.0, 360.0)) < 1e-9);
}
