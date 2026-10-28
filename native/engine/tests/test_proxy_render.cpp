// Use Proxies (setUseProxies): a viewport frame decodes a footage item from its
// enabled proxy, drawn into the ORIGINAL's box at the original's timing; an
// export never does; a proxy the engine cannot read is drawn from the
// original and said, never a blank layer.
//
// The footage is made in-process (media_fixture_ffi.hpp): the original at
// 256×144, the proxy at 128×72 whose frame i carries the code of frame
// i + kOffset — so a rendered frame says WHICH file it came from, and which
// frame of it.
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <initializer_list>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "docexpr.hpp"
#include "docio.hpp"
#include "json.hpp"
#include "media_paths.hpp"
#include "native_scene.hpp"
#include "scene_types.hpp"

#if defined(PREMATION_HAVE_MEDIA)
#include "media_fixture_ffi.hpp"
#include "media_system.hpp"
#include "media_textures.hpp"
#include "scene_renderer.hpp"
#include "scene_textures.hpp"
#endif

namespace doc = premation::doc;
namespace sc = premation::scene;
namespace fs = std::filesystem;

namespace {

constexpr int kOffset = 37;  // the proxy's frame i reads as frame i + 37

std::string fwd(const fs::path& p) {
  std::string s = sc::utf8_path(p);
  std::ranges::replace(s, '\\', '/');
  return s;
}

fs::path scratch() {
  const fs::path dir = fs::temp_directory_path() / "premation-proxy-render-test";
  fs::create_directories(dir);
  return dir;
}

/// A 256×144 comp with one video layer over a magenta background; its item is
/// `original` (256×144), with `proxy` as its proxy (status ready when `enabled`).
std::unique_ptr<doc::Document> clip_doc(const std::string& original, const std::string& proxy, bool enabled) {
  const std::string json = R"json({"version":"1.9.0","scene":{"version":"1.0.0","nodes":[
    {"id":"comp_root","name":"C","parent":null,"children":["clip"],"visible":true,"locked":false,
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[{"id":"comp_root_meta","type":"group","props":{"__kind":"group"}}]},
    {"id":"clip","name":"clip","parent":"comp_root","children":[],"visible":true,"locked":false,
     "transform":{"position":{"x":128,"y":72},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":"clip_t","type":"Transform","props":{"__kind":"video","x":128,"y":72,"rotation":0,"src":")json" + original +
                           R"json(","assetId":"plate","width":256,"height":144}},
       {"id":"clip_s","type":"Style","props":{"opacity":100}}]}]},
  "animation":{"tracks":{},"data":{},"expressions":{}},
  "comps":{"comp_root":{"id":"comp_root","name":"C","width":256,"height":144,"fps":30,"durationSeconds":1,"background":"#ff00ff"}}
})json";
  const auto parsed = premation::js::parse(json);
  REQUIRE(parsed.has_value());
  std::string asset = R"json({"id":"plate","name":"plate.mp4","type":"video","src":")json" + original + R"json(","path":")json" +
                      original +
                      R"json(","metadata":{"width":256,"height":144,"fps":23.976023976023978,"duration":1.25,"hasAlpha":false,"hasAudioTrack":false})json";
  if (!proxy.empty()) {
    asset += R"json(,"proxy":{"status":")json" + std::string(enabled ? "ready" : "none") + R"json(","src":")json" + proxy +
             R"json(","userSupplied":true})json";
  }
  asset += "}";
  const auto a = premation::js::parse(asset);
  REQUIRE(a.has_value());
  auto d = std::make_unique<doc::Document>();
  doc::EditorView view;
  (void)doc::restore_document(*d, view, *parsed, {*a});
  return d;
}

/// One frame at 0.5 s as a viewport builds it (`useProxies`) or as an export
/// does (export_job.cpp DocCopy::ctx: a plain context, `forExport`).
sc::NativeFrame build(const doc::Document& d, bool useProxies, bool forExport = false) {
  doc::EditorView view;
  doc::ExprCache cache;
  doc::DocExprEnv env(d, view, cache);
  sc::BuildContext ctx{d, view, env, cache, nullptr, {}};
  ctx.useProxies = useProxies;
  sc::CompOverrides ov;
  ov.forExport = forExport;
  return sc::build_native_frame(ctx, "comp_root", 0.5, sc::export_view(256, 144, 256, 144), false, {}, 0, ov);
}

const sc::TextureRequest* media_request(const sc::NativeFrame& nf) {
  for (const sc::TextureRequest& t : nf.textures) {
    if (t.kind == sc::TexKind::media) return &t;
  }
  return nullptr;
}

bool has_warning(const sc::NativeFrame& nf, std::string_view needle) {
  return std::ranges::any_of(nf.errors, [&](const sc::LayerError& e) {
    return e.layerId == "clip" && e.stage == "warning" && e.message.find(needle) != std::string::npos;
  });
}

/// Files that exist (contents irrelevant: the build only asks whether the proxy is there).
struct Placeholders {
  std::string original;
  std::string proxy;
  Placeholders() {
    const fs::path dir = scratch();
    original = fwd(dir / "placeholder_original.mp4");
    proxy = fwd(dir / "placeholder_proxy.mp4");
    std::ofstream(sc::file_url_fs_path(original)) << "x";
    std::ofstream(sc::file_url_fs_path(proxy)) << "x";
  }
};

}  // namespace

TEST_CASE("Use Proxies: a viewport frame names the enabled proxy, in the original's box", "[scene][proxy]") {
  const Placeholders f;
  const auto d = clip_doc(f.original, f.proxy, true);

  const sc::NativeFrame off = build(*d, false);
  const sc::TextureRequest* r = media_request(off);
  REQUIRE(r != nullptr);
  CHECK(r->src == f.original);
  CHECK(r->fallbackSrc.empty());

  const sc::NativeFrame on = build(*d, true);
  const sc::TextureRequest* p = media_request(on);
  REQUIRE(p != nullptr);
  CHECK(p->src == f.proxy);
  CHECK(p->fallbackSrc == f.original);  // what the feed decodes if the proxy does not open
  CHECK(p->key == r->key);
  CHECK(p->sourceTime == r->sourceTime);  // the original's timing
  // Nothing moves: the scene the renderer draws is the same, layer for layer —
  // only which file fills the texture differs.
  CHECK(on.file.scene == off.file.scene);
  CHECK(on.errors.empty());

  // A proxy that is off (setProxy enabled:false) is never used.
  const auto disabled = clip_doc(f.original, f.proxy, false);
  CHECK(media_request(build(*disabled, true))->src == f.original);
  // No proxy at all: the switch changes nothing.
  const auto none = clip_doc(f.original, "", false);
  CHECK(media_request(build(*none, true))->src == f.original);
  CHECK(build(*none, true).errors.empty());
}

TEST_CASE("Use Proxies: an export never uses proxies", "[scene][proxy][export]") {
  const Placeholders f;
  const auto d = clip_doc(f.original, f.proxy, true);
  // export_job.cpp builds with a plain BuildContext (useProxies false by
  // polarity) and forExport: the original, the proxy not even mentioned.
  const sc::NativeFrame ex = build(*d, false, true);
  const sc::TextureRequest* r = media_request(ex);
  REQUIRE(r != nullptr);
  CHECK(r->src == f.original);
  CHECK(r->fallbackSrc.empty());
  CHECK(ex.errors.empty());
}

TEST_CASE("Use Proxies: a missing proxy is drawn from the original, as a warning", "[scene][proxy]") {
  const Placeholders f;
  const std::string missing = fwd(scratch() / "no_such_proxy.mp4");
  const auto d = clip_doc(f.original, missing, true);
  const sc::NativeFrame on = build(*d, true);
  const sc::TextureRequest* r = media_request(on);
  REQUIRE(r != nullptr);
  CHECK(r->src == f.original);
  CHECK(r->fallbackSrc.empty());
  CHECK(has_warning(on, "proxy file is missing"));
  // A session URL (a page's blob:) cannot be read by the engine either.
  const auto blob = clip_doc(f.original, "blob:premation/1234", true);
  const sc::NativeFrame b = build(*blob, true);
  CHECK(media_request(b)->src == f.original);
  CHECK(has_warning(b, "not a file on disk"));
  // Off, nothing is said.
  CHECK(build(*d, false).errors.empty());
}

#if defined(PREMATION_HAVE_MEDIA)
namespace {

namespace media = premation::media;
namespace rg = premation::rg;

struct Gpu {
  std::unique_ptr<rg::SceneRenderer> renderer;
  std::unique_ptr<media::MediaSystem> media;
  std::unique_ptr<media::MediaTextures> mediaTex;
  std::unique_ptr<sc::SceneTextures> textures;
};

/// premation-scene's engine (tools/premation_scene.cpp make_engine): software decode, exact frames.
std::optional<Gpu> make_gpu() {
  Gpu g;
  rg::RendererOptions ro;
  ro.highPerformance = true;
  std::string err;
  g.renderer = rg::SceneRenderer::create(ro, err);
  if (!g.renderer) return std::nullopt;
  g.textures = std::make_unique<sc::SceneTextures>(sc::SceneTextures::Options{});
  g.textures->set_device(&g.renderer->device());
  media::MediaConfig mc;
  mc.hw = media::HwPolicy::softwareOnly;
  g.media = std::make_unique<media::MediaSystem>(mc);
  g.mediaTex = std::make_unique<media::MediaTextures>(*g.media, g.renderer->device().device(), media::MediaTextures::Mode::exact);
  g.textures->set_media(g.media.get(), g.mediaTex.get());
  g.renderer->set_external_textures(g.textures.get());
  return g;
}

struct Rendered {
  rg::Frame frame;
  sc::PrepareStats stats;
  [[nodiscard]] const std::uint8_t* at(std::uint32_t x, std::uint32_t y) const {
    return frame.rgba.data() + (static_cast<std::size_t>(y) * frame.width + x) * 4;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }
  /// The frame index the left half's 8 bands spell (fixture_code), read at the layer's middle row.
  [[nodiscard]] int code() const {
    int v = 0;
    for (int b = 0; b < media::fixture::kBands; ++b) {
      const std::uint32_t x = static_cast<std::uint32_t>(b * 16 + 8);  // band b of the 128 px left half
      if (at(x, 72)[1] > 128) v |= 1 << b;
    }
    return v;
  }
  [[nodiscard]] bool magenta(std::uint32_t x, std::uint32_t y) const {
    const std::uint8_t* p = at(x, y);
    return p[0] > 200 && p[1] < 60 && p[2] > 200;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }
};

Rendered render(Gpu& g, sc::NativeFrame nf) {
  Rendered out;
  g.mediaTex->begin_frame();
  g.textures->prepare(nf.textures, nf.file.textures, out.stats);
  rg::FrameStats st;
  std::string err;
  REQUIRE(g.renderer->render(nf.file, &out.frame, st, err));
  const media::MediaTextures::Misses m = g.mediaTex->take_misses();
  CHECK(m.skipped == 0);  // every footage draw had its exact frame
  REQUIRE(out.frame.width == 256);
  REQUIRE(out.frame.height == 144);
  return out;
}

bool said(const sc::PrepareStats& s, std::string_view needle) {
  return std::ranges::any_of(s.unsupported, [&](const auto& u) { return u.second.find(needle) != std::string::npos; });
}

}  // namespace

TEST_CASE("Use Proxies on the GPU: the proxy's pixels fill the original's box at the original's frame", "[scene][proxy][gpu]") {
  const fs::path dir = scratch();
  const std::string original = fwd(dir / "original_256x144.mov");
  const std::string proxy = fwd(dir / "proxy_128x72.mov");
  std::string err;
  media::fixture::Spec spec;
  spec.kind = media::fixture::Kind::prores422;  // intra, an exact index: frame N is frame N
  spec.frames = 30;
  if (!media::fixture::write(spec, original, err)) SKIP("no ProRes encoder: " << err);
  spec.width = 128;
  spec.height = 72;
  spec.codeOffset = kOffset;
  REQUIRE(media::fixture::write(spec, proxy, err));
  std::optional<Gpu> g = make_gpu();
  if (!g) SKIP("no GPU adapter");

  const auto d = clip_doc(original, proxy, true);
  const Rendered off = render(*g, build(*d, false));
  const Rendered on = render(*g, build(*d, true));
  const Rendered back = render(*g, build(*d, false));  // toggled back: the original again, not a stale proxy texture
  // 0.5 s of 23.976 fps footage is frame 11 (11.99); the proxy's frame 11
  // reads 11 + 37 — the same frame of the other file, so the timing is the original's.
  const int frame = off.code();
  CHECK((frame == 11 || frame == 12));
  CHECK(on.code() == frame + kOffset);
  CHECK(back.code() == frame);
  // The 128×72 proxy is drawn into the 256×144 box: the whole layer is covered,
  // corner to corner, as the original covers it.
  using Corner = std::pair<std::uint32_t, std::uint32_t>;
  for (const auto& [x, y] : std::initializer_list<Corner>{{1U, 1U}, {254U, 1U}, {1U, 142U}, {254U, 142U}}) {
    CHECK_FALSE(off.magenta(x, y));
    CHECK_FALSE(on.magenta(x, y));
  }
  CHECK_FALSE(said(on.stats, "proxy"));

  // A proxy file that is there but does not open is drawn from the original, and said.
  const std::string junk = fwd(dir / "junk_proxy.mp4");
  std::ofstream(sc::file_url_fs_path(junk), std::ios::binary) << "not a video";
  const auto bad = clip_doc(original, junk, true);
  const Rendered fell = render(*g, build(*bad, true));
  CHECK(fell.code() == frame);
  CHECK(said(fell.stats, "proxy did not open"));
  CHECK_FALSE(fell.magenta(128, 72));
}
#endif
