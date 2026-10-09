// An enormous layer never blanks the frame (CLAUDE.md reliability). Found
// 2026-10-08 through the AI tools: "PREMATION" at 180 px, scaled 8000 % →
// 10000 %, made a text raster 16384 px wide; the device had the WebGPU
// default 8192 limit, Dawn made an error texture and the whole frame — the
// backdrop and the comp background with it — came back transparent.
//
// The scene builder's half: every raster is planned within the device's 2D
// limit (texture_dimension_limit — a smaller device clamps, it never
// overflows), and the texture feed refuses a texture over the limit instead
// of handing it to the GPU. The GPU half (rg::Device refusing the upload, the
// rest of the frame drawn) is in test_render_graph_gpu.cpp.
#include <catch2/catch_test_macros.hpp>

#include <memory>
#include <string>
#include <vector>

#include "docexpr.hpp"
#include "docio.hpp"
#include "json.hpp"
#include "native_scene.hpp"
#include "raster/canvas.hpp"
#include "raster/fonts.hpp"
#include "raster_source.hpp"
#include "scene_textures.hpp"
#include "text_measure.hpp"

namespace sc = premation::scene;
namespace doc = premation::doc;
namespace js = premation::js;
namespace raster = premation::raster;

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

// The repro: a 1920×1080 backdrop and a 180 px text layer scaled 10000 %.
constexpr std::string_view kProject = R"json({"version":"1.9.0","scene":{"version":"1.0.0","nodes":[
  {"id":"comp_root","name":"C","parent":null,"children":["bg","t"],"visible":true,"locked":false,
   "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
   "components":[{"id":"comp_root_meta","type":"group","props":{"__kind":"group"}}]},
  {"id":"bg","name":"Backdrop","parent":"comp_root","children":[],"visible":true,"locked":false,
   "transform":{"position":{"x":960,"y":540},"rotation":0,"scale":{"x":1,"y":1}},
   "components":[
     {"id":"bg_t","type":"Transform","props":{"__kind":"shape","x":960,"y":540,"rotation":0,"width":1920,"height":1080,"shapeType":"rect"}},
     {"id":"bg_s","type":"Style","props":{"opacity":100,"fill":"#101828"}}]},
  {"id":"t","name":"PREMATION","parent":"comp_root","children":[],"visible":true,"locked":false,
   "transform":{"position":{"x":960,"y":540},"rotation":0,"scale":{"x":1,"y":1}},
   "components":[
     {"id":"t_t","type":"Transform","props":{"__kind":"text","x":960,"y":540,"rotation":0,"scaleX":10000,"scaleY":10000}},
     {"id":"t_s","type":"Style","props":{"opacity":100,"fill":"#ffffff"}},
     {"id":"t_x","type":"Text","props":{"content":"PREMATION","fontSize":180,"fontFamily":"Arial","fontWeight":"400"}}]}]},
  "animation":{"tracks":{},"data":{},"expressions":{}},
  "comps":{"comp_root":{"id":"comp_root","name":"C","width":1920,"height":1080,"fps":30,"durationSeconds":10,"background":"#000000"}}
})json";

/// The texel size raster_source will draw `r` at.
raster::RasterCanvasSize planned(const sc::TextureRequest& r) {
  return raster::raster_canvas_size(r.spec.at("width").num(), r.spec.at("height").num(), r.resolutionScale, r.padding,
                                    r.spec.at("__baked").b(), r.spec.at("__deviceMax").num());
}

/// Restores the process-wide limit when a test case ends.
struct LimitGuard {
  LimitGuard() = default;
  LimitGuard(const LimitGuard&) = delete;
  LimitGuard& operator=(const LimitGuard&) = delete;
  LimitGuard(LimitGuard&&) = delete;
  LimitGuard& operator=(LimitGuard&&) = delete;
  ~LimitGuard() { sc::set_texture_dimension_limit(16384); }
};

}  // namespace

TEST_CASE("a 10000 % text layer plans its raster within the device's texture limit, at 16384 and at 8192", "[oversize]") {
  const LimitGuard restore;
  const auto json = js::parse(kProject);
  REQUIRE(json.has_value());
  doc::Document d;
  doc::EditorView view;
  doc::ExprCache cache;
  (void)doc::restore_document(d, view, json.value(), {});
  doc::DocExprEnv env(d, view, cache);
  raster::CanvasOptions opts;
  opts.fonts = &harness_fonts();
  const auto measurer = sc::make_canvas_measurer(opts);

  for (const std::uint32_t limit : {16384U, 8192U}) {
    INFO("device limit " << limit);
    sc::set_texture_dimension_limit(limit);
    REQUIRE(sc::texture_dimension_limit() == static_cast<double>(limit));
    const sc::BuildContext ctx{d, view, env, cache, measurer.get(), {}};
    const sc::NativeFrame f = sc::build_native_frame(ctx, "comp_root", 1.0, sc::export_view(1920, 1080, 1920, 1080), false);
    for (const auto& e : f.errors) {
      INFO(e.layerId << " [" << e.stage << "]: " << e.message);
      CHECK(e.layerId != "bg");
      CHECK(e.layerId != "t");
    }
    bool sawText = false;
    for (const sc::TextureRequest& r : f.textures) {
      if (r.kind != sc::TexKind::text && r.kind != sc::TexKind::path) continue;
      INFO(r.key);
      const raster::RasterCanvasSize z = planned(r);
      CHECK(z.width <= limit);
      CHECK(z.height <= limit);
      if (r.layerId == "t") {
        sawText = true;
        // The raster is as large as the device allows — clamped, not dropped.
        CHECK(z.width > limit / 2);
      }
    }
    CHECK(sawText);
  }
}

TEST_CASE("the texture feed refuses a texture over the device's limit; the frame's other refs stay ready", "[oversize]") {
  const LimitGuard restore;
  sc::set_texture_dimension_limit(8192);
  sc::SceneTextures textures(sc::SceneTextures::Options{});
  std::vector<sc::TextureRequest> reqs(2);
  reqs[0].key = "lut:huge";
  reqs[0].kind = sc::TexKind::pixels;
  reqs[0].pxWidth = 8193;
  reqs[0].pxHeight = 1;
  reqs[0].pixels.assign(std::size_t{8193} * 4, 255);
  reqs[0].layerId = "huge";
  reqs[1].key = "lut:small";
  reqs[1].kind = sc::TexKind::pixels;
  reqs[1].pxWidth = 4;
  reqs[1].pxHeight = 1;
  reqs[1].pixels.assign(std::size_t{4} * 4, 128);
  std::vector<premation::api::RenderTextureRef> refs;
  sc::PrepareStats stats;
  textures.prepare(reqs, refs, stats);
  REQUIRE(refs.size() == 2);
  CHECK_FALSE(refs[0].ready);
  CHECK(refs[1].ready);
  CHECK(stats.oversizeRefused == 1);
  REQUIRE(stats.unsupported.size() == 1);
  CHECK(stats.unsupported[0].first == "lut:huge");
  CHECK(stats.unsupported[0].second.find("over the GPU limit of 8192") != std::string::npos);
}
