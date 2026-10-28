// Plugin SDK 1.3 — Effect Controls boxes (PR_PARAM_CUSTOM_UI) against the `rings` sample:
// the box is registered beside the params (placed like a button, with its height), the
// host runs DRAW_PARAM_UI with the box's size and collects fills / text / lines / handles,
// PARAM_UI_DRAG writes what the plugin sets, and the viewer overlay is unchanged by it.

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <string>
#include <variant>
#include <vector>

#include "host.hpp"
#include "json.hpp"
#include "native_effects.hpp"
#include "values.hpp"

namespace pl = premation::plugins;
namespace doc = premation::doc;
namespace fs = std::filesystem;

namespace {

constexpr const char* kRings = "com.premation.samples.rings";
constexpr double kWidth = 300;
// rings.cpp: the track runs from kPad to width − kPad at y 50; Spacing 2..200.
constexpr double kPad = 10;
double track_x(double spacing) { return kPad + (spacing - 2) / 198 * (kWidth - 2 * kPad); }

pl::HostOptions options() {
  pl::HostOptions o;
  o.searchPaths = {fs::path(PREMATION_PLUGIN_BUNDLES)};
  o.threads = 2;
  o.attachToDocument = true;
  o.onHang = [](const std::string&, std::string_view) { FAIL("unexpected hang"); };
  return o;
}

doc::NativeActionRequest request(double spacing, const std::string& box = "p11") {
  doc::NativeActionRequest req;
  req.layer = "L";
  req.effectId = "rings";
  req.type = kRings;
  req.params = premation::js::Json::object();
  req.params.set("p2", premation::js::Json::number(spacing));
  req.paramUi = doc::NativeParamUiTarget{box, kWidth, 64};
  return req;
}

}  // namespace

TEST_CASE("SDK 1.3: a custom UI box is drawn and dragged by the plugin", "[plugins][sdk13]") {
  pl::PluginHost host(options());
  (void)host.scan();

  const doc::NativeEffect* ne = doc::NativeEffects::find(kRings);
  REQUIRE(ne != nullptr);
  REQUIRE(ne->customUis.size() == 1);
  const doc::NativeCustomUi& box = ne->customUis.front();
  CHECK(box.key == "p11");
  CHECK(box.label == "Palette");
  CHECK(box.height == 64);
  // Declared after Opacity (p7): every document param before it, buttons after it.
  const auto opacity = std::ranges::find(ne->def.params, std::string("p7"), &doc::EffectParamDef::key);
  REQUIRE(opacity != ne->def.params.end());
  CHECK(box.at == static_cast<std::uint32_t>(opacity - ne->def.params.begin() + 1));
  CHECK(box.afterButtons == 0);  // declared before Shuffle Palette, which shares its place
  // Not a document property: no param for its key.
  CHECK(std::ranges::find(ne->def.params, std::string("p11"), &doc::EffectParamDef::key) == ne->def.params.end());

  SECTION("DRAW_PARAM_UI: the palette as fills, the label, the track, the Spacing handle") {
    const auto r = host.draw_overlay(request(24));
    REQUIRE(std::holds_alternative<std::vector<doc::NativeOverlayItem>>(r));
    const auto& items = std::get<std::vector<doc::NativeOverlayItem>>(r);
    CHECK(std::ranges::count(items, std::string("fill"), &doc::NativeOverlayItem::kind) == 6);
    const auto text = std::ranges::find(items, std::string("text"), &doc::NativeOverlayItem::kind);
    REQUIRE(text != items.end());
    CHECK(text->text == "Spacing 24 px");
    CHECK(text->size == 11);
    CHECK(text->color.empty());  // NULL: the editor's theme colour
    const auto handle = std::ranges::find(items, std::string("handle"), &doc::NativeOverlayItem::kind);
    REQUIRE(handle != items.end());
    CHECK(handle->shape == PR_OVERLAY_HANDLE_CIRCLE);
    CHECK(std::abs(handle->points.at(0) - track_x(24)) < 1e-9);
    for (const auto& i : items) CHECK(i.space == PR_OVERLAY_SPACE_LAYER);
  }

  SECTION("PARAM_UI_DRAG: Spacing follows the handle") {
    doc::NativeOverlayDrag d;
    d.handle = 1;
    d.phase = PR_OVERLAY_DRAG_END;
    d.x = track_x(101);
    d.y = 50;
    d.startX = track_x(24);
    d.startY = 50;
    const auto r = host.overlay_drag(request(24), d);
    REQUIRE(std::holds_alternative<doc::NativeEdit>(r));
    const auto& edit = std::get<doc::NativeEdit>(r);
    REQUIRE(edit.params.size() == 1);
    CHECK(edit.params.front().first == "p2");
    CHECK(doc::get<doc::VK::scalar>(edit.params.front().second) == 101);
  }

  SECTION("a key that is not a custom UI param fails; the viewer overlay draws no box items") {
    CHECK(std::holds_alternative<doc::NativeFailure>(host.draw_overlay(request(24, "p2"))));
    doc::NativeActionRequest viewer = request(24);
    viewer.paramUi.reset();
    const auto r = host.draw_overlay(viewer);
    REQUIRE(std::holds_alternative<std::vector<doc::NativeOverlayItem>>(r));
    for (const auto& i : std::get<std::vector<doc::NativeOverlayItem>>(r)) CHECK((i.kind == "path" || i.kind == "handle"));
  }
}
