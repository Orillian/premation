// P7 — plugins that are not effects (docs/PLUGIN_SDK.md "Commands",
// "Importers", "Output modules", "Panels"), through the real protocol where
// the editor uses them: the samples distribute (a command), ppmio (an
// importer), ppmseq (an output module) and statspanel (a panel + a command).
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include "api_json.hpp"
#include "contrib.hpp"
#include "host.hpp"
#include "manifest.hpp"
#include "native_contrib.hpp"
#include "native_effects.hpp"
#include "session_harness.hpp"

using namespace premation;
using namespace premation::test;
namespace pl = premation::plugins;
namespace fs = std::filesystem;

namespace {

constexpr const char* kDistribute = "com.premation.samples.distribute";
constexpr const char* kPpmio = "com.premation.samples.ppmio";
constexpr const char* kPpmseq = "com.premation.samples.ppmseq";
constexpr const char* kStats = "com.premation.samples.statspanel";

pl::HostOptions attached() {
  pl::HostOptions o;
  o.searchPaths = {fs::path(PREMATION_PLUGIN_BUNDLES)};
  o.threads = 2;
  o.attachToDocument = true;
  return o;
}

template <class T>
T query(Harness& h, api::Query q) {
  const auto r = h.ask(std::move(q));
  REQUIRE(is_ok(r));
  return result_as<T>(std::get<api::QueryResult>(r.outcome.v));
}

api::ItemId comp(Harness& h) {
  api::CreateComposition c;
  c.settings.name = "Contrib";
  c.settings.width = 320;
  c.settings.height = 180;
  c.settings.frame_rate = api::Rational{30, 1};
  c.settings.duration = 705'600'000LL * 2;
  const auto rc = h.run(cmd(c));
  REQUIRE(is_ok(rc));
  return result_item(rc);
}

api::LayerId solid_at(Harness& h, const api::ItemId& c, double x, double y) {
  api::CreateLayer l;
  l.comp = c;
  l.kind = api::LayerKind::solid;
  const auto rl = h.run(cmd(l));
  REQUIRE(is_ok(rl));
  const api::LayerId id = result_layer(rl);
  api::SetProperty sp;
  sp.prop = {id, "transform/position"};
  sp.value = vec2(x, y);
  REQUIRE(is_ok(h.run(cmd(sp))));
  return id;
}

api::Vec2 position(Harness& h, const api::LayerId& layer) {
  api::GetPropertyValues q;
  q.props = {{layer, "transform/position"}};
  q.time = 0;
  const auto v = query<api::PropertyValues>(h, qry(q));
  REQUIRE(v.values.size() == 1);
  return std::get<api::Vec2>(v.values[0].value.v);
}

std::vector<api::PluginCommandInfo> commands(Harness& h) { return query<api::PluginCommandList>(h, qry(api::ListPluginCommands{})).commands; }

const api::PluginCommandInfo* find_command(const std::vector<api::PluginCommandInfo>& list, std::string_view plugin, std::string_view id) {
  const auto it = std::ranges::find_if(list, [&](const api::PluginCommandInfo& c) { return c.plugin == plugin && c.id == id; });
  return it == list.end() ? nullptr : &*it;
}

fs::path temp_dir(const std::string& name) {
  const fs::path d = fs::temp_directory_path() / ("premation-contrib-" + name);
  std::error_code ec;
  fs::remove_all(d, ec);
  fs::create_directories(d);
  return d;
}

/// A w × h P6 PPM whose pixel (x, y) is (x * 10, y * 10, 200).
void write_ppm(const fs::path& p, int w, int h) {
  std::ofstream f(p, std::ios::binary);
  f << "P6\n" << w << " " << h << "\n255\n";
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) f << static_cast<char>(x * 10) << static_cast<char>(y * 10) << static_cast<char>(200);
  }
}

/// A w × h little-endian PF (colour) PFM, every pixel (0.25, 2.0, 0.5): bottom-up rows.
void write_pfm(const fs::path& p, int w, int h) {
  std::ofstream f(p, std::ios::binary);
  f << "PF\n" << w << " " << h << "\n-1.0\n";
  const float px[3] = {0.25F, 2.0F, 0.5F};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays)
  for (int i = 0; i < w * h; ++i) f.write(reinterpret_cast<const char*>(px), sizeof px);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
}

std::string slurp(const fs::path& p) {
  std::ifstream f(p, std::ios::binary);
  return {std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>()};
}

std::string utf8(const fs::path& p) {
  const std::u8string u = p.u8string();
  return {u.begin(), u.end()};
}

}  // namespace

TEST_CASE("P7 manifest: commands, importers, output modules, panels", "[plugins][contrib]") {
  std::string err;
  const auto m = pl::parse_manifest(R"({
    "manifestVersion": 1, "id": "com.example.tools", "sdk": {"major": 1, "minor": 2},
    "binary": {"windows": "t.dll", "macos": "libt.dylib", "linux": "libt.so"},
    "commands": [{"id": "align", "name": "Align", "menu": "Arrange"}],
    "importers": [{"id": "img", "extensions": [".PPM", "pfm", "ppm"]}],
    "outputModules": [{"id": "seq", "name": "Seq", "extension": "ppm",
      "options": [{"id": "depth", "type": "popup", "choices": ["8", "16"], "default": 7},
                  {"id": "q", "type": "number", "default": 3, "min": 1, "max": 9},
                  {"id": "on", "type": "checkbox", "default": true}]}],
    "panels": [{"id": "p", "name": "Panel", "page": "panels/p.html"}]
  })", "windows", err);
  REQUIRE(m);
  CHECK(m->effects.empty());
  REQUIRE(m->commands.size() == 1);
  CHECK(m->commands[0].menu == "Arrange");
  REQUIRE(m->importers.size() == 1);
  CHECK(m->importers[0].extensions == std::vector<std::string>{"ppm", "pfm"});
  REQUIRE(m->outputModules.size() == 1);
  CHECK(m->outputModules[0].options.at(0).def == 2);  // a popup default clamps to its choices
  CHECK(m->outputModules[0].options.at(2).def == 1);
  CHECK(m->panels.at(0).page == "panels/p.html");

  const auto bad = [&](const char* body) {
    std::string e;
    const std::string json = std::string(R"({"manifestVersion": 1, "id": "com.example.tools", "sdk": {"major": 1, "minor": 2},
      "binary": {"windows": "t.dll"}, )") + body + "}";
    return !pl::parse_manifest(json, "windows", e) && !e.empty();
  };
  CHECK(bad(R"("commands": [{"name": "no id"}])"));
  CHECK(bad(R"("commands": [{"id": "a"}, {"id": "a"}])"));
  CHECK(bad(R"("importers": [{"id": "i", "extensions": []}])"));
  CHECK(bad(R"("importers": [{"id": "i", "extensions": ["p/m"]}])"));
  CHECK(bad(R"("outputModules": [{"id": "o"}])"));
  CHECK(bad(R"("outputModules": [{"id": "o", "extension": "x", "options": [{"id": "a", "type": "slider"}]}])"));
  CHECK(bad(R"("panels": [{"id": "p", "page": "../escape.html"}])"));
  CHECK(bad(R"("effects": [])"));  // nothing at all
}

TEST_CASE("P7a the engine API as JSON", "[plugins][contrib]") {
  std::string err;
  const auto c = pl::command_from_json(
      R"({"type":"setProperty","prop":{"layer":"l1","path":"transform/position"},"value":{"kind":"vec2","value":{"x":3,"y":4}},"time":0})", err);
  REQUIRE(c);
  const auto* sp = std::get_if<api::SetProperty>(&c->v);
  REQUIRE(sp != nullptr);
  CHECK(sp->prop.layer == "l1");
  CHECK(std::get<api::Vec2>(sp->value.v) == api::Vec2{3, 4});
  CHECK(sp->time == 0);
  CHECK_FALSE(pl::command_from_json(R"({"type":"noSuchCommand"})", err));
  CHECK_FALSE(pl::command_from_json(R"({"type":"setProperty","prop":{"layer":7}})", err));
  CHECK(err.find("layer") != std::string::npos);
  CHECK_FALSE(pl::command_from_json("not json", err));
  const auto q = pl::query_from_json(R"({"type":"getComposition","comp":"comp_root"})", err);
  REQUIRE(q);
  CHECK(std::get<api::GetComposition>(q->v).comp == "comp_root");
  api::EngineError e;
  e.code = api::ErrorCode::not_found;
  e.message = "gone";
  CHECK(pl::to_json(e) == R"({"code":"notFound","message":"gone"})");
}

TEST_CASE("P7a commands: list, run, one undo entry, the log, crash isolation", "[plugins][contrib]") {
  pl::PluginHost host(attached());
  host.scan();
  Harness h;
  (void)h.hello();

  // listPluginCommands and listPlugins carry them.
  auto list = commands(h);
  const auto* dist = find_command(list, kDistribute, "distribute");
  REQUIRE(dist != nullptr);
  CHECK(dist->name == "Distribute Layers");
  CHECK(dist->menu == "Arrange");
  CHECK(dist->enabled);
  const auto plugins = query<api::PluginList>(h, qry(api::ListPlugins{})).plugins;
  const auto pi = std::ranges::find_if(plugins, [](const api::PluginInfo& p) { return p.id == kDistribute; });
  REQUIRE(pi != plugins.end());
  CHECK(pi->status == api::PluginStatus::loaded);
  CHECK(pi->effects.empty());
  REQUIRE(pi->commands.size() == 1);

  const api::ItemId c = comp(h);
  const api::LayerId a = solid_at(h, c, 10, 50);
  const api::LayerId b = solid_at(h, c, 200, 60);
  const api::LayerId d = solid_at(h, c, 100, 70);
  const auto before = query<api::HistoryState>(h, qry(api::GetHistory{}));

  api::RunPluginCommand run;
  run.plugin = kDistribute;
  run.command = "distribute";
  run.comp = c;
  run.layers = {a, b, d};
  run.time = 0;
  const std::size_t sent = h.messages.size();
  const auto r = h.run(cmd(run));
  REQUIRE(is_ok(r));
  const auto res = result_as<api::PluginCommandResult>(r);
  CHECK(res.edits == 1);  // only the middle layer moves
  CHECK(res.message == "distributed 3 layers");
  CHECK(position(h, d) == api::Vec2{105, 70});  // halfway between 10 and 200, y kept
  CHECK(position(h, a) == api::Vec2{10, 50});
  // ONE history entry with the command's name.
  const auto after = query<api::HistoryState>(h, qry(api::GetHistory{}));
  REQUIRE(after.position == before.position + 1);
  CHECK(after.entries.at(after.position - 1).label == "Distribute Layers");
  // The command log holds the plugin's edits (a replay never runs the plugin).
  bool logged = false;
  for (std::size_t i = sent; i < h.messages.size(); ++i) {
    if (h.messages[i].kind() != api::EngineMessage::Kind::log_record) continue;
    const auto& rec = std::get<api::LogRecord>(h.messages[i].v);
    REQUIRE(rec.request.body.kind() == api::RequestBody::Kind::batch);
    const auto& batch = std::get<api::CommandBatch>(rec.request.body.v);
    CHECK(batch.label == "Distribute Layers");
    REQUIRE(batch.commands.size() == 1);
    CHECK(batch.commands[0].kind() == api::Command::Kind::set_property);
    CHECK(rec.job.value_or("").starts_with("plugin:"));
    logged = true;
  }
  CHECK(logged);
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  CHECK(position(h, d) == api::Vec2{100, 70});
  REQUIRE(is_ok(h.run(cmd(api::Redo{}))));
  CHECK(position(h, d) == api::Vec2{105, 70});
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));

  // The plugin's own error: nothing changes, an internal error with its message.
  run.layers = {a, b};
  const auto few = h.run(cmd(run));
  REQUIRE(is_error(few, api::ErrorCode::internal));
  CHECK(std::get<api::EngineError>(few.outcome.v).message.find("three or more") != std::string::npos);

  // A crash after a first edit: rolled back, the command disabled, the engine fine.
  const api::LayerId e = solid_at(h, c, 150, 80);
  run.layers = {a, b, d, e};
  run.args = R"({"fault":"access_violation"})";
  const auto histBefore = query<api::HistoryState>(h, qry(api::GetHistory{}));
  const auto crashed = h.run(cmd(run));
  REQUIRE(is_error(crashed, api::ErrorCode::internal));
  CHECK(std::get<api::EngineError>(crashed.outcome.v).message.find("crashed") != std::string::npos);
  CHECK(position(h, d) == api::Vec2{100, 70});  // the first edit rolled back
  CHECK(query<api::HistoryState>(h, qry(api::GetHistory{})).position == histBefore.position);
  list = commands(h);
  REQUIRE(find_command(list, kDistribute, "distribute") != nullptr);
  CHECK_FALSE(find_command(list, kDistribute, "distribute")->enabled);
  run.args.reset();
  CHECK(is_error(h.run(cmd(run)), api::ErrorCode::not_found));
  // Re-enabling the plugin re-arms it.
  api::SetPluginEnabled on;
  on.plugin = kDistribute;
  on.enabled = true;
  REQUIRE(is_ok(h.run(cmd(on))));
  CHECK(find_command(commands(h), kDistribute, "distribute")->enabled);
  CHECK(is_ok(h.run(cmd(run))));

  // A disabled plugin's command is listed off and does not run.
  api::SetPluginEnabled off;
  off.plugin = kDistribute;
  off.enabled = false;
  REQUIRE(is_ok(h.run(cmd(off))));
  CHECK_FALSE(find_command(commands(h), kDistribute, "distribute")->enabled);
  CHECK(is_error(h.run(cmd(run)), api::ErrorCode::not_found));
  REQUIRE(is_ok(h.run(cmd(on))));

  // Another plugin's command (statspanel's Number Layers) and unknown ones.
  api::RunPluginCommand number;
  number.plugin = kStats;
  number.command = "number";
  number.layers = {a, b};
  number.args = R"({"prefix":"Shot"})";
  REQUIRE(is_ok(h.run(cmd(number))));
  api::GetLayers gl;
  gl.layers = {a, b};
  const auto names = query<api::LayerDetails>(h, qry(gl));
  CHECK(names.layers.at(0).name == "Shot 1");
  CHECK(names.layers.at(1).name == "Shot 2");
  number.command = "nope";
  CHECK(is_error(h.run(cmd(number)), api::ErrorCode::not_found));
}

TEST_CASE("P7b importers: .ppm / .pfm footage through the plugin, failures isolated", "[plugins][contrib]") {
  pl::PluginHost host(attached());
  host.scan();
  const fs::path dir = temp_dir("import");
  write_ppm(dir / "grad.ppm", 4, 3);
  write_pfm(dir / "hdr.pfm", 2, 2);
  write_ppm(dir / "crash.ppm", 2, 2);

  CHECK(doc::NativeImporters::claims(utf8(dir / "grad.ppm")));
  CHECK(doc::NativeImporters::claims("X:/A.PFM"));
  CHECK_FALSE(doc::NativeImporters::claims("x.png"));

  // importFiles: the plugin's PROBE is the item's facts.
  Harness h;
  (void)h.hello();
  api::ImportFiles imp;
  imp.files.push_back(api::ImportFile{utf8(dir / "grad.ppm"), false, std::nullopt, std::nullopt, false, std::nullopt});
  const auto ri = h.run(cmd(imp));
  REQUIRE(is_ok(ri));
  api::GetItems gi;
  gi.items = result_as<api::ItemList>(ri).items;
  const auto items = query<api::ItemDetails>(h, qry(gi));
  REQUIRE(items.items.size() == 1);
  CHECK(items.items[0].width == 4);
  CHECK(items.items[0].height == 3);
  CHECK(items.items[0].codec == "PPM");

  // READ_FRAME: straight RGBA float, as the texture feed takes it.
  doc::NativeImage img;
  std::string err;
  REQUIRE(doc::NativeImporters::read_frame(utf8(dir / "grad.ppm"), 0, img, err));
  REQUIRE(img.width == 4);
  REQUIRE(img.height == 3);
  CHECK_FALSE(img.linear);
  const auto px = [&](std::uint32_t x, std::uint32_t y, int c) { return img.rgba.at((y * img.width + x) * 4 + static_cast<std::uint32_t>(c)); };
  CHECK(std::fabs(px(3, 2, 0) - 30.0F / 255) < 1e-6F);
  CHECK(std::fabs(px(3, 2, 1) - 20.0F / 255) < 1e-6F);
  CHECK(px(1, 1, 3) == 1.0F);
  REQUIRE(doc::NativeImporters::read_frame(utf8(dir / "hdr.pfm"), 0, img, err));
  CHECK(img.linear);
  CHECK(img.rgba.at(1) == 2.0F);  // over-range kept (scene-linear)

  // A file the plugin refuses: io with its message.
  write_ppm(dir / "broken.ppm", 2, 2);
  imp.files[0].path = utf8(dir / "broken.ppm");
  const auto rb = h.run(cmd(imp));
  REQUIRE(is_error(rb, api::ErrorCode::io));
  CHECK(std::get<api::EngineError>(rb.outcome.v).message.find("plugin failed to read") != std::string::npos);

  // A crash in READ_FRAME fails that read; the importer is then off for the session
  // (every read fails with why), the engine carries on.
  CHECK_FALSE(doc::NativeImporters::read_frame(utf8(dir / "crash.ppm"), 0, img, err));
  CHECK(err.find("crashed") != std::string::npos);
  CHECK_FALSE(doc::NativeImporters::read_frame(utf8(dir / "grad.ppm"), 0, img, err));
  // setPluginEnabled(true) re-arms it.
  REQUIRE(host.set_enabled(kPpmio, true));
  host.contrib().reset(kPpmio);
  CHECK(doc::NativeImporters::read_frame(utf8(dir / "grad.ppm"), 0, img, err));

  // A failure recorded by the texture feed is what layerErrors shows for the footage.
  doc::NativeImporters::set_failure("crash.ppm", "plugin failed to read 'crash.ppm': crashed");
  CHECK(doc::NativeImporters::failure("crash.ppm").has_value());
  doc::NativeImporters::clear_failure("crash.ppm");
}

TEST_CASE("P7c output modules: a .ppm sequence, options, failures", "[plugins][contrib]") {
  pl::PluginHost host(attached());
  host.scan();
  const fs::path dir = temp_dir("export");
  const std::string format = std::string("plugin:") + kPpmseq + "/ppmseq";

  // Options: declared defaults under the user's values, clamped.
  CHECK(host.contrib().output_options(format, R"({"digits": 40})") == R"({"depth":1,"digits":9,"fault":1})");

  std::string err;
  auto job = host.contrib().output_job(format, err);
  REQUIRE(job);
  pl::OutputParams p;
  p.path = utf8(dir / "shot.ppm");
  p.width = 2;
  p.height = 1;
  p.frameCount = 3;
  p.optionsJson = host.contrib().output_options(format, R"({"digits": 3})");
  REQUIRE(job->begin(p, err));
  const std::vector<float> frame = {1, 0, 0, 1, 0, 0.5F, 1, 1};
  for (int i = 0; i < 3; ++i) REQUIRE(job->write_frame(i, 0, frame.data(), err));
  REQUIRE(job->finish(false, err));
  const std::string ppm = slurp(dir / "shot_002.ppm");
  CHECK(ppm == std::string("P6\n2 1\n255\n") + std::string("\xff\x00\x00\x00\x80\xff", 6));

  // A crash on frame 2 fails the job with why; nothing else is affected.
  job = host.contrib().output_job(format, err);
  REQUIRE(job);
  p.optionsJson = host.contrib().output_options(format, R"({"fault": 2})");
  REQUIRE(job->begin(p, err));
  REQUIRE(job->write_frame(0, 0, frame.data(), err));
  REQUIRE(job->write_frame(1, 0, frame.data(), err));
  CHECK_FALSE(job->write_frame(2, 0, frame.data(), err));
  CHECK(err.find("crashed") != std::string::npos);
  job.reset();
  // An unknown module and a disabled plugin.
  CHECK_FALSE(host.contrib().output_job("plugin:com.example.nope/x", err));
  REQUIRE(host.set_enabled(kPpmseq, false));
  CHECK_FALSE(host.contrib().output_job(format, err));
  REQUIRE(host.set_enabled(kPpmseq, true));
  CHECK(host.contrib().output_job(format, err));

  // The export's frame bytes → the module's floats.
  std::vector<float> f;
  pl::export_frame_to_float(std::vector<std::uint8_t>{255, 0, 51, 255}, 8, f);
  CHECK(f == std::vector<float>{1, 0, 0.2F, 1});
}

TEST_CASE("P7d panels are listed from the manifest", "[plugins][contrib]") {
  pl::PluginHost host(attached());
  host.scan();
  const auto infos = host.plugin_infos();
  const auto it = std::ranges::find_if(infos, [](const api::PluginInfo& p) { return p.id == kStats; });
  REQUIRE(it != infos.end());
  REQUIRE(it->panels.size() == 1);
  CHECK(it->panels[0].id == "stats");
  CHECK(it->panels[0].page == "stats.html");
  CHECK(it->commands.size() == 1);
  const auto io = std::ranges::find_if(infos, [](const api::PluginInfo& p) { return p.id == kPpmio; });
  REQUIRE(io != infos.end());
  REQUIRE(io->importers.size() == 1);
  CHECK(io->importers[0].extensions == std::vector<std::string>{"ppm", "pfm"});
  const auto seq = std::ranges::find_if(infos, [](const api::PluginInfo& p) { return p.id == kPpmseq; });
  REQUIRE(seq != infos.end());
  REQUIRE(seq->output_modules.size() == 1);
  CHECK(seq->output_modules[0].options.size() == 3);
}
