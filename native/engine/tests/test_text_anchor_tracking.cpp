// The three text-anchoring gaps of docs/AUDIT_2026-10-18_TEXT.md §5, over the
// scene port's TextMeasurer with the render-tests harness fonts:
//
//   - `textAnchor: alignment` on VERTICAL type anchors the column at its top
//     edge (align left), centre, or bottom edge (align right), x at the column;
//   - the vertical anchor of horizontal point text is its FIRST BASELINE, not
//     the box centre: one leading higher per extra line, under baseline shift;
//   - a per-range `tracking` (1/1000 em) on a run resolves at the RUN's font
//     size — in the measurer's widths and glyph pens (this file) and in the
//     painter's merged run style (raster TextStyle::merged).

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "docio.hpp"
#include "json.hpp"
#include "model.hpp"
#include "raster/canvas.hpp"
#include "raster/fonts.hpp"
#include "raster/json.hpp"
#include "raster/text_layout.hpp"
#include "text_measure.hpp"
#include "text_query.hpp"

namespace doc = premation::doc;
namespace sc = premation::scene;
namespace raster = premation::raster;
using Catch::Matchers::WithinAbs;

namespace {

const raster::FontSet& harness_fonts() {
  static const raster::FontSet* fonts = [] {
    static raster::FontSet f{raster::FontOptions{}};
    std::string err;
    REQUIRE(f.load_manifest(PREMATION_RASTER_FONTS, err));
    return &f;
  }();
  return *fonts;
}

std::unique_ptr<sc::TextMeasurer> measurer() {
  raster::CanvasOptions opts;
  opts.fonts = &harness_fonts();
  return sc::make_canvas_measurer(opts);
}

/// A document with one text layer `t` (Arial 48 px, white) saying `content`,
/// with `extraProps` (JSON members, leading comma included) on its Text component.
std::unique_ptr<doc::Document> text_doc(const std::string& content, const std::string& extraProps) {
  std::string escaped;
  for (const char c : content) {
    if (c == '\n') escaped += "\\n";
    else escaped.push_back(c);
  }
  const std::string json = std::string(R"json({"version":"1.9.0","scene":{"version":"1.0.0","nodes":[
    {"id":"comp_root","name":"C","parent":null,"children":["t"],"visible":true,"locked":false,
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[{"id":"comp_root_meta","type":"group","props":{"__kind":"group"}}]},
    {"id":"t","name":"t","parent":"comp_root","children":[],"visible":true,"locked":false,
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":"t_t","type":"Transform","props":{"__kind":"text","x":320,"y":180,"rotation":0,"scaleX":100,"scaleY":100}},
       {"id":"t_s","type":"Style","props":{"opacity":100,"fill":"#ffffff"}},
       {"id":"t_x","type":"Text","props":{"content":")json") + escaped +
                           R"json(","fontSize":48,"fontFamily":"Arial","fontWeight":"400")json" + extraProps + R"json(}}]}]},
  "animation":{"tracks":{},"data":{},"expressions":{}},
  "comps":{"comp_root":{"id":"comp_root","name":"C","width":640,"height":360,"fps":30,"durationSeconds":10,"background":"#101014"}}
})json";
  const auto parsed = premation::js::parse(json);
  REQUIRE(parsed.has_value());
  auto d = std::make_unique<doc::Document>();
  doc::EditorView view;
  (void)doc::restore_document(*d, view, *parsed, {});
  return d;
}

struct Anchored {
  sc::PointTextAnchor anchor;
  double width = 0;
  double height = 0;
};

Anchored anchor_of(const std::string& content, const std::string& extraProps) {
  const auto m = measurer();
  const auto d = text_doc(content, extraProps);
  const doc::Node* n = d->node("t");
  REQUIRE(n != nullptr);
  const auto style = sc::read_measured_text_style(*n, {});
  REQUIRE(style.has_value());
  const auto size = m->measure_text_size(*style);
  REQUIRE(size.has_value());
  return {sc::point_text_anchor(*m, *n, *style, size->first, size->second), size->first, size->second};
}

double width_of(const std::string& content, const std::string& extraProps) {
  const auto m = measurer();
  const auto d = text_doc(content, extraProps);
  const auto style = sc::read_measured_text_style(*d->node("t"), {});
  REQUIRE(style.has_value());
  const auto size = m->measure_text_size(*style);
  REQUIRE(size.has_value());
  return size->first;
}

raster::json::Value run_style(const std::string& json) {
  raster::json::Value v;
  std::string err;
  REQUIRE(raster::json::parse(json, v, err));
  return v;
}

}  // namespace

TEST_CASE("text anchor: horizontal point text anchors at its alignment edge AND its first baseline", "[text][anchor]") {
  const Anchored left = anchor_of("Hxg", R"(,"align":"left")");
  const double half = (left.width - 2 * sc::kTextPadX) / 2;
  CHECK_THAT(left.anchor.x, WithinAbs(-half, 1e-9));
  // The baseline sits below the box centre by the face's (ascent - descent) / 2
  // — a fraction of the em, never the centre itself and never a whole line.
  CHECK(left.anchor.y > 1);
  CHECK(left.anchor.y < 48 * 0.5);

  const Anchored right = anchor_of("Hxg", R"(,"align":"right")");
  CHECK_THAT(right.anchor.x, WithinAbs(half, 1e-9));
  CHECK_THAT(right.anchor.y, WithinAbs(left.anchor.y, 1e-9));

  const Anchored centre = anchor_of("Hxg", R"(,"align":"center")");
  CHECK_THAT(centre.anchor.x, WithinAbs(0, 1e-9));
  CHECK_THAT(centre.anchor.y, WithinAbs(left.anchor.y, 1e-9));
}

TEST_CASE("text anchor: a second line moves the first baseline half a leading up; baseline shift moves it with the text", "[text][anchor]") {
  const Anchored one = anchor_of("Hxg", R"(,"align":"left")");
  const Anchored two = anchor_of("Hxg\nHxg", R"(,"align":"left")");
  const double leading = 48 * sc::kDefaultLineHeight;
  CHECK_THAT(two.anchor.y, WithinAbs(one.anchor.y - leading / 2, 1e-6));
  const Anchored three = anchor_of("Hxg\nHxg\nHxg", R"(,"align":"left","lineHeight":1.5)");
  CHECK_THAT(three.anchor.y, WithinAbs(one.anchor.y - 48 * 1.5, 1e-6));
  // Baseline Shift raises the glyphs (the painter translates by -shift); the anchor follows.
  const Anchored shifted = anchor_of("Hxg", R"(,"align":"left","baselineShift":10)");
  CHECK_THAT(shifted.anchor.y, WithinAbs(one.anchor.y - 10, 1e-6));
  // Vertical Scale scales the stack about the centre: the baseline offset scales with it.
  const Anchored tall = anchor_of("Hxg", R"(,"align":"left","verticalScale":200)");
  CHECK_THAT(tall.anchor.y, WithinAbs(one.anchor.y * 2, 1e-6));
}

TEST_CASE("text anchor: a paragraph box keeps its vertical anchor at the box centre", "[text][anchor]") {
  const Anchored box = anchor_of("Hxg", R"(,"align":"left","boxWidth":300)");
  CHECK_THAT(box.anchor.y, WithinAbs(0, 1e-9));
  CHECK_THAT(box.anchor.x, WithinAbs(-(box.width - 2 * sc::kTextPadX) / 2, 1e-9));
}

TEST_CASE("text anchor: vertical type anchors its column at the top (left), centre, or bottom (right) edge", "[text][anchor][vertical]") {
  const Anchored top = anchor_of("Hxg", R"(,"orientation":"vertical","align":"left")");
  const double half = (top.height - 2 * sc::kTextPadY) / 2;
  CHECK(half > 24);  // three glyphs stacked: taller than one em
  CHECK_THAT(top.anchor.y, WithinAbs(-half, 1e-9));
  CHECK_THAT(top.anchor.x, WithinAbs(0, 1e-9));
  const Anchored centre = anchor_of("Hxg", R"(,"orientation":"vertical","align":"center")");
  CHECK_THAT(centre.anchor.y, WithinAbs(0, 1e-9));
  const Anchored bottom = anchor_of("Hxg", R"(,"orientation":"vertical","align":"right")");
  CHECK_THAT(bottom.anchor.y, WithinAbs(half, 1e-9));
  CHECK_THAT(bottom.anchor.x, WithinAbs(0, 1e-9));
}

TEST_CASE("per-range tracking: the measurer opens a run's gaps by its tracking at the RUN's size", "[text][tracking]") {
  // "HHHH" at 48 px: a run over the first two graphemes tracks the two gaps
  // after them (the layer's spacing stays on the third).
  const double plain = width_of("HHHH", "");
  const double tracked = width_of("HHHH", R"(,"__runsIndex":"grapheme","__runs":[{"start":0,"end":2,"style":{"tracking":500}}])");
  CHECK_THAT(tracked - plain, WithinAbs(2 * 0.5 * 48, 1.01));  // widths are ceil'ed
  // The same run at its own 96 px size: twice the px per gap.
  const double big = width_of("HHHH", R"(,"__runsIndex":"grapheme","__runs":[{"start":0,"end":2,"style":{"fontSize":96,"tracking":500}}])");
  CHECK_THAT(big - plain, WithinAbs(2 * 0.5 * 96, 1.01));
  // A legacy px run replaces the spacing outright.
  const double px = width_of("HHHH", R"(,"__runsIndex":"grapheme","__runs":[{"start":1,"end":3,"style":{"letterSpacing":10}}])");
  CHECK_THAT(px - plain, WithinAbs(20, 1.01));
  // A layer tracking follows a run that only changes the size.
  const double layerTracked = width_of("HHHH", R"(,"tracking":250)");
  const double layerTrackedBig =
      width_of("HHHH", R"(,"tracking":250,"__runsIndex":"grapheme","__runs":[{"start":0,"end":2,"style":{"fontSize":96}}])");
  CHECK_THAT(layerTrackedBig - layerTracked, WithinAbs(2 * 0.25 * (96 - 48), 1.01));
}

TEST_CASE("per-range tracking: the glyph pens carry a run's spacing grapheme by grapheme", "[text][tracking]") {
  const auto m = measurer();
  const auto plainDoc = text_doc("HHHH", "");
  const auto runDoc = text_doc("HHHH", R"(,"__runsIndex":"grapheme","__runs":[{"start":0,"end":2,"style":{"tracking":500}}])");
  const auto plain = sc::read_measured_text_style(*plainDoc->node("t"), {});
  const auto run = sc::read_measured_text_style(*runDoc->node("t"), {});
  REQUIRE((plain && run));
  REQUIRE(run->spacingRuns.size() == 1);
  CHECK_THAT(run->spacingRuns[0].px, WithinAbs(24, 1e-9));
  const auto a = m->measure_glyph_lines(*plain);
  const auto b = m->measure_glyph_lines(*run);
  REQUIRE((a && b));
  REQUIRE(a->size() == 1);
  REQUIRE(b->at(0).pens.size() == 4);
  CHECK_THAT(b->at(0).pens[0] - a->at(0).pens[0], WithinAbs(24, 1e-6));
  CHECK_THAT(b->at(0).pens[1] - a->at(0).pens[1], WithinAbs(48, 1e-6));
  CHECK_THAT(b->at(0).pens[2] - a->at(0).pens[2], WithinAbs(48, 1e-6));  // the third gap is the layer's (0)
  CHECK_THAT(b->at(0).width - a->at(0).width, WithinAbs(48, 1e-6));
}

TEST_CASE("per-range tracking: TextStyle::merged resolves a run's tracking at the run's size, replacing the base's", "[text][tracking][raster]") {
  raster::TextStyle base;
  base.fontSize = 40;
  base.tracking = 100;
  base.letterSpacing = 4;  // 100 / 1000 × 40, as the snapshot folds it
  // A run that only changes the size re-resolves the layer's tracking (AE: em per character).
  const raster::TextStyle bigger = base.merged(run_style(R"({"fontSize":80})"));
  CHECK_THAT(bigger.letterSpacing.value_or(-1), WithinAbs(8, 1e-9));
  // A run's own tracking replaces the base's, at the run's size.
  const raster::TextStyle tracked = base.merged(run_style(R"({"tracking":500})"));
  CHECK_THAT(tracked.letterSpacing.value_or(-1), WithinAbs(20, 1e-9));
  const raster::TextStyle trackedBig = base.merged(run_style(R"({"fontSize":80,"tracking":500})"));
  CHECK_THAT(trackedBig.letterSpacing.value_or(-1), WithinAbs(40, 1e-9));
  // Tracking 0 on the run: the base's px under the tracking (none here).
  const raster::TextStyle untracked = base.merged(run_style(R"({"tracking":0})"));
  CHECK_THAT(untracked.letterSpacing.value_or(-1), WithinAbs(0, 1e-9));
  // A legacy px run alone replaces the spacing outright, tracking included.
  const raster::TextStyle px = base.merged(run_style(R"({"letterSpacing":3})"));
  CHECK_THAT(px.letterSpacing.value_or(-1), WithinAbs(3, 1e-9));
  CHECK_FALSE(px.tracking.has_value());
  // px + tracking on one run: the px under the tracking at the run's size.
  const raster::TextStyle both = base.merged(run_style(R"({"letterSpacing":3,"tracking":100,"fontSize":80})"));
  CHECK_THAT(both.letterSpacing.value_or(-1), WithinAbs(11, 1e-9));
  // A base with a raw px under its tracking keeps that px under a run's tracking.
  raster::TextStyle rawBase;
  rawBase.fontSize = 40;
  rawBase.tracking = 100;
  rawBase.letterSpacing = 6;  // 2 px raw + 4 px tracking
  const raster::TextStyle over = rawBase.merged(run_style(R"({"tracking":250})"));
  CHECK_THAT(over.letterSpacing.value_or(-1), WithinAbs(12, 1e-9));
  // No tracking anywhere: a size run keeps the layer's px, as before.
  raster::TextStyle pxBase;
  pxBase.fontSize = 40;
  pxBase.letterSpacing = 5;
  CHECK_THAT(pxBase.merged(run_style(R"({"fontSize":80})")).letterSpacing.value_or(-1), WithinAbs(5, 1e-9));
}
