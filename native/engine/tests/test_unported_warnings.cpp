// Ported features and the `warning` stage (2026-10-20).
//
// The scene builder used to refuse a frame over features it did not draw
// (stage `unported`: an export fails, the golden gate counts the frame out).
// This file pins what moved:
//   * variable font axes and vertical text with optical kerning MEASURE (the
//     painter always drew them) — the layer gets its measured box and no error;
//   * text animators evaluate Font Axis offsets, Character Value / Range and
//     expression selectors (text_port.cpp; the parity fixture has the numbers);
//   * what a layer genuinely draws without — an audio waveform with no audio
//     engine, an SVG stored under an older sanitize policy, a rig with a
//     fractional mesh density, a missing plugin effect — is a `warning`: the
//     layer still draws (the rig still deforms), never an `unported` refusal.
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "docexpr.hpp"
#include "docio.hpp"
#include "json.hpp"
#include "native_scene.hpp"
#include "raster/canvas.hpp"
#include "raster/fonts.hpp"
#include "rig_mesh.hpp"
#include "scene_types.hpp"
#include "text_measure.hpp"
#include "text_port.hpp"

namespace doc = premation::doc;
namespace sc = premation::scene;
namespace raster = premation::raster;
using Json = premation::doc::Json;

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

/// A 640×360 composition with the given layer nodes (JSON node objects, parent "comp_root").
std::unique_ptr<doc::Document> comp_with(const std::string& layerNodes, const std::string& childIds) {
  const std::string json = R"json({"version":"1.9.0","scene":{"version":"1.0.0","nodes":[
    {"id":"comp_root","name":"C","parent":null,"children":[)json" + childIds + R"json(],"visible":true,"locked":false,
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[{"id":"comp_root_meta","type":"group","props":{"__kind":"group"}}]},
    )json" + layerNodes + R"json(]},
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

std::string text_node(const std::string& id, const std::string& textProps) {
  return R"json({"id":")json" + id + R"json(","name":")json" + id + R"json(","parent":"comp_root","children":[],"visible":true,"locked":false,
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":")json" + id + R"json(_t","type":"Transform","props":{"__kind":"text","x":320,"y":180,"rotation":0,"scaleX":100,"scaleY":100}},
       {"id":")json" + id + R"json(_s","type":"Style","props":{"opacity":100,"fill":"#ffffff"}},
       {"id":")json" + id + R"json(_x","type":"Text","props":{"content":"Warn","fontSize":48,"fontFamily":"Arial","fontWeight":"400","align":"center")json" + textProps + R"json(}}]})json";
}

std::string shape_node(const std::string& id, const std::string& fxProps) {
  return R"json({"id":")json" + id + R"json(","name":")json" + id + R"json(","parent":"comp_root","children":[],"visible":true,"locked":false,
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":")json" + id + R"json(_t","type":"Transform","props":{"__kind":"shape","x":320,"y":180,"rotation":0,"scaleX":100,"scaleY":100,"width":200,"height":120,"shapeType":"rect"}},
       {"id":")json" + id + R"json(_s","type":"Style","props":{"opacity":100,"fill":"#60a0ff"}},
       {"id":")json" + id + R"json(_f","type":"fx","props":{)json" + fxProps + R"json(}}]})json";
}

std::string svg_node(const std::string& id, int policy) {
  return R"json({"id":")json" + id + R"json(","name":")json" + id + R"json(","parent":"comp_root","children":[],"visible":true,"locked":false,
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":")json" + id + R"json(_t","type":"Transform","props":{"__kind":"svg","x":320,"y":180,"rotation":0,"scaleX":100,"scaleY":100,"width":100,"height":100}},
       {"id":")json" + id + R"json(_s","type":"Style","props":{"opacity":100}},
       {"id":")json" + id + R"json(_v","type":"svg","props":{"sanitizedMarkup":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><rect width=\"100\" height=\"100\" fill=\"#f00\"/></svg>","sourceMarkup":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><rect width=\"100\" height=\"100\" fill=\"#f00\"/></svg>","sanitizePolicy":)json" +
         std::to_string(policy) + R"json(,"intrinsicWidth":100,"intrinsicHeight":100}}]})json";
}

struct Built {
  sc::NativeFrame frame;
  std::vector<sc::LayerError> errorsOf(const std::string& layer, std::string_view stage) const {
    std::vector<sc::LayerError> out;
    for (const auto& e : frame.errors) {
      if (e.layerId == layer && e.stage == stage) out.push_back(e);
    }
    return out;
  }
};

Built build(const doc::Document& d, sc::TextMeasurer* measurer) {
  doc::EditorView view;
  doc::ExprCache cache;
  doc::DocExprEnv env(d, view, cache);
  const sc::BuildContext ctx{d, view, env, cache, measurer, {}};
  return Built{sc::build_native_frame(ctx, "comp_root", 0.5, sc::export_view(640, 360, 640, 360), false)};
}

std::unique_ptr<sc::TextMeasurer> measurer() {
  raster::CanvasOptions opts;
  opts.fonts = &harness_fonts();
  return sc::make_canvas_measurer(opts);
}

}  // namespace

TEST_CASE("the measurer measures variable font axes and vertical optical kerning", "[scene][text][warnings]") {
  const auto m = measurer();
  sc::MeasuredStyle s;
  s.content = "Variable";
  s.fontFamily = "Arial";
  s.fontWeight = "400";
  s.fontSize = 48;
  const auto plain = m->measure_text_size(s);
  REQUIRE(plain.has_value());

  SECTION("registered axes, width and slant are measured (a static face draws them as itself)") {
    s.fontAxes = {{"opsz", 24}, {"GRAD", 50}};
    s.hasFontAxes = true;
    s.fontWidth = 110;
    s.fontSlant = -8;
    const auto sized = m->measure_text_size(s);
    REQUIRE(sized.has_value());
    CHECK(sized->first == plain->first);
    CHECK(sized->second == plain->second);
    CHECK(m->baseline_below_middle(s).has_value());
    CHECK(m->measure_glyph_lines(s).has_value());
  }
  SECTION("vertical type with optical kerning has a measured column") {
    s.vertical = true;
    s.opticalKerning = true;
    const auto column = m->measure_text_size(s);
    REQUIRE(column.has_value());
    // A column: taller than wide, and taller than the horizontal line.
    CHECK(column->second > column->first);
    CHECK(column->second > plain->second);
  }
}

TEST_CASE("a text layer with font axes, vertical optical kerning and every animator feature builds without an unported error",
          "[scene][text][warnings]") {
  const auto m = measurer();
  const auto d = comp_with(
      text_node("t", R"json(,"fontAxes":{"opsz":20},"orientation":"vertical","kerningMode":"optical",
        "__animators":[{"id":"a1","basedOn":"characters","shape":"square","start":0,"end":100,"offset":0,"x":0,"y":-10,"scale":100,
          "rotation":0,"opacity":100,"tracking":0,"skew":0,"mode":"range","wiggleFreq":2,"characterValue":66,"characterOffset":1,
          "characterRange":"full","axes":{"wght":200},
          "selectors":[{"kind":"expression","basedOn":"characters","mode":"intersect","amount":100,"expression":"textIndex * 25"}]}])json"),
      "\"t\"");
  const Built b = build(*d, m.get());
  for (const auto& e : b.frame.errors) INFO(e.layerId << " [" << e.stage << "]: " << e.message);
  CHECK(b.errorsOf("t", "unported").empty());
  CHECK(b.errorsOf("t", "warning").empty());
  bool sawText = false;
  for (const sc::TextureRequest& r : b.frame.textures) {
    if (r.layerId == "t" && r.kind == sc::TexKind::text) sawText = true;
  }
  CHECK(sawText);
}

TEST_CASE("text animators: Character Value, Character Range and expression selectors evaluate", "[scene][text][warnings]") {
  const auto animators = [](const std::string& extra) {
    const auto parsed = premation::js::parse(
        R"json([{"id":"a1","basedOn":"characters","shape":"square","start":0,"end":100,"offset":0,"x":0,"y":0,"scale":100,"rotation":0,
         "opacity":100,"tracking":0,"skew":0,"mode":"range","wiggleFreq":2)json" + extra + "}]");
    REQUIRE(parsed.has_value());
    return sc::resolve_text_animators_json(*parsed, sc::Values{});
  };
  const auto display = [](const Json& glyphs, std::size_t i) {
    const Json& g = glyphs.arr()[i];
    return g.at("displayChar").is_string() ? g.at("displayChar").str() : g.at("char").str();
  };
  std::string why;

  SECTION("Character Value replaces, and an offset then counts up from it") {
    const Json g = sc::evaluate_text_animators("AAA", animators(R"json(,"characterValue":66,"characterOffset":1)json"), 0, &why);
    REQUIRE(why.empty());
    CHECK(display(g, 0) == "C");
    CHECK(display(g, 2) == "C");
  }
  SECTION("Character Range: Preserve Case & Digits wraps, Full Unicode walks the code point") {
    const Json preserve = sc::evaluate_text_animators("Z9", animators(R"json(,"characterOffset":1,"characterRange":"preserve")json"), 0, &why);
    REQUIRE(why.empty());
    CHECK(display(preserve, 0) == "A");
    CHECK(display(preserve, 1) == "0");
    const Json full = sc::evaluate_text_animators("Z9", animators(R"json(,"characterOffset":1,"characterRange":"full")json"), 0, &why);
    REQUIRE(why.empty());
    CHECK(display(full, 0) == "[");
    CHECK(display(full, 1) == ":");
  }
  SECTION("Font Axis offsets ride the selector") {
    const Json g = sc::evaluate_text_animators("AB", animators(R"json(,"end":50,"axes":{"wght":300})json"), 0, &why);
    REQUIRE(why.empty());
    REQUIRE(g.arr()[0].at("axes").is_object());
    CHECK(g.arr()[0].at("axes").at("wght").num() == 300);
    CHECK_FALSE(g.arr()[1].at("axes").is_object());
  }
  SECTION("an expression selector sees textIndex / textTotal / selectorValue; a bad source selects nothing") {
    const Json g = sc::evaluate_text_animators(
        "abcd", animators(R"json(,"y":-100,"selectors":[{"kind":"expression","basedOn":"characters","mode":"intersect","amount":100,"expression":"textIndex * 100 / (textTotal - 1)"}])json"), 0, &why);
    REQUIRE(why.empty());
    CHECK(g.arr()[0].at("dy").num() == 0);
    CHECK(g.arr()[3].at("dy").num() == -100);
    const Json bad = sc::evaluate_text_animators(
        "ab", animators(R"json(,"y":-100,"selectors":[{"kind":"expression","basedOn":"characters","mode":"intersect","amount":100,"expression":"textIndex +* 1"}])json"), 0, &why);
    REQUIRE(why.empty());
    CHECK(bad.arr()[1].at("dy").num() == 0);
  }
}

TEST_CASE("what a layer draws without is a warning, never an unported refusal", "[scene][warnings]") {
  const auto m = measurer();

  SECTION("an audio waveform generator with no audio engine draws flat") {
    const auto d = comp_with(shape_node("w", R"json("audioWaveform":{"sourceLayerId":"","samples":64,"heightScale":1,"thickness":2})json"), "\"w\"");
    const Built b = build(*d, m.get());  // BuildContext::waveform left empty
    CHECK(b.errorsOf("w", "unported").empty());
    const auto warned = b.errorsOf("w", "warning");
    REQUIRE(warned.size() == 1);
    CHECK(warned[0].message.find("audio waveform") != std::string::npos);
  }
  SECTION("an SVG stored under an older sanitize policy draws from its stored markup") {
    const auto d = comp_with(svg_node("v", 1), "\"v\"");
    const Built b = build(*d, m.get());
    CHECK(b.errorsOf("v", "unported").empty());
    const auto warned = b.errorsOf("v", "warning");
    REQUIRE(warned.size() == 1);
    CHECK(warned[0].message.find("sanitize policy") != std::string::npos);
    bool drawn = false;
    for (const auto& r : b.frame.file.scene.renderables) {
      if (r.id == "v") drawn = true;
    }
    CHECK(drawn);
  }
  SECTION("a missing plugin effect passes through") {
    const auto d = comp_with(shape_node("p", R"json("effects":[{"id":"e1","type":"com.example.not-installed","enabled":true,"params":{}}])json"), "\"p\"");
    const Built b = build(*d, m.get());
    CHECK(b.errorsOf("p", "unported").empty());
    const auto warned = b.errorsOf("p", "warning");
    REQUIRE(warned.size() == 1);
    CHECK(warned[0].message.starts_with("missing plugin"));
  }
}

TEST_CASE("a rig with a fractional mesh density still deforms, with a warning", "[scene][rig][warnings]") {
  const auto parsed = premation::js::parse(
      R"json({"puppet":{"meshDensity":12.5,"meshExpansion":0,"pins":[{"id":"a","name":"A","x":-40,"y":0},{"id":"b","name":"B","x":40,"y":0}]}})json");
  REQUIRE(parsed.has_value());
  sc::RigInputs in;
  in.fx = &*parsed;
  in.width = 200;
  in.height = 120;
  sc::RigSampler anim;
  anim.sample = [](std::string_view, double) { return std::nullopt; };
  anim.sampleData = [](std::string_view, double) { return std::nullopt; };
  const sc::RigResult r = sc::build_rig_mesh(in, anim);
  REQUIRE(r.mesh.has_value());
  REQUIRE(r.warnings.size() == 1);
  CHECK(r.warnings[0].find("fractional") != std::string::npos);
  CHECK(r.warnings[0].find("12") != std::string::npos);
}

// 2026-10-21 (docs/EXPRESSION_LANGUAGE.md): an expression that fails while the
// frame evaluates keeps its pre-expression value and is reported once per
// property, stage `expression`, "Line N: <message>", path = the API path.
TEST_CASE("a failing expression is a layer error with its line and property path", "[scene][expr][warnings]") {
  auto d = comp_with(shape_node("s", ""), "\"s\"");
  doc::anim_set_expr_state(*d, "s", "rotation", doc::ExprState{"var a = 1;\nfoo(a)", true, std::nullopt});
  // A vector property failing in both members is one entry.
  doc::anim_set_expr_state(*d, "s", "x", doc::ExprState{"thisComp.nope.q", true, std::nullopt});
  doc::anim_set_expr_state(*d, "s", "y", doc::ExprState{"thisComp.nope.q", true, std::nullopt});
  // A disabled one is not evaluated, so not reported.
  doc::anim_set_expr_state(*d, "s", "opacity", doc::ExprState{"nope()", false, std::nullopt});
  const Built b = build(*d, nullptr);
  const auto errs = b.errorsOf("s", "expression");
  for (const auto& e : errs) INFO(e.path << ": " << e.message);
  REQUIRE(errs.size() == 2);
  const auto at = [&](const std::string& path) {
    const auto it = std::find_if(errs.begin(), errs.end(), [&](const sc::LayerError& e) { return e.path == path; });
    REQUIRE(it != errs.end());
    return *it;
  };
  CHECK(at("transform/rotation").message.starts_with("Line 2: Unknown name “foo”."));
  CHECK(at("transform/position").message == "Line 1: Cannot read “q” of undefined.");
  CHECK(at("transform/rotation").layerName == "s");
  // Fixed: nothing to report.
  doc::anim_set_expr_state(*d, "s", "rotation", doc::ExprState{"var a = 1;\na * 2", true, std::nullopt});
  doc::anim_set_expr_state(*d, "s", "x", std::nullopt);
  doc::anim_set_expr_state(*d, "s", "y", std::nullopt);
  CHECK(build(*d, nullptr).errorsOf("s", "expression").empty());
}
