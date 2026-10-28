// Object Matte's two SlimSAM encoders give the same matte: the float32
// encoder on a GPU provider (DirectML, models.json "object-matte-gpu") and the
// quantized encoder on the CPU (the bundled pair), both through the quantized
// decoder on the CPU. Each subject's mask from the two must agree (IoU), and
// the encoder time of each is reported. Skips without the model files:
//   PREMATION_SAM_TEST_DIR       the folder with the quantized pair (public/models/object-matte)
//   PREMATION_SAM_GPU_TEST_DIR   the folder with vision_encoder.onnx (public/models/object-matte-gpu)
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <string>
#include <vector>

#include "sam_ort.hpp"
#include "sam_pipeline.hpp"

namespace sam = premation::jobs::sam;

namespace {

std::string env(const char* name) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  const char* v = std::getenv(name);  // NOLINT(concurrency-mt-unsafe)
#pragma clang diagnostic pop
  return v == nullptr ? std::string() : std::string(v);
}

constexpr std::uint32_t kW = 1280;
constexpr std::uint32_t kH = 720;

/// A textured field (a gradient with a deterministic ripple) holding a red disc and a blue square.
std::vector<std::uint8_t> scene() {
  std::vector<std::uint8_t> px(std::size_t{kW} * kH * 4, 255);
  for (std::uint32_t y = 0; y < kH; ++y) {
    for (std::uint32_t x = 0; x < kW; ++x) {
      const std::size_t i = (std::size_t{y} * kW + x) * 4;
      const double ripple = 12.0 * std::sin(x * 0.05) * std::cos(y * 0.07);
      double r = 70 + 60.0 * x / kW + ripple;
      double g = 90 + 50.0 * y / kH + ripple;
      double b = 80 + ripple;
      if (std::hypot(x - 400.0, y - 360.0) < 130) {
        r = 220;
        g = 40;
        b = 40;
      } else if (x >= 820 && x < 1040 && y >= 200 && y < 420) {
        r = 30;
        g = 60;
        b = 210;
      }
      px[i] = static_cast<std::uint8_t>(std::clamp(r, 0.0, 255.0));
      px[i + 1] = static_cast<std::uint8_t>(std::clamp(g, 0.0, 255.0));
      px[i + 2] = static_cast<std::uint8_t>(std::clamp(b, 0.0, 255.0));
    }
  }
  return px;
}

double iou(const std::vector<std::uint8_t>& a, const std::vector<std::uint8_t>& b) {
  std::size_t inter = 0;
  std::size_t uni = 0;
  for (std::size_t i = 0; i < a.size(); ++i) {
    const bool x = a[i] != 0;
    const bool y = b[i] != 0;
    inter += x && y ? 1 : 0;
    uni += x || y ? 1 : 0;
  }
  return uni == 0 ? 1.0 : static_cast<double>(inter) / static_cast<double>(uni);
}

struct Run {
  std::string provider;
  double encodeMs = 0;  // the median of three after a warm-up
  std::vector<std::vector<std::uint8_t>> masks;
};

Run run_with(const std::string& enc, const std::string& dec, const std::string& gpu, const std::vector<sam::Point>& clicks) {
  Run out;
  std::string error;
  std::unique_ptr<sam::Models> m = sam::load(enc, dec, error, true, gpu);
  REQUIRE(m != nullptr);
  out.provider = m->provider();
  const std::vector<std::uint8_t> px = scene();
  const std::vector<float> pixels = sam::preprocess(px, kW, kH);
  sam::Embeddings emb;
  REQUIRE(m->encode(pixels, emb, error));  // warm-up (a GPU provider compiles its kernels here)
  std::vector<double> times;
  for (int k = 0; k < 3; ++k) {
    const auto t0 = std::chrono::steady_clock::now();
    REQUIRE(m->encode(pixels, emb, error));
    times.push_back(std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count());
  }
  std::sort(times.begin(), times.end());
  out.encodeMs = times[1];
  const sam::Letterbox lb = sam::letterbox(kW, kH);
  for (const sam::Point& p : clicks) {
    const std::vector<sam::Point> one{p};
    const std::optional<sam::Prompts> prompts = sam::prompts_for(one, std::nullopt, lb.scale);
    REQUIRE(prompts);
    sam::Decoded d;
    REQUIRE(m->decode(emb, *prompts, d, error));
    out.masks.push_back(sam::mask_from_decoder(d.iouScores.data, d.predMasks.data, kW, kH, std::nullopt));
    REQUIRE(out.masks.back().size() == std::size_t{kW} * kH);
  }
  return out;
}

}  // namespace

TEST_CASE("SlimSAM: the float encoder on the GPU matches the quantized one on the CPU", "[sam][ort][gpu]") {
  const std::string dir = env("PREMATION_SAM_TEST_DIR");
  const std::string gpuDir = env("PREMATION_SAM_GPU_TEST_DIR");
  const std::filesystem::path enc = std::filesystem::path(dir) / "vision_encoder_quantized.onnx";
  const std::filesystem::path dec = std::filesystem::path(dir) / "prompt_encoder_mask_decoder_quantized.onnx";
  // PREMATION_SAM_GPU_TEST_FILE picks another float export in that folder (vision_encoder_fp16.onnx).
  const std::string gpuFile = env("PREMATION_SAM_GPU_TEST_FILE");
  const std::filesystem::path gpu = std::filesystem::path(gpuDir) / (gpuFile.empty() ? "vision_encoder.onnx" : gpuFile);
  if (dir.empty() || gpuDir.empty() || !std::filesystem::exists(enc) || !std::filesystem::exists(gpu)) {
    SKIP("set PREMATION_SAM_TEST_DIR (the quantized pair) and PREMATION_SAM_GPU_TEST_DIR (vision_encoder.onnx)");
  }
  const std::vector<sam::Point> clicks{{400, 360, 1}, {930, 310, 1}};
  const Run cpu = run_with(enc.string(), dec.string(), "", clicks);
  const Run fl = run_with(enc.string(), dec.string(), gpu.string(), clicks);
  CHECK(cpu.provider == "cpu");
  WARN("SlimSAM encoder: quantized on " << cpu.provider << " " << cpu.encodeMs << " ms; float on " << fl.provider << " " << fl.encodeMs
                                        << " ms (" << kW << "x" << kH << ")");
  if (fl.provider == "cpu") SKIP("no GPU provider opened the float encoder on this machine");
  for (std::size_t i = 0; i < clicks.size(); ++i) {
    const double v = iou(cpu.masks[i], fl.masks[i]);
    INFO("subject " << i << " IoU " << v);
    CHECK(v > 0.9);
  }
}
