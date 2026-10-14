// Job kind `depthEstimate` — Make 3D from Photo / Video (camera program D3).
//
// Depth Anything V2 Small (ONNX, Apache-2.0; depth_ort.hpp) estimates every
// frame of an image / video layer's picture: a still once, footage once per
// source frame over the layer's span. Each depth map is written as an 8-bit
// greyscale PNG (near = white) into the output folder — `depth_00000.png` for
// a still, `depth_<source frame>.png` for footage — the on-disk cache a re-run
// with the same folder reuses frame by frame.
//
// The model runs in a CHILD engine process (child_job.hpp): a crash inside the
// runtime fails the job, never the engine. Its file: the spec's, else the one
// the user installed (PREMATION_DEPTH_USER_DIR, set by Electron main to
// <userData>/models/depth-anything), else a bundled one (PREMATION_DEPTH_DIR).
//
// Apply, ONE entry: the layer 3D, its Depth Source pointed at the maps
// (`src:<png>` for a still, `seq:<fps>:<folder>` for footage) and its Depth
// Scale set — the Depth Parallax renderer (threed_port.cpp) does the rest.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "child_job.hpp"
#include "depth_ort.hpp"
#include "fail.hpp"
#include "job_apply_util.hpp"
#include "job_inputs.hpp"
#include "job_kinds.hpp"
#include "json.hpp"
#include "media_input.hpp"
#include "png_write.hpp"
#include "values.hpp"

namespace premation::jobs {

using api::ErrorCode;
using doc::fail;
using doc::Json;
namespace fs = std::filesystem;


namespace {

/// The depth maps' long edge (the renderer samples at most 256 px; headroom for re-use).
constexpr std::uint32_t kMapEdge = 512;

std::string model_file(const std::string& given) {
  if (!given.empty()) return given;
  for (const char* var : {"PREMATION_DEPTH_USER_DIR", "PREMATION_DEPTH_DIR"}) {
    const char* dir = std::getenv(var);  // NOLINT(concurrency-mt-unsafe): read-only, set before the engine starts
    if (dir == nullptr || *dir == '\0') continue;
    const fs::path p = fs::path(dir) / depth::kModelFile;
    std::error_code ec;
    if (fs::exists(p, ec)) return p.string();
  }
  return {};
}

fs::path path_of(const std::string& s) { return fs::path(std::u8string(s.begin(), s.end())); }
std::string utf8(const fs::path& p) {
  const std::u8string u = p.u8string();
  return {u.begin(), u.end()};
}

std::string frame_name(std::int64_t frame) {
  std::array<char, 32> name{};
  (void)std::snprintf(name.data(), name.size(), "depth_%05lld.png", static_cast<long long>(frame));  // NOLINT(cppcoreguidelines-pro-type-vararg)
  return name.data();
}

// ── the child ────────────────────────────────────────────────────────────

/// Input: {file, model, outDir, frames:[source frame…]}. Output: {written, reused, provider, fps}.
std::string depth_child(const std::string& inputJson, JobControl& control) {
  const std::optional<Json> in = js::parse(inputJson);
  if (!in || !in->is_object() || !in->at("file").is_string() || !in->at("model").is_string() || !in->at("outDir").is_string()) {
    fail(ErrorCode::invalid_argument, "depthEstimate: bad input");
  }
  std::string error;
  std::unique_ptr<FrameSource> src = open_frames(in->at("file").str(), 0, error);
  if (!src) fail(ErrorCode::decode, "cannot read the footage: " + error);
  control.progress(0.02, "Loading the depth model");
  std::unique_ptr<depth::DepthModel> model = depth::load(in->at("model").str(), error);
  if (!model) fail(depth::runtime_available() ? ErrorCode::io : ErrorCode::unsupported, "Depth model: " + error);
  const fs::path outDir = path_of(in->at("outDir").str());
  std::error_code ec;
  fs::create_directories(outDir, ec);
  const double aspect = src->source_height() > 0 ? static_cast<double>(src->source_width()) / src->source_height() : 1;
  const std::uint32_t mw = aspect >= 1 ? kMapEdge : std::max(1U, static_cast<std::uint32_t>(std::lround(kMapEdge * aspect)));
  const std::uint32_t mh = aspect >= 1 ? std::max(1U, static_cast<std::uint32_t>(std::lround(kMapEdge / aspect))) : kMapEdge;
  const Json::Array& frames = in->at("frames").arr();
  std::size_t written = 0;
  std::size_t reused = 0;
  RgbaImage img;
  std::vector<float> out;
  for (std::size_t i = 0; i < frames.size(); ++i) {
    if (control.cancelled()) return "{}";
    const auto frame = static_cast<std::int64_t>(frames[i].num());
    const fs::path file = outDir / frame_name(frame);
    if (fs::exists(file, ec)) {  // the on-disk cache
      ++reused;
      continue;
    }
    if (!src->read(std::clamp<std::int64_t>(frame, 0, std::max<std::int64_t>(0, src->frame_count() - 1)), img, error)) {
      fail(ErrorCode::decode, "frame " + std::to_string(frame) + ": " + error);
    }
    const std::vector<float> input = depth::prepare_input(img.rgba, img.width, img.height);
    if (!model->run(input, out, error)) fail(ErrorCode::internal, "Depth model: " + error);
    const std::vector<std::uint8_t> gray = depth::depth_to_gray(out, mw, mh);
    std::vector<std::uint8_t> png;
    if (!exporter::encode_png_rgba8(gray, mw, mh, png)) fail(ErrorCode::io, "could not encode a depth map");
    const fs::path tmp = file.string() + ".tmp";
    {
      std::FILE* f = std::fopen(utf8(tmp).c_str(), "wb");  // NOLINT(cppcoreguidelines-owning-memory)
      if (f == nullptr) fail(ErrorCode::io, "cannot write " + utf8(tmp));
      const std::size_t n = std::fwrite(png.data(), 1, png.size(), f);
      (void)std::fclose(f);  // NOLINT(cppcoreguidelines-owning-memory)
      if (n != png.size()) fail(ErrorCode::io, "cannot write " + utf8(tmp));
    }
    fs::rename(tmp, file, ec);  // temp + rename: a crash never leaves a half map in the cache
    if (ec) fail(ErrorCode::io, "cannot write " + utf8(file));
    ++written;
    control.progress(0.05 + 0.95 * static_cast<double>(i + 1) / static_cast<double>(frames.size()),
                     "Estimating depth " + std::to_string(i + 1) + " / " + std::to_string(frames.size()));
  }
  Json res = Json::object();
  res.set("written", Json::number(static_cast<double>(written)));
  res.set("reused", Json::number(static_cast<double>(reused)));
  res.set("provider", Json::string(model->provider()));
  res.set("fps", Json::number(src->fps()));
  return js::stringify(res);
}

struct DepthJob {
  FootageLayer fl;
  std::string inputJson;
  std::string outDir;
  bool still = true;
  double fps = 30;
  double scale = 300;
};

class DepthResult final : public JobResult {
 public:
  DepthResult(DepthJob job, std::size_t written, std::size_t reused, std::string provider)
      : job_(std::move(job)), written_(written), reused_(reused), provider_(std::move(provider)) {}

  [[nodiscard]] std::string summary_json() const override {
    Json s = Json::object();
    s.set("written", Json::number(static_cast<double>(written_)));
    s.set("reused", Json::number(static_cast<double>(reused_)));
    s.set("provider", Json::string(provider_));
    s.set("folder", Json::string(job_.outDir));
    return js::stringify(s);
  }
  [[nodiscard]] std::string label() const override { return "Make 3D from Photo"; }

  void apply(JobApply& a) const override {
    api::SetLayerSwitches sw;
    sw.layers = {job_.fl.layer};
    sw.patch.three_d = true;
    (void)a.run(command(std::move(sw)));
    const std::string source = job_.still ? "src:" + utf8(path_of(job_.outDir) / frame_name(0))
                                          : "seq:" + std::to_string(job_.fps) + ":" + job_.outDir;
    api::SetProperty sp;
    sp.prop = api::PropRef{job_.fl.layer, "layer/depthSource"};
    sp.value = doc::v_string(source);
    (void)a.run(command(std::move(sp)));
    api::SetProperty scale;
    scale.prop = api::PropRef{job_.fl.layer, "geometry/depthScale"};
    scale.value = doc::v_scalar(job_.scale);
    (void)a.run(command(std::move(scale)));
  }

 private:
  DepthJob job_;
  std::size_t written_;
  std::size_t reused_;
  std::string provider_;
};

}  // namespace

void register_depth_child() { register_child_work("depthEstimate", depth_child); }

PreparedJob prepare_depth_estimate(const api::DepthEstimateJob& spec, const JobDocContext& ctx) {
  DepthJob job;
  job.fl = footage_layer(ctx, spec.layer, Need::picture);
  const std::string model = model_file(spec.model.value_or(""));
  if (model.empty()) {
    fail(ErrorCode::unsupported,
         "Make 3D from Photo needs the depth model — it downloads once on first use (the desktop app), or pick a depth-map layer.",
         {.layer = spec.layer});
  }
  job.still = job.fl.kind == api::LayerKind::image;
  if (spec.depth_scale) job.scale = *spec.depth_scale;
  fs::path folder = spec.output_folder ? path_of(*spec.output_folder) : fs::path();
  if (folder.empty()) {
    const fs::path base = !ctx.projectPath.empty() ? path_of(ctx.projectPath).parent_path() / "Depth Maps" : fs::temp_directory_path() / "premation-depth";
    folder = base / path_of(spec.layer);
  }
  job.outDir = utf8(folder);
  std::string error;
  // The source frames over the layer's span (a still: frame 0).
  Json frames = Json::array();
  if (job.still) {
    frames.arr_mut().push_back(Json::number(0));
  } else {
    std::unique_ptr<FrameSource> probe = open_frames(job.fl.file, 64, error);
    if (!probe) fail(ErrorCode::decode, "cannot read the footage: " + error, {.layer = spec.layer});
    job.fps = probe->fps() > 0 ? probe->fps() : 30;
    const double a = job.fl.source_seconds(job.fl.in_seconds());
    const double b = job.fl.source_seconds(job.fl.out_seconds());
    auto f0 = static_cast<std::int64_t>(std::floor(std::max(0.0, std::min(a, b)) * job.fps + 1e-6));
    auto f1 = static_cast<std::int64_t>(std::ceil(std::max(a, b) * job.fps - 1e-6));
    f1 = std::min(f1, std::max<std::int64_t>(0, probe->frame_count() - 1));
    f0 = std::min(f0, f1);
    if (f1 - f0 > 9000) fail(ErrorCode::out_of_range, "the layer spans more than 9000 frames — trim it first", {.layer = spec.layer});
    for (std::int64_t f = f0; f <= f1; ++f) frames.arr_mut().push_back(Json::number(static_cast<double>(f)));
  }
  Json in = Json::object();
  in.set("file", Json::string(job.fl.file));
  in.set("model", Json::string(model));
  in.set("outDir", Json::string(job.outDir));
  in.set("frames", std::move(frames));
  job.inputJson = js::stringify(in);

  return PreparedJob{"depthEstimate", [job = std::move(job)](JobControl& control) -> std::unique_ptr<JobResult> {
    const std::optional<std::string> out = run_child("depthEstimate", job.inputJson, control);
    if (!out) return nullptr;
    const std::optional<Json> res = js::parse(*out);
    if (!res || !res->is_object()) fail(ErrorCode::internal, "depthEstimate: the child answered nothing");
    const auto n = [&](const char* k) { return res->at(k).is_number() ? static_cast<std::size_t>(res->at(k).num()) : std::size_t{0}; };
    return std::make_unique<DepthResult>(job, n("written"), n("reused"),
                                         res->at("provider").is_string() ? res->at("provider").str() : std::string("cpu"));
  }};
}

}  // namespace premation::jobs
