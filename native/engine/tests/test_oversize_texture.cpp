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
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
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
using Catch::Approx;

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

namespace {

/// A 4 × 1 pixel request (16 bytes) whose bytes are all `value` — its own hash per value.
sc::TextureRequest pixel_req(const std::string& key, std::uint8_t value) {
  sc::TextureRequest r;
  r.key = key;
  r.kind = sc::TexKind::pixels;
  r.pxWidth = 4;
  r.pxHeight = 1;
  r.pixels.assign(std::size_t{4} * 4, value);
  r.layerId = key;
  return r;
}

}  // namespace

TEST_CASE("one frame's rasters all survive its own prepare, however far past the budget; the next frame evicts",
          "[oversize][raster_cache]") {
  // Found 2026-10-18: a 3D comp with the camera close rasterised a dozen
  // layers at their projected size, more than the whole raster budget, and the
  // insert of the last ones evicted the first ones of the SAME frame — which
  // then drew nothing (external_texture: an evicted raster is not re-prepared).
  // Objects and strokes blinked out at the heaviest frames.
  sc::SceneTextures::Options opts;
  opts.rasterCacheBytes = 40;  // two and a half 16-byte rasters
  sc::SceneTextures textures(opts);
  std::vector<sc::TextureRequest> reqs = {pixel_req("a", 1), pixel_req("b", 2), pixel_req("c", 3), pixel_req("d", 4)};
  std::vector<premation::api::RenderTextureRef> refs;
  sc::PrepareStats stats;
  textures.prepare(reqs, refs, stats);
  REQUIRE(refs.size() == 4);
  for (const auto& ref : refs) {
    INFO(ref.key);
    CHECK(ref.ready);
    CHECK(textures.raster(ref.hash) != nullptr);  // every raster of the frame is still here
  }
  CHECK(stats.rasterOverBudget == 64 - 40);

  // The next frame reads two of them and makes one more: the budget is enforced
  // again, and only rasters of the EARLIER frame go (least recently used first).
  std::vector<sc::TextureRequest> next = {pixel_req("c", 3), pixel_req("d", 4), pixel_req("e", 5)};
  std::vector<premation::api::RenderTextureRef> refs2;
  sc::PrepareStats stats2;
  textures.prepare(next, refs2, stats2);
  REQUIRE(refs2.size() == 3);
  for (const auto& ref : refs2) CHECK(textures.raster(ref.hash) != nullptr);
  CHECK(textures.raster(refs[0].hash) == nullptr);  // "a": the oldest, gone
  CHECK(textures.raster(refs[1].hash) == nullptr);  // "b"
  CHECK(stats2.rasterOverBudget == 48 - 40);  // three of this frame's: still one over, kept
}

// ── E4 (3D perf program): SVG sources at the displayed size ──────────────────
// An SVG layer's raster is sized by DPR × layer scale × camera magnification
// (quantised to √2 steps, capped at 4096 / the device limit), cached per
// (document, time, step); the viewport draws a stand-in while the exact step
// rasterises on a worker; exact mode (exports) is synchronous and
// deterministic.

namespace {

std::string svg_data_url(double size) {
  // A square document with a thin diagonal line and a filled disc: edges to measure.
  const std::string s = std::to_string(static_cast<int>(size));
  // Single-quoted attributes: the URL sits inside a JSON string in the project.
  return "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 " + s + " " + s + "' width='" + s +
         "' height='" + s + "'><rect width='" + s + "' height='" + s + "' fill='white'/><line x1='0' y1='0' x2='" + s +
         "' y2='" + s + "' stroke='black' stroke-width='1'/><circle cx='" + std::to_string(static_cast<int>(size * 0.7)) +
         "' cy='" + std::to_string(static_cast<int>(size * 0.3)) + "' r='" + std::to_string(static_cast<int>(size * 0.1)) +
         "' fill='black'/></svg>";
}

/// A comp with one SVG image layer (scaled `scale` ×, at `z`) and, with `camera`, a camera 1000 px back (focal 1000).
/// `vector`: a text layer of the same box instead (a vector raster through the tier ladder) — the `text:` request.
std::string svg_project(double size, double scale, bool camera, double z, bool vector = false) {
  const std::string url = svg_data_url(size);
  const std::string s = std::to_string(static_cast<int>(size));
  const std::string sc = std::to_string(scale);  // the document's scale is a fraction (1 = 100 %)
  std::string nodes = R"json({"id":"comp_root","name":"C","parent":null,"children":["svg")json" + std::string(camera ? R"json(,"cam")json" : "") +
                      R"json(],"visible":true,"locked":false,"transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},"components":[{"id":"comp_root_meta","type":"group","props":{"__kind":"group"}}]},
  {"id":"svg","name":"SVG","parent":"comp_root","children":[],"visible":true,"locked":false,"transform":{"position":{"x":960,"y":540},"rotation":0,"scale":{"x":1,"y":1}},
   "components":[{"id":"svg_t","type":"Transform","props":{"__kind":")json" + std::string(vector ? "text" : "image") + R"json(","x":960,"y":540,"rotation":0,"width":)json" + s + R"json(,"height":)json" + s +
                      R"json(,"scaleX":)json" + sc + R"json(,"scaleY":)json" + sc + (camera ? R"json(,"z":)json" + std::to_string(static_cast<int>(z)) : std::string()) +
                      (vector ? std::string(R"json(,"content":"CARD","fontSize":120)json") : R"json(,"src":")json" + url + R"json(")json") + R"json(}},{"id":"svg_s","type":"Style","props":{"opacity":100,"fill":"#c9a05a"}}]})json";
  if (camera) {
    nodes += R"json(,{"id":"cam","name":"cam","parent":"comp_root","children":[],"visible":true,"locked":false,"transform":{"position":{"x":960,"y":540},"rotation":0,"scale":{"x":1,"y":1}},
   "components":[{"id":"cam_t","type":"Transform","props":{"__kind":"camera","x":960,"y":540,"rotation":0,"z":-1000,"focalLength":1000}}]})json";
  }
  return R"json({"version":"1.9.0","scene":{"version":"1.0.0","nodes":[)json" + nodes + R"json(]},
  "animation":{"tracks":{},"data":{},"expressions":{}},
  "comps":{"comp_root":{"id":"comp_root","name":"C","width":1920,"height":1080,"fps":30,"durationSeconds":10,"background":"#000000"}}})json";
}

struct SvgDoc {
  doc::Document d;
  doc::EditorView view;
  doc::ExprCache cache;
  explicit SvgDoc(const std::string& project) {
    const auto json = js::parse(project);
    REQUIRE(json.has_value());
    (void)doc::restore_document(d, view, json.value(), {});
  }
  /// The layer's texture request (`key`) for a frame at `dpr`, with the display scale on or off.
  sc::TextureRequest request(double dpr, bool displayScale, std::string_view key = "asset:svg") {
    doc::DocExprEnv env(d, view, cache);
    raster::CanvasOptions opts;
    opts.fonts = &harness_fonts();
    const auto measurer = sc::make_canvas_measurer(opts);
    const sc::BuildContext ctx{d, view, env, cache, measurer.get(), {}};
    sc::ViewSpec vs = sc::export_view(1920 * dpr, 1080 * dpr, 1920, 1080);
    vs.svgDisplayScale = displayScale;
    const sc::NativeFrame f = sc::build_native_frame(ctx, "comp_root", 0.0, vs, false);
    for (const sc::TextureRequest& r : f.textures) {
      if (r.key == key) return r;
    }
    FAIL("no texture request for the SVG layer");
    return {};
  }
};

/// Max |Δ| of the red channel between horizontal neighbours, over the raster resampled (nearest) to `display` px.
double edge_contrast(const sc::RasterEntry& e, std::uint32_t display) {
  // The raster magnified to `display` px with the GPU's linear filter: an edge
  // drawn at too few texels smears over several display px (a small step per
  // px); one drawn at the display's texel density steps in one px.
  const auto texel = [&](std::uint32_t x, std::uint32_t y) {
    return static_cast<double>(e.rgba[(std::size_t{std::min(y, e.height - 1)} * e.width + std::min(x, e.width - 1)) * 4]);
  };
  const auto at = [&](std::uint32_t x, std::uint32_t y) {
    const double fx = (static_cast<double>(x) + 0.5) * e.width / display - 0.5;
    const double fy = (static_cast<double>(y) + 0.5) * e.height / display - 0.5;
    const double x0 = std::floor(std::max(0.0, fx));
    const double y0 = std::floor(std::max(0.0, fy));
    const double tx = std::max(0.0, fx) - x0;
    const double ty = std::max(0.0, fy) - y0;
    const auto ix = static_cast<std::uint32_t>(x0);
    const auto iy = static_cast<std::uint32_t>(y0);
    const double top = texel(ix, iy) * (1 - tx) + texel(ix + 1, iy) * tx;
    const double bottom = texel(ix, iy + 1) * (1 - tx) + texel(ix + 1, iy + 1) * tx;
    return top * (1 - ty) + bottom * ty;
  };
  double best = 0;
  const std::uint32_t y = display / 2;  // through the diagonal line, clear of the disc
  for (std::uint32_t x = 1; x < display; ++x) best = std::max(best, std::abs(at(x, y) - at(x - 1, y)));
  return best;
}

}  // namespace

TEST_CASE("E4: an SVG layer asks for its displayed size — layer scale, DPR and camera magnification", "[svg][e4]") {
  {
    SvgDoc flat(svg_project(300, 1.4, false, 0));
    CHECK(flat.request(1, false).svgDisplayLong == 0);  // the parity harness: rasterizeSvg's own size
    CHECK(flat.request(1, true).svgDisplayLong == Approx(300 * 1.4));
    CHECK(flat.request(2, true).svgDisplayLong == Approx(300 * 1.4 * 2));
  }
  {
    // Camera 1000 px back (focal 1000): a layer 500 px nearer is magnified 2×.
    SvgDoc nearer(svg_project(300, 1.0, true, -500));
    CHECK(nearer.request(1, true).svgDisplayLong == Approx(600).epsilon(0.02));
  }
}

TEST_CASE("E4: a 3D text layer's raster tier already follows the camera (the port's projected scale), display scale on or off", "[svg][e4]") {
  // threed_port.cpp set_pose writes a 3D layer's scaleX / scaleY as its projected
  // footprint, so the tier ladder sees the camera's magnification for vector and
  // text rasters with or without E4 — only an SVG SOURCE's raster was intrinsic.
  {
    SvgDoc flat(svg_project(300, 1.4, false, 0, true));
    CHECK(flat.request(1, false, "text:svg").resolutionScale == Approx(2));  // 1.4 → tier 2 (the TS ladder)
    CHECK(flat.request(1, true, "text:svg").resolutionScale == Approx(2));   // a 2D layer: unchanged
  }
  {
    // Camera 1000 px back (focal 1000): a layer 500 px nearer is magnified 2×.
    SvgDoc nearer(svg_project(300, 1.0, true, -500, true));
    CHECK(nearer.request(1, false, "text:svg").resolutionScale == Approx(2));
    CHECK(nearer.request(1, true, "text:svg").resolutionScale == Approx(2));
    CHECK(nearer.request(2, true, "text:svg").resolutionScale == Approx(4));  // × DPR
    // Pulled back to 4× the distance: the ladder floors at tier 1 (the TS rule), on or off.
    SvgDoc farther(svg_project(300, 1.0, true, 3000, true));
    CHECK(farther.request(1, false, "text:svg").resolutionScale == Approx(1));
    CHECK(farther.request(1, true, "text:svg").resolutionScale == Approx(1));
  }
}

TEST_CASE("E4: the texture feed rasterises at the quantised display step, caches per step, and is deterministic in exact mode", "[svg][e4]") {
  SvgDoc flat(svg_project(300, 1.4, false, 0));
  const sc::TextureRequest legacy = flat.request(1, false);
  const sc::TextureRequest shown = flat.request(1, true);
  raster::CanvasOptions opts;
  opts.fonts = &harness_fonts();
  const auto feed = [&] {
    sc::SceneTextures::Options o;
    o.canvas = opts;
    auto t = std::make_unique<sc::SceneTextures>(o);
    t->set_exact(true);
    return t;
  };
  auto a = feed();
  std::vector<premation::api::RenderTextureRef> refs;
  sc::PrepareStats st;
  a->prepare({legacy}, refs, st);
  REQUIRE(refs.size() == 1);
  const sc::RasterEntry* before = a->raster(refs[0].hash);
  REQUIRE(before != nullptr);
  CHECK(before->width == 2048);  // rasterizeSvg's SVG_TARGET_LONG floor: 2048 for a 300 px document

  refs.clear();
  a->prepare({shown}, refs, st);
  const sc::RasterEntry* after = a->raster(refs[0].hash);
  REQUIRE(after != nullptr);
  CHECK(refs[0].hash.ends_with("#s18"));  // 300 × 1.4 = 420 → step 18 = 512 px
  CHECK(after->width == 512);
  CHECK(after->height == 512);
  CHECK(after->rgba.size() * 16 == before->rgba.size());
  CHECK(st.svgAsync == 0);

  // Determinism: a second feed draws the same bytes under the same key.
  auto b = feed();
  std::vector<premation::api::RenderTextureRef> refs2;
  sc::PrepareStats st2;
  b->prepare({shown}, refs2, st2);
  REQUIRE(refs2.size() == 1);
  CHECK(refs2[0].hash == refs[0].hash);
  const sc::RasterEntry* again = b->raster(refs2[0].hash);
  REQUIRE(again != nullptr);
  CHECK(again->rgba == after->rgba);
}

TEST_CASE("E4: a large SVG under magnification is sharper than rasterizeSvg's 2048 px cap", "[svg][e4]") {
  // A 1500 px document shown at 1.4 × on a DPR 2 display: 4200 texels needed.
  SvgDoc big(svg_project(1500, 1.4, false, 0));
  const sc::TextureRequest legacy = big.request(2, false);
  const sc::TextureRequest shown = big.request(2, true);
  raster::CanvasOptions opts;
  opts.fonts = &harness_fonts();
  sc::SceneTextures::Options o;
  o.canvas = opts;
  sc::SceneTextures t(o);
  t.set_exact(true);
  std::vector<premation::api::RenderTextureRef> refs;
  sc::PrepareStats st;
  t.prepare({legacy, shown}, refs, st);
  REQUIRE(refs.size() == 2);
  const sc::RasterEntry* before = t.raster(refs[0].hash);
  const sc::RasterEntry* after = t.raster(refs[1].hash);
  REQUIRE(before != nullptr);
  REQUIRE(after != nullptr);
  CHECK(before->width == 2048);
  CHECK(after->width == 4096);  // capped at the raster maximum
  // Resampled to the 4200 px display, the capped-at-4096 raster keeps a 1 px
  // line's edge where the 2048 one has blurred it over two texels.
  const double cBefore = edge_contrast(*before, 4200);
  const double cAfter = edge_contrast(*after, 4200);
  INFO("edge contrast before " << cBefore << " after " << cAfter);
  CHECK(cAfter > cBefore * 1.3);
}

TEST_CASE("E4: playback with an animated scale re-rasters at step boundaries only, on the worker", "[svg][e4]") {
  raster::CanvasOptions opts;
  opts.fonts = &harness_fonts();
  sc::SceneTextures::Options o;
  o.canvas = opts;
  sc::SceneTextures t(o);
  t.set_exact(false);
  t.set_playing(true);
  SvgDoc flat(svg_project(300, 1.0, false, 0));
  sc::TextureRequest r = flat.request(1, true);
  std::uint32_t rasters = 0;
  std::uint32_t standIns = 0;
  // 1.0 × → 2.0 × over 60 frames: the need runs 300 → 600 px (steps 17, 18, 19).
  for (int i = 0; i < 60; ++i) {
    r.svgDisplayLong = 300.0 * (1.0 + static_cast<double>(i) / 59.0);
    std::vector<premation::api::RenderTextureRef> refs;
    sc::PrepareStats st;
    t.prepare({r}, refs, st);
    REQUIRE(refs.size() == 1);
    CHECK(refs[0].ready);  // something always draws
    rasters += st.rasterMisses + st.svgAsync;
    if (t.svg_stand_in()) ++standIns;
    REQUIRE(t.wait_svg_idle(5000));  // the worker finishes before the next frame (deterministic count)
  }
  INFO("rasters " << rasters << " stand-ins " << standIns);
  CHECK(rasters <= 4);    // the 512 px preview + at most three steps
  CHECK(standIns <= 4);   // a stand-in frame per step change, never one per frame
  CHECK_FALSE(t.svg_pending());
}
