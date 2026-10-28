// A layer parented to another layer keeps its In/Out in its own composition,
// whichever composition the editor's tab shows. Its bar lives on the comp's
// track (write_geoms writes it there); the walk read the TAB's track instead,
// found nothing, and drew the layer at every time — a film authored as beats
// under nulls in a second composition showed every beat at once.
#include <catch2/catch_test_macros.hpp>

#include <string_view>

#include "docexpr.hpp"
#include "docio.hpp"
#include "json.hpp"
#include "model.hpp"
#include "snapshot_build.hpp"
#include "timeline.hpp"

namespace doc = premation::doc;
namespace sc = premation::scene;

namespace {

// Two comps; the tab shows comp_root. comp_b holds `rig` (a null) with `card`
// (a solid) parented to it.
const char* kProject = R"json({
  "version":"1.9.0",
  "scene":{"version":"1.0.0","nodes":[
    {"id":"comp_root","name":"Composition 1","parent":null,"children":[],
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},"visible":true,"locked":false,
     "components":[{"id":"comp_root_meta","type":"group","props":{"__kind":"group"}}]},
    {"id":"comp_b","name":"Film","parent":null,"children":["rig"],
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},"visible":true,"locked":false,
     "components":[{"id":"comp_b_meta","type":"group","props":{"__kind":"group"}}]},
    {"id":"rig","name":"rig","children":["card"],"parent":"comp_b",
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[{"id":"rig_t","type":"Transform","props":{"__kind":"null","x":0,"y":0,"rotation":0,"width":100,"height":100}}],
     "visible":true,"locked":false},
    {"id":"card","name":"card","children":[],"parent":"rig",
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":"card_t","type":"Transform","props":{"__kind":"shape","x":160,"y":110,"rotation":0,"width":320,"height":220}},
       {"id":"card_s","type":"Style","props":{"opacity":100,"fill":"#000"}},
       {"id":"card_fx","type":"fx","props":{"solid":true,"fill":"#1f1e1d"}}],
     "visible":true,"locked":false}
  ]},
  "comps":{
    "comp_root":{"id":"comp_root","name":"comp_root","width":320,"height":220,"fps":30,"durationSeconds":10,"background":"#000000"},
    "comp_b":{"id":"comp_b","name":"Film","width":320,"height":220,"fps":30,"durationSeconds":10,"background":"#f0eee6"}},
  "motionBlur":{"enabled":false,"shutterAngle":180,"shutterPhase":-90,"samples":8,"adaptiveSampleLimit":128},
  "openTabs":{"tabOrder":["tab1"],"activeTabId":"tab1","tabs":{"tab1":{"id":"tab1","compositionId":"comp_root","breadcrumbPath":["comp_root"],"title":"comp_root","time":0,"frame":0}}}
})json";

bool draws(const sc::Snapshot& s, std::string_view id) {
  for (const sc::RLayer& l : s.layers) {
    if (l.id == id) return l.visible;
  }
  return false;
}

}  // namespace

TEST_CASE("a nested layer's bar gates it in a composition the tab does not show", "[scene][timeline]") {
  doc::Document d;
  doc::EditorView view;
  doc::ExprCache cache;
  const auto parsed = premation::js::parse(kProject);
  REQUIRE(parsed.has_value());
  (void)doc::restore_document(d, view, *parsed, {});
  REQUIRE(view.tabComp == "comp_root");
  // Frames 30–60 of comp_b: 1 s → 2 s.
  doc::write_geoms(d, "comp_b", "card", {doc::Geo{.start = 30, .duration = 30, .sourceIn = 0, .sourceDuration = std::nullopt}});
  REQUIRE(doc::tl_owner_comp(d, view, "card") == "comp_b");

  const doc::DocExprEnv env(d, view, cache);
  const sc::BuildContext ctx{d, view, env, cache, nullptr, {}};
  const sc::SnapshotComp comp = sc::snapshot_comp_of(d, "comp_b");
  CHECK_FALSE(draws(sc::build_snapshot(ctx, comp, 0.5, std::nullopt), "card"));
  CHECK(draws(sc::build_snapshot(ctx, comp, 1.5, std::nullopt), "card"));
  CHECK_FALSE(draws(sc::build_snapshot(ctx, comp, 2.5, std::nullopt), "card"));
}
