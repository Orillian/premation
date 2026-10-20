// D2w effects: whole CPU-baked effect chains (scene/bake_chain.cpp) against
// effectBake.ts. The C++ bake on a recording Canvas2D must issue the TS's
// Canvas2D program op for op — every putImageData carrying the same FNV-1a 64
// of its bytes (tests/data/bake_chain_parity.json, frozen from the TypeScript
// engine's nativeBakeChainCrossEngine.test.ts; PARITY_REBLESS=1 writes the C++
// answers instead (parity_rebless.hpp)).
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cstdio>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "bake_chain.hpp"
#include "canvas.hpp"
#include "effects/canvas_effects.hpp"
#include "raster/json.hpp"
#include "json.hpp"
#include "parity_rebless.hpp"
#include "raster/fonts.hpp"
#include "recording_canvas.hpp"

namespace sc = premation::scene;
namespace js = premation::js;
namespace raster = premation::raster;

namespace {

/// nativeBakeChainCrossEngine.test.ts `pattern(w, h)`.
std::vector<std::uint8_t> pattern(std::uint32_t w, std::uint32_t h) {
  std::vector<std::uint8_t> d(static_cast<std::size_t>(w) * h * 4);
  for (std::uint32_t y = 0; y < h; ++y) {
    for (std::uint32_t x = 0; x < w; ++x) {
      const std::size_t i = (static_cast<std::size_t>(y) * w + x) * 4;
      d[i] = static_cast<std::uint8_t>((x * 7 + y * 3) & 255U);
      d[i + 1] = static_cast<std::uint8_t>((x * 5 + y * 11 + ((x * y) % 17)) & 255U);
      d[i + 2] = static_cast<std::uint8_t>((255U - x * 3 - y * 2) & 255U);
      d[i + 3] = (x + y) % 9 == 0 ? 0 : static_cast<std::uint8_t>((x * 13 + y * 29 + 64) & 255U);
    }
  }
  return d;
}

}  // namespace

TEST_CASE("bake chain: the C++ issues effectBake.ts's Canvas2D program", "[scene][bake][parity]") {
  premation::test::JsonFixture fx("bake_chain_parity.json");
  REQUIRE(fx.ok());

  int exact = 0;
  std::size_t opsTotal = 0;
  std::size_t opsSame = 0;
  js::Json::Array& cases = fx.root().find_mut("cases")->arr_mut();
  for (js::Json& c : cases) {
    const std::string name = c.at("name").str();
    INFO(name);
    const auto w = static_cast<std::uint32_t>(c.at("w").num());
    const auto h = static_cast<std::uint32_t>(c.at("h").num());
    auto rec = std::make_shared<raster::test::Recording>();
    raster::test::RecordingCanvas oc(rec, w, h);
    oc.putImageData(pattern(w, h), w, h, 0, 0);  // the layer content (the recorders hold real pixels)
    std::vector<std::string> unsupported;
    sc::bake::bake_layer_raster(oc, c.at("spec"), c.at("bw").num(), c.at("bh").num(), c.at("ss").num(), unsupported);
    for (const std::string& u : unsupported) std::printf("  %s: unsupported: %s\n", name.c_str(), u.c_str());
    CHECK(unsupported.empty());

    const auto& got = rec->ops;
    js::Json::Array gotOps;
    for (const std::string& op : got) gotOps.push_back(js::Json::string(op));
    if (!fx.reblessing()) {
      const js::Json::Array& want = c.at("ops").arr();
      std::size_t same = 0;
      std::size_t first = want.size();
      for (std::size_t i = 0; i < std::min(want.size(), got.size()); ++i) {
        if (want[i].str() == got[i]) ++same;
        else if (first == want.size()) first = i;
      }
      opsTotal += want.size();
      opsSame += same;
      if (same == want.size() && got.size() == want.size()) {
        ++exact;
      } else {
        const std::size_t i = std::min(first, std::min(want.size(), got.size()));
        std::printf("  %s: first difference at op %zu of %zu (C++ issued %zu)\n    TS : %s\n    C++: %s\n", name.c_str(), i,
                    want.size(), got.size(), i < want.size() ? want[i].str().c_str() : "(end)", i < got.size() ? got[i].c_str() : "(end)");
      }
    }
    CHECK(fx.answer(c, "ops", js::Json::array(std::move(gotOps))));
  }
  std::printf("bake chains vs effectBake.ts: %d/%zu cases op-for-op, %zu/%zu ops identical\n", exact, cases.size(), opsSame,
              opsTotal);
  REQUIRE(fx.finish());
}

namespace {

/// A closed rectangular mask path (corner points), layer px.
js::Json rect_mask(double x0, double y0, double x1, double y1) {
  js::Json pts = js::Json::array();
  for (const auto& [x, y] : std::vector<std::pair<double, double>>{{x0, y0}, {x1, y0}, {x1, y1}, {x0, y1}}) {
    js::Json p = js::Json::object();
    for (const char* k : {"x", "inX", "outX"}) p.set(k, js::Json::number(x));
    for (const char* k : {"y", "inY", "outY"}) p.set(k, js::Json::number(y));
    pts.arr_mut().push_back(std::move(p));
  }
  js::Json path = js::Json::object();
  path.set("id", js::Json::string("m"));
  path.set("mode", js::Json::string("add"));
  path.set("closed", js::Json::boolean(true));
  path.set("points", std::move(pts));
  path.set("feather", js::Json::number(0));
  path.set("opacity", js::Json::number(1));
  path.set("expansion", js::Json::number(0));
  js::Json paths = js::Json::array();
  paths.arr_mut().push_back(std::move(path));
  js::Json mask = js::Json::object();
  mask.set("paths", std::move(paths));
  return mask;
}

}  // namespace

TEST_CASE("footage bake: the mask matte lands on the bitmap (bake_footage)", "[scene][bake][footage]") {
  // A 40 × 20 layer baked at 2× (80 × 40), opaque red.
  const raster::CanvasOptions opts;
  const auto frame = [&opts] {
    auto c = raster::Canvas2D::make(80, 40, opts);
    std::vector<std::uint8_t> red(80U * 40U * 4U);
    for (std::size_t i = 0; i < red.size(); i += 4) {
      red[i] = 255;
      red[i + 3] = 255;
    }
    c->putImageData(red, 80, 40, 0, 0);
    return c;
  };
  const auto alpha_at = [](const raster::Canvas2D& c, std::uint32_t x, std::uint32_t y) {
    return c.pixels().at((static_cast<std::size_t>(y) * c.width() + x) * 4 + 3);
  };
  js::Json spec = js::Json::object();
  spec.set("effects", js::Json::array());
  spec.set("width", js::Json::number(40));
  spec.set("height", js::Json::number(20));
  std::vector<std::string> unsupported;
  {
    // A mask covering the layer box however its space is anchored: nothing is cut.
    auto c = frame();
    js::Json s = spec;
    s.set("mask", rect_mask(-40, -20, 40, 20));
    sc::bake::bake_footage(*c, s, unsupported);
    CHECK(alpha_at(*c, 5, 5) == 255);
    CHECK(alpha_at(*c, 75, 35) == 255);
  }
  {
    // A mask far outside the box: the whole bitmap is cut away.
    auto c = frame();
    js::Json s = spec;
    s.set("mask", rect_mask(1000, 1000, 1100, 1100));
    sc::bake::bake_footage(*c, s, unsupported);
    CHECK(alpha_at(*c, 5, 5) == 0);
    CHECK(alpha_at(*c, 40, 20) == 0);
  }
  {
    // No mask, no effects: the frame as drawn.
    auto c = frame();
    sc::bake::bake_footage(*c, spec, unsupported);
    CHECK(alpha_at(*c, 40, 20) == 255);
  }
  CHECK(unsupported.empty());
}

// ── B5 (docs/PROGRAM_3D_PERF_UX.md): Light Sweep lights the layer, never its box ──
// The CPU twin of the GPU chain's light-sweep (the headless engine, a baked
// stack): in every Light Reception mode the band is cut to the layer's alpha —
// AE's CC Light Sweep. Mode 1 (add) used to paint the whole box.

TEST_CASE("B5: the CPU light sweep leaves the layer's transparent box transparent in every composite mode", "[scene][bake][b5]") {
  const raster::CanvasOptions opts;
  const auto frame = [&opts] {
    // An 80 × 40 layer with a dark grey 40 × 20 block in the middle.
    auto c = raster::Canvas2D::make(80, 40, opts);
    std::vector<std::uint8_t> px(80U * 40U * 4U, 0);
    for (std::uint32_t y = 10; y < 30; ++y) {
      for (std::uint32_t x = 20; x < 60; ++x) {
        const std::size_t i = (static_cast<std::size_t>(y) * 80 + x) * 4;
        px[i] = px[i + 1] = px[i + 2] = 64;
        px[i + 3] = 255;
      }
    }
    c->putImageData(px, 80, 40, 0, 0);
    return c;
  };
  const auto at = [](const raster::Canvas2D& c, std::uint32_t x, std::uint32_t y, std::size_t ch) {
    return c.pixels().at((static_cast<std::size_t>(y) * c.width() + x) * 4 + ch);
  };
  for (const int mode : {0, 1, 2, 3, 4}) {
    INFO("composite " << mode);
    auto c = frame();
    raster::json::Value params;
    std::string err;
    REQUIRE(raster::json::parse(R"({"position":50,"sweepWidth":400,"angle":0,"color":"#ffffff","intensity":100,"softness":50,"composite":)" +
                                    std::to_string(mode) + "}",
                                params, err));
    REQUIRE(premation::effects::run_canvas_effect("light-sweep", params, *c, 80, 40));
    // Outside the block: still nothing.
    CHECK(at(*c, 5, 5, 3) == 0);
    CHECK(at(*c, 75, 35, 3) == 0);
    CHECK(at(*c, 40, 3, 3) == 0);
    // Inside the block: still opaque, and (bar multiply, which darkens) lit.
    CHECK(at(*c, 40, 20, 3) == 255);
    if (mode != 3) CHECK(at(*c, 40, 20, 1) > 64);
  }
}

TEST_CASE("Numbers and Timecode draw their readout on the raster canvas", "[scene][bake][numbers]") {
  // The engine's canvases carry its fonts (engine_frames.cpp Fonts registers
  // the generic monospace the readout falls back to); a canvas without fonts
  // draws no text at all.
  static const raster::FontSet* fonts = [] {
    static raster::FontSet f{raster::FontOptions{}};
    std::string err;
    REQUIRE(f.load_manifest(PREMATION_RASTER_FONTS, err));
    (void)f.add_system_family("monospace");
    return &f;
  }();
  raster::CanvasOptions opts;
  opts.fonts = fonts;
  const auto inked = [](const raster::Canvas2D& c) {
    std::size_t n = 0;
    const auto& px = c.pixels();
    for (std::size_t i = 3; i < px.size(); i += 4) n += px[i] > 0 ? 1 : 0;
    return n;
  };
  SECTION("Numbers: the digits") {
    auto c = raster::Canvas2D::make(200, 100, opts);
    raster::json::Value params;
    std::string err;
    REQUIRE(raster::json::parse(R"({"value":8888,"size":48,"color":"#ffffff"})", params, err));
    REQUIRE(premation::effects::run_canvas_effect("numbers", params, *c, 200, 100));
    CHECK(inked(*c) > 200);
  }
  SECTION("Timecode: its box and digits") {
    auto c = raster::Canvas2D::make(300, 100, opts);
    raster::json::Value params;
    std::string err;
    REQUIRE(raster::json::parse(R"({"time":1.5,"fps":30,"size":32,"color":"#ffffff","showBox":true,"boxColor":"#000000"})", params, err));
    REQUIRE(premation::effects::run_canvas_effect("timecode", params, *c, 300, 100));
    // The box alone is ~1350 px; the digits add theirs in white.
    std::size_t white = 0;
    const auto& px = c->pixels();
    for (std::size_t i = 0; i < px.size(); i += 4) white += px[i] > 128 ? 1 : 0;
    CHECK(inked(*c) > 1000);
    CHECK(white > 100);
  }
}
