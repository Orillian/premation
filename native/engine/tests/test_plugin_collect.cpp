// Collect Files carries a native plugin's FILE asset and the files beside it (SDK 1.2
// PR_CMD_LIST_ASSET_FILES, collect_files.hpp), and plugin-imported footage keeps its
// extension. Each persistence path is driven over a real document and rendered: collect +
// reopen, Save As bundle from the collected project, a portable .motion, an export's
// snapshot (rewrite_blob_refs + its open), a recovery restore — every time with the
// ORIGINAL files deleted, the model3d render equals the uncollected one.
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <memory>
#include <random>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

#include "bundle_io.hpp"
#include "collect_files.hpp"
#include "cpu_render.hpp"
#include "docexpr.hpp"
#include "docio.hpp"
#include "engine_ctx.hpp"
#include "fx_wire.hpp"
#include "handlers_native.hpp"
#include "host.hpp"
#include "jobs/job_inputs.hpp"
#include "json.hpp"
#include "model.hpp"
#include "native_contrib.hpp"
#include "native_scene.hpp"
#include "project_open.hpp"
#include "scene.hpp"
#include "scene_finish.hpp"
#include "snapshot_build.hpp"

namespace pl = premation::plugins;
namespace doc = premation::doc;
namespace sc = premation::scene;
namespace api = premation::api;
namespace fs = std::filesystem;
using premation::js::Json;

namespace {

constexpr const char* kModel3d = "com.premation.samples.model3d";

fs::path bundles() { return fs::path(PREMATION_PLUGIN_BUNDLES); }
fs::path models() { return bundles() / "model3d" / "models"; }

std::string utf8(const fs::path& p) {
  const std::u8string u = p.generic_u8string();
  return {u.begin(), u.end()};
}

std::string slurp(const fs::path& p) {
  std::ifstream in(p, std::ios::binary);
  std::ostringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

void spit(const fs::path& p, const std::string& s) {
  fs::create_directories(p.parent_path());
  std::ofstream out(p, std::ios::binary | std::ios::trunc);
  out << s;
}

struct TempDir {
  fs::path path;
  TempDir() {
    std::random_device rd;
    path = fs::temp_directory_path() /
           ("premation-plugin-collect-" + std::to_string(rd()) + "-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    fs::create_directories(path);
  }
  TempDir(const TempDir&) = delete;
  TempDir& operator=(const TempDir&) = delete;
  TempDir(TempDir&&) = delete;
  TempDir& operator=(TempDir&&) = delete;
  ~TempDir() {
    std::error_code ec;
    fs::remove_all(path, ec);
  }
};

Json golden(const char* name) {
  auto j = premation::js::parse(slurp(fs::path(PREMATION_GOLDEN_SCENES) / name));
  REQUIRE(j.has_value());
  return *j;
}

/// The original files: a .gltf whose buffer is a .bin beside it and which names a texture in a
/// sub-folder (model3d lists both), and a two-pixel .ppm (ppmio reads it).
struct Sources {
  fs::path dir;
  explicit Sources(const fs::path& root) : dir(root / "originals") {
    std::string gltf = slurp(models() / "box.gltf");
    REQUIRE(gltf.find("\"buffers\"") != std::string::npos);
    gltf.insert(gltf.find('{') + 1, "\n  \"images\": [{ \"uri\": \"tex/checker%20map.png\" }],");
    spit(dir / "box.gltf", gltf);
    spit(dir / "box.bin", slurp(models() / "box.bin"));
    spit(dir / "tex" / "checker map.png", slurp(models() / "checker.png"));
    std::string ppm = "P6\n2 1\n255\n";
    ppm += std::string("\xff\x20\x10\x10\x80\xf0", 6);
    spit(dir / "clip.ppm", ppm);
  }
};

/// The model3d orbit golden with its model as a data item at the .gltf's path, no base-colour map,
/// and a .ppm footage layer (an image layer of item "clip").
Json project(const Sources& s, int fault = 1, const pl::EffectSpec* spec = nullptr) {
  Json d = golden("plugin-model3d-orbit.json");
  Json& footage = *d.find_mut("projectItems")->find_mut("footage");
  footage = Json::object();
  Json model = Json::object();
  model.set("name", Json::string("box.gltf"));
  model.set("type", Json::string("data"));
  model.set("path", Json::string(utf8(s.dir / "box.gltf")));
  footage.set("m3d-box", std::move(model));
  Json clip = Json::object();
  clip.set("name", Json::string("clip.ppm"));
  clip.set("type", Json::string("image"));
  clip.set("path", Json::string(utf8(s.dir / "clip.ppm")));
  footage.set("clip", std::move(clip));
  auto& nodes = d.find_mut("scene")->find_mut("nodes")->arr_mut();
  for (Json& n : nodes) {
    if (n.at("id").str() != "solid") continue;
    for (Json& c : n.find_mut("components")->arr_mut()) {
      Json* fx = c.find_mut("props")->find_mut("effects");
      if (fx == nullptr) continue;
      Json& params = *fx->arr_mut().at(0).find_mut("params");
      params.erase("p11");
      if (fault != 1 && spec != nullptr) {
        for (const pl::ParamSpec& p : spec->params) {
          if (p.id == 901) params.set(p.key, Json::number(fault));  // Debug ▸ Fault (sample_util.hpp)
        }
      }
    }
  }
  // The .ppm as an image layer the comp does not draw over the model (0 opacity keeps the frame).
  Json t = Json::object();
  t.set("__kind", Json::string("image"));
  t.set("x", Json::number(10));
  t.set("y", Json::number(10));
  t.set("width", Json::number(2));
  t.set("height", Json::number(1));
  t.set("assetId", Json::string("clip"));
  t.set("src", Json::string(utf8(s.dir / "clip.ppm")));
  Json comp = Json::object();
  comp.set("id", Json::string("ppm_t"));
  comp.set("type", Json::string("Transform"));
  comp.set("props", std::move(t));
  Json node = Json::object();
  node.set("id", Json::string("ppm"));
  node.set("name", Json::string("ppm"));
  node.set("parent", Json::string("comp_root"));
  node.set("children", Json::array());
  node.set("visible", Json::boolean(false));
  node.set("locked", Json::boolean(false));
  Json::Array comps;
  comps.push_back(std::move(comp));
  node.set("components", Json::array(std::move(comps)));
  nodes.push_back(std::move(node));
  for (Json& n : nodes) {
    if (n.at("id").str() == "comp_root") n.find_mut("children")->arr_mut().push_back(Json::string("ppm"));
  }
  return d;
}

/// One open project: the document, its plugin host attached (the hooks Collect Files and relink use).
struct Open {
  explicit Open(pl::PluginHost& h, const Json& document, const std::string& bundleRoot = {}) : host(h) {
    const doc::RestoreResult r = doc::restore_document(d, view, document, {});
    doc::FilePorts ports;
    (void)doc::relink_missing_footage(d, ports, bundleRoot, r.missing);
    env = std::make_unique<doc::DocExprEnv>(d, view, cache);
  }

  /// The model3d layer at 0.5 s rendered on the plugin's CPU path, and the frame's plugin errors.
  std::vector<float> render(std::vector<std::string>* errors = nullptr) {
    const sc::BuildContext ctx{d, view, *env, cache, nullptr, {}};
    const sc::ViewSpec vs = sc::export_view(480, 360, 480, 360);
    sc::NativeFrame nf = sc::build_native_frame(ctx, "comp_root", 0.5, vs, false);
    pl::finish_native_frame(ctx, "comp_root", 0.5, vs, false, nf, &host);
    if (errors != nullptr) {
      for (const sc::LayerError& e : nf.errors) {
        if (e.stage == "plugin") errors->push_back(e.message);
      }
    }
    const api::Renderable* r = pl::find_renderable_in(nf.file.scene.renderables, "solid");
    REQUIRE(r != nullptr);
    const api::RenderEffect* entry = nullptr;
    for (const api::RenderEffect& e : r->effects) {
      if (e.type == pl::kNativeFxType) entry = &e;
    }
    REQUIRE(entry != nullptr);
    pl::RenderInputs in;
    pl::decode_native_fx(*entry, *host.effect(kModel3d), in);
    in.worldW = std::max(1, in.layerW);
    in.worldH = std::max(1, in.layerH);
    pl::TexelImage blank;
    blank.format = pl::TexelFormat::rgba32f;
    blank.width = static_cast<std::uint32_t>(in.worldW);
    blank.height = static_cast<std::uint32_t>(in.worldH);
    blank.bytes.assign(static_cast<std::size_t>(blank.width) * blank.height * 16, 0);
    pl::TexelImage out;
    const pl::CallResult res = pl::run_native_cpu(host, in, blank, {}, out);
    INFO(res.message);
    if (errors != nullptr && !res.ok) errors->push_back(res.message);
    if (!res.ok) return {};
    std::vector<float> f(out.bytes.size() / 4);
    std::memcpy(f.data(), out.bytes.data(), out.bytes.size());
    return f;
  }

  [[nodiscard]] const Json* item(std::string_view id) const { return doc::find_asset(d, id); }

  pl::PluginHost& host;
  doc::Document d;
  doc::EditorView view;
  doc::ExprCache cache;
  std::unique_ptr<doc::DocExprEnv> env;
};

std::size_t coverage(const std::vector<float>& px) {
  std::size_t n = 0;
  for (std::size_t i = 3; i < px.size(); i += 4) n += px[i] > 0.5F ? 1 : 0;
  return n;
}

pl::HostOptions options() {
  pl::HostOptions o;
  o.searchPaths = {bundles()};
  o.threads = 2;
  o.onHang = [](const std::string&, std::string_view) { FAIL("unexpected hang"); };
  return o;
}

doc::CollectOutcome collect(const Json& document, const fs::path& folder, const std::string& sourceBundle = {}) {
  doc::CollectRequest req;
  req.folder = utf8(folder);
  req.doc = document;
  req.sourceBundle = sourceBundle;
  const auto io = doc::make_disk_collect_io();
  return doc::collect_files(std::move(req), *io);
}

}  // namespace

TEST_CASE("Collect Files carries a plugin's FILE asset and the files it lists beside it, through every save",
          "[plugins][collect][sdk12]") {
  TempDir tmp;
  pl::PluginHost host(options());
  (void)host.scan();
  REQUIRE(host.effect(kModel3d) != nullptr);
  REQUIRE(doc::NativeImporters::claims("x.ppm"));
  const Sources src(tmp.path);
  const Json original = project(src);

  // The uncollected project: the model from the .gltf + .bin beside it.
  std::vector<float> want;
  std::vector<float> wantPpm;
  {
    Open o(host, original);
    want = o.render();
    REQUIRE(coverage(want) > 1000);
    doc::NativeImage img;
    std::string why;
    REQUIRE(doc::NativeImporters::read_frame(utf8(src.dir / "clip.ppm"), 0, img, why));
    wantPpm = img.rgba;
  }

  // ── collect: the asset, its .bin and its texture, the .ppm under its name ──
  const doc::CollectOutcome out = collect(original, tmp.path / "Delivery");
  INFO("missing: " << (out.missing.empty() ? std::string() : out.missing.front()));
  CHECK(out.missing.empty());
  const fs::path bundle = fs::path(std::u8string(out.path.begin(), out.path.end()));
  const Json collected = doc::read_bundle(bundle);
  const Json& box = collected.at("projectItems").at("footage").at("m3d-box");
  CHECK(box.at("path").str().starts_with("motion-blob:"));
  CHECK(box.at("collected").at("name").str() == "box.gltf");
  CHECK(box.at("collected").at("siblings").at("box.bin").str().starts_with("motion-blob:"));
  CHECK(box.at("collected").at("siblings").at("tex/checker map.png").str().starts_with("motion-blob:"));
  const Json& clip = collected.at("projectItems").at("footage").at("clip");
  CHECK(clip.at("collected").at("name").str() == "clip.ppm");
  CHECK(clip.at("path").str().starts_with("motion-blob:"));

  // The originals go: everything below reads the collected copies only.
  fs::remove_all(src.dir);

  const auto check_open = [&](Open& o, const char* what) {
    INFO(what);
    std::vector<std::string> errors;
    CHECK(o.render(&errors) == want);
    CHECK(errors.empty());
    // The importer still claims the collected footage: it is laid out as a .ppm again.
    const Json* item = o.item("clip");
    REQUIRE(item != nullptr);
    const std::string clipSrc = item->at("src").is_string() ? item->at("src").str() : std::string();
    CHECK(clipSrc.ends_with(".ppm"));
    const doc::NativeActionRequest::File f = doc::native_file_of(o.d, "p1", "m3d-box");
    CHECK_FALSE(f.missing);
    CHECK(f.path.ends_with("box.gltf"));
  };

  SECTION("reopened from the collected bundle") {
    Open o(host, collected, utf8(bundle));
    check_open(o, "collect + reopen");
    doc::NativeImage img;
    std::string why;
    const std::string clipSrc = o.item("clip")->at("src").str();
    const std::string clipPath = premation::jobs::resolve_footage_path(clipSrc, "");
    REQUIRE(doc::NativeImporters::read_frame(clipPath, 0, img, why));
    CHECK(img.rgba == wantPpm);
  }

  SECTION("saved as another bundle from the collected project, then reopened") {
    Open o(host, collected, utf8(bundle));
    const Json saved = doc::capture_document(o.d);
    CHECK(saved.at("projectItems").at("footage").at("m3d-box").at("collected").is_object());
    const fs::path again = tmp.path / "Again.motion";
    (void)doc::write_bundle(again, saved, bundle);
    fs::remove_all(bundle);
    Open re(host, doc::read_bundle(again), utf8(again));
    check_open(re, "Save As bundle");
  }

  SECTION("a portable .motion of the collected project, then opened") {
    Open o(host, collected, utf8(bundle));
    const fs::path file = tmp.path / "Portable.motion";
    (void)doc::write_portable(file, doc::capture_document(o.d), bundle);
    fs::remove_all(bundle);
    const fs::path staging = tmp.path / "staging";
    const doc::PortableOpen p = doc::read_portable(file, staging);
    Open re(host, p.doc, utf8(p.footageRoot));
    check_open(re, "portable");
  }

  SECTION("an export's snapshot (blob references made absolute, opened as the export child does)") {
    Open o(host, collected, utf8(bundle));
    Json snap = doc::capture_document(o.d);
    premation::exporter::rewrite_blob_refs(snap, bundle);
    const fs::path file = tmp.path / "snapshot.json";
    spit(file, premation::js::stringify(snap));
    premation::exporter::OpenedProject opened;
    std::string error;
    REQUIRE(premation::exporter::open_project(file, opened, error));
    Open child(host, opened.document);
    std::vector<std::string> errors;
    CHECK(child.render(&errors) == want);
    CHECK(errors.empty());
    CHECK(child.item("clip")->at("path").str().ends_with(".ppm"));
  }

  SECTION("a recovery restore over the open collected project") {
    Open o(host, collected, utf8(bundle));
    const Json recovery = doc::capture_document(o.d);
    std::vector<Json> session = o.d.items().assets;  // what the open session holds
    doc::Document d2;
    doc::EditorView v2;
    (void)doc::restore_document(d2, v2, recovery, session);
    const doc::NativeActionRequest::File f = doc::native_file_of(d2, "p1", "m3d-box");
    CHECK_FALSE(f.missing);
    CHECK(f.path.ends_with("box.gltf"));
    CHECK(fs::is_regular_file(fs::path(std::u8string(f.path.begin(), f.path.end())).parent_path() / "box.bin"));
  }

  SECTION("a collect of the collected project carries the table without asking the plugin") {
    const doc::CollectOutcome again = collect(collected, tmp.path / "Second", utf8(bundle));
    CHECK(again.missing.empty());
    const fs::path b2 = fs::path(std::u8string(again.path.begin(), again.path.end()));
    const Json j = doc::read_bundle(b2);
    CHECK(j.at("projectItems").at("footage").at("m3d-box").at("collected") == box.at("collected"));
    fs::remove_all(bundle);
    Open re(host, j, utf8(b2));
    check_open(re, "collect of a collect");
  }
}

TEST_CASE("Collect Files: a plugin that crashes listing its files still has its asset collected", "[plugins][collect][sdk12]") {
  TempDir tmp;
  pl::PluginHost host(options());
  (void)host.scan();
  const pl::EffectSpec* spec = host.effect(kModel3d);
  REQUIRE(spec != nullptr);
  const Sources src(tmp.path);
  const Json crashing = project(src, 2, spec);  // Debug ▸ Fault: access violation

  const doc::CollectOutcome out = collect(crashing, tmp.path / "Delivery");
  const auto listed = std::ranges::find_if(out.missing, [](const std::string& m) {
    return m.find("could not list the files beside it") != std::string::npos;
  });
  REQUIRE(listed != out.missing.end());
  CHECK(listed->find("only the file itself is collected") != std::string::npos);
  const fs::path bundle = fs::path(std::u8string(out.path.begin(), out.path.end()));
  const Json collected = doc::read_bundle(bundle);
  const Json& box = collected.at("projectItems").at("footage").at("m3d-box");
  CHECK(box.at("path").str().starts_with("motion-blob:"));  // the asset itself is in the bundle
  CHECK(box.at("collected").at("name").str() == "box.gltf");
  CHECK_FALSE(box.at("collected").at("siblings").is_object());

  // The fault disabled the plugin: the reopened project's frame says so on layerErrors.
  Open o(host, collected, utf8(bundle));
  std::vector<std::string> errors;
  (void)o.render(&errors);
  CHECK_FALSE(errors.empty());
}
