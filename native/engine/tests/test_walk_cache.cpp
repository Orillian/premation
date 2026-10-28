// The frame builder's walk memo (snapshot_build.hpp WalkCache): the walk used
// to re-flatten the composition, re-expand its instances and rebuild its by-id
// map on every frame (~all of a 3000-layer comp's per-frame fixed cost). The
// memo keeps that topology while the document is unchanged (its copy-on-write
// identity) and rebuilds it on an edit; what it hands the walk must build
// exactly the frame the walk built for itself.
#include <catch2/catch_test_macros.hpp>

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "docexpr.hpp"
#include "docio.hpp"
#include "json.hpp"
#include "model.hpp"
#include "snapshot_build.hpp"
#include "timeline.hpp"

namespace doc = premation::doc;
namespace sc = premation::scene;
using premation::js::Json;

namespace {

constexpr int kLayers = 500;

std::string layer_json(int i) {
  const std::string id = "L" + std::to_string(i);
  return R"({"id":")" + id + R"(","name":")" + id + R"(","children":[],"parent":"comp_root",)" +
         R"("transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},"components":[)" +
         R"({"id":")" + id + R"(_t","type":"Transform","props":{"__kind":"shape","x":)" + std::to_string(i) +
         R"(,"y":)" + std::to_string(i % 50) + R"(,"rotation":)" + std::to_string(i % 7) +
         R"(,"width":20,"height":20}},)" + R"({"id":")" + id +
         R"(_s","type":"Style","props":{"opacity":100,"fill":"#000"}},)" + R"({"id":")" + id +
         R"(_fx","type":"fx","props":{"solid":true,"fill":"#1f1e1d"}}],"visible":true,"locked":false})";
}

/// comp_root with kLayers solids; every tenth one has x and opacity keyframed over 0–2 s.
std::string project_json() {
  std::string children;
  std::string nodes;
  std::string tracks;
  for (int i = 0; i < kLayers; ++i) {
    const std::string id = "L" + std::to_string(i);
    if (i > 0) {
      children += ",";
      nodes += ",";
    }
    children += "\"" + id + "\"";
    nodes += layer_json(i);
    if (i % 10 == 0) {
      if (!tracks.empty()) tracks += ",";
      tracks += "\"" + id + R"(":{"x":[{"t":0,"value":)" + std::to_string(i) + R"(},{"t":2,"value":)" +
                std::to_string(i + 300) + R"(}],"opacity":[{"t":0,"value":100},{"t":2,"value":20}]})";
    }
  }
  return R"({"version":"1.9.0","scene":{"version":"1.0.0","nodes":[)"
         R"({"id":"comp_root","name":"Composition 1","parent":null,"children":[)" +
         children +
         R"(],"transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},"visible":true,"locked":false,)"
         R"("components":[{"id":"comp_root_meta","type":"group","props":{"__kind":"group"}}]},)" +
         nodes + R"(]},)" + R"("animation":{"tracks":{)" + tracks + R"(},"data":{},"expressions":{}},)" +
         R"("comps":{"comp_root":{"id":"comp_root","name":"comp_root","width":1920,"height":1080,"fps":30,)"
         R"("durationSeconds":10,"background":"#000000"}},)"
         R"("motionBlur":{"enabled":false,"shutterAngle":180,"shutterPhase":-90,"samples":8,"adaptiveSampleLimit":128},)"
         R"("openTabs":{"tabOrder":["tab1"],"activeTabId":"tab1","tabs":{"tab1":{"id":"tab1","compositionId":"comp_root",)"
         R"("breadcrumbPath":["comp_root"],"title":"comp_root","time":0,"frame":0}}}})";
}

/// What a frame says about each layer: order, and a few evaluated values.
struct Seen {
  std::string id;
  double x = 0, y = 0, rotation = 0, opacity = 0;
  bool visible = false;
  friend bool operator==(const Seen&, const Seen&) = default;
};

std::vector<Seen> seen(const sc::Snapshot& s) {
  std::vector<Seen> out;
  out.reserve(s.layers.size());
  for (const sc::RLayer& l : s.layers) out.push_back({l.id, l.x, l.y, l.rotation, l.opacity, l.visible});
  return out;
}

const Seen* find(const std::vector<Seen>& v, std::string_view id) {
  for (const Seen& s : v) {
    if (s.id == id) return &s;
  }
  return nullptr;
}

}  // namespace

TEST_CASE("the walk memo flattens once per document revision and builds the same frames", "[scene][perf]") {
  doc::Document d;
  doc::EditorView view;
  doc::ExprCache cache;
  const auto parsed = premation::js::parse(project_json());
  REQUIRE(parsed.has_value());
  (void)doc::restore_document(d, view, *parsed, {});
  REQUIRE(d.node("L499") != nullptr);

  const doc::DocExprEnv env(d, view, cache);
  sc::WalkCache memo;
  sc::BuildContext cached{d, view, env, cache, nullptr, {}};
  cached.walkCache = &memo;
  const sc::BuildContext plain{d, view, env, cache, nullptr, {}};
  const sc::SnapshotComp comp = sc::snapshot_comp_of(d, "comp_root");
  const auto build = [&](const sc::BuildContext& c, double t) { return seen(sc::build_snapshot(c, comp, t, std::nullopt)); };

  // Three frames: one flatten; each frame identical to the walk's own.
  std::vector<Seen> before;
  for (const double t : {0.0, 0.5, 1.0}) {
    std::vector<Seen> withMemo = build(cached, t);
    const std::vector<Seen> without = build(plain, t);
    REQUIRE(withMemo.size() >= static_cast<std::size_t>(kLayers));
    CHECK(withMemo == without);
    before = std::move(withMemo);  // the last: t = 1
  }
  CHECK(memo.flattens() == 1);
  CHECK(memo.revisions() == 1);
  REQUIRE(find(before, "L0") != nullptr);
  CHECK(find(before, "L0")->x != find(build(cached, 0.0), "L0")->x);  // animated: values stay per frame
  CHECK(memo.flattens() == 1);

  SECTION("an edit to a node is a new revision: re-flattened, and the frame shows it") {
    const double oldX = find(before, "L7")->x;
    doc::Component* t7 = d.node_mut("L7").comp_mut("Transform");
    REQUIRE(t7 != nullptr);
    t7->props.set("x", Json::number(999));
    const std::vector<Seen> after = build(cached, 1.0);
    CHECK(memo.flattens() == 2);
    CHECK(memo.revisions() == 2);
    CHECK(after == build(plain, 1.0));
    CHECK(find(after, "L7")->x != oldX);
    (void)build(cached, 1.5);
    CHECK(memo.flattens() == 2);
  }

  SECTION("a reorder of the comp's layers is a new revision: the walk's order follows") {
    std::vector<std::string>& kids = d.node_mut("comp_root").children;
    std::swap(kids.front(), kids.back());
    const std::vector<Seen> after = build(cached, 1.0);
    CHECK(memo.flattens() == 2);
    CHECK(after == build(plain, 1.0));
    CHECK(after != before);
  }

  SECTION("a keyframe edit leaves the topology alone; the value still follows") {
    std::vector<doc::Key>* x = d.anim_mut("L0").tracks.find("x");
    REQUIRE(x != nullptr);
    REQUIRE(x->size() == 2);
    (*x)[1].value = 5000;
    const std::vector<Seen> after = build(cached, 1.0);
    CHECK(memo.flattens() == 1);
    CHECK(after == build(plain, 1.0));
    CHECK(find(after, "L0")->x != find(before, "L0")->x);
  }

  SECTION("the Layer panel's walk is its own entry") {
    sc::BuildContext layerCached = cached;
    layerCached.layerView = sc::BuildContext::LayerView{};
    layerCached.layerView->id = "L3";
    sc::BuildContext layerPlain = plain;
    layerPlain.layerView = layerCached.layerView;
    const std::vector<Seen> one = build(layerCached, 0.5);
    CHECK(memo.flattens() == 2);
    CHECK(one == build(layerPlain, 0.5));
    CHECK(find(one, "L3") != nullptr);
    CHECK(find(one, "L4") == nullptr);
    (void)build(layerCached, 0.75);
    (void)build(cached, 0.75);
    CHECK(memo.flattens() == 2);
  }
}
