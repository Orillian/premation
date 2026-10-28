// Variable (per-vertex) mask feather — raster/mask_paint.cpp
// variable_feather_alpha, the pure core of maskFeather.ts: the ramp straddles
// the outline, its width follows the nearest outline sample, and pixels far
// from the edge keep their hard coverage.
#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <cstdlib>
#include <string>
#include <vector>

#include "mask_paint.hpp"

using premation::raster::FeatherSample;
using premation::raster::variable_feather_alpha;

namespace {

/// A 64×32 matte, hard-covered left of x = 32, with samples on that edge
/// whose feather is `top` at y = 0 and `bottom` at y = 32.
struct Edge {
  int w = 64;
  int h = 32;
  std::vector<std::uint8_t> coverage;
  std::vector<FeatherSample> samples;
  Edge(double top, double bottom) : coverage(static_cast<std::size_t>(64 * 32), 0) {
    for (int y = 0; y < h; ++y) {
      for (int x = 0; x < 32; ++x) coverage[static_cast<std::size_t>(y * w + x)] = 255;
    }
    for (int i = 0; i <= 64; ++i) {
      const double t = i / 64.0;
      samples.push_back({32, t * 32, top + (bottom - top) * t});
    }
  }
  [[nodiscard]] std::uint8_t at(const std::vector<std::uint8_t>& a, int x, int y) const {
    return a[static_cast<std::size_t>(y * w + x)];
  }
};

}  // namespace

TEST_CASE("variable feather: no feather keeps the hard coverage", "[raster][mask]") {
  const Edge e(0, 0);
  const auto out = variable_feather_alpha(e.coverage, e.w, e.h, e.samples, 0);
  CHECK(out == e.coverage);
}

TEST_CASE("variable feather: the ramp widens where the vertex feather grows", "[raster][mask]") {
  const Edge e(2, 20);
  const auto out = variable_feather_alpha(e.coverage, e.w, e.h, e.samples, 20);
  // Deep inside and far outside stay as they were.
  CHECK(e.at(out, 2, 16) == 255);
  CHECK(e.at(out, 62, 16) == 0);
  // Near the top (narrow feather) the edge is sharp: 4 px out is already clear.
  CHECK(e.at(out, 36, 1) == 0);
  // Near the bottom (wide feather) 4 px outside is still partly covered,
  // and 4 px inside is partly transparent.
  CHECK(e.at(out, 36, 30) > 20);
  CHECK(e.at(out, 27, 30) < 250);
  // The ramp is monotonic across the edge.
  for (int x = 20; x < 44; ++x) CHECK(e.at(out, x, 30) >= e.at(out, x + 1, 30));
}

TEST_CASE("feather falloff: Linear is a straight ramp, Smooth eases both ends", "[raster][mask]") {
  // A uniform 16 px feather across the edge at x = 32: u runs 0 → 1 over x ∈ [24, 40].
  const Edge e(16, 16);
  const auto smooth = variable_feather_alpha(e.coverage, e.w, e.h, e.samples, 16, premation::raster::FeatherRamp::smooth);
  const auto linear = variable_feather_alpha(e.coverage, e.w, e.h, e.samples, 16, premation::raster::FeatherRamp::linear);
  // The middle of the ramp is half covered either way.
  CHECK(std::abs(static_cast<int>(e.at(linear, 32, 16)) - 128) <= 20);
  CHECK(std::abs(static_cast<int>(e.at(smooth, 32, 16)) - 128) <= 20);
  // A quarter of the way in, the straight ramp holds more than the eased one,
  // and a quarter from the end less: Smooth lingers near 0 and 1.
  CHECK(e.at(linear, 36, 16) > e.at(smooth, 36, 16));
  CHECK(e.at(linear, 28, 16) < e.at(smooth, 28, 16));
  // Both stay monotonic and keep the hard coverage beyond the band.
  for (int x = 20; x < 44; ++x) CHECK(e.at(linear, x, 16) >= e.at(linear, x + 1, 16));
  CHECK(e.at(linear, 2, 16) == 255);
  CHECK(e.at(linear, 62, 16) == 0);
}

TEST_CASE("variable feather: deterministic", "[raster][mask]") {
  const Edge e(4, 12);
  CHECK(variable_feather_alpha(e.coverage, e.w, e.h, e.samples, 12) == variable_feather_alpha(e.coverage, e.w, e.h, e.samples, 12));
}

namespace {

/// A 64 x 32 canvas with the painter's centred origin, the matte painted from `json`.
std::vector<std::uint8_t> painted(const char* json, std::vector<std::string>& unsupported) {
  premation::raster::json::Value mask;
  std::string error;
  REQUIRE(premation::raster::json::parse(json, mask, error));
  const premation::raster::CanvasOptions opts;
  auto c = premation::raster::Canvas2D::make(64, 32, opts);
  REQUIRE(c != nullptr);
  c->translate(32, 16);
  premation::raster::paint_mask_matte(*c, mask, 64, 32, unsupported);
  return c->pixels();
}

std::uint8_t alpha(const std::vector<std::uint8_t>& px, int x, int y) { return px[static_cast<std::size_t>((y * 64 + x) * 4 + 3)]; }

}  // namespace

TEST_CASE("mask motion blur: the matte is the shutter's average outline", "[raster][mask]") {
  // The outline is a 16 px square at x in [-16, 0) on the first sample and
  // [0, 16) on the second: each half is covered half the shutter.
  const char* json = R"({"paths":[{"id":"m","mode":"add","closed":true,"feather":0,"opacity":1,"expansion":0,
    "points":[{"x":-16,"y":-8,"inX":-16,"inY":-8,"outX":-16,"outY":-8},{"x":0,"y":-8,"inX":0,"inY":-8,"outX":0,"outY":-8},
              {"x":0,"y":8,"inX":0,"inY":8,"outX":0,"outY":8},{"x":-16,"y":8,"inX":-16,"inY":8,"outX":-16,"outY":8}],
    "motionSamples":[
      [{"x":-16,"y":-8,"inX":-16,"inY":-8,"outX":-16,"outY":-8},{"x":0,"y":-8,"inX":0,"inY":-8,"outX":0,"outY":-8},
       {"x":0,"y":8,"inX":0,"inY":8,"outX":0,"outY":8},{"x":-16,"y":8,"inX":-16,"inY":8,"outX":-16,"outY":8}],
      [{"x":0,"y":-8,"inX":0,"inY":-8,"outX":0,"outY":-8},{"x":16,"y":-8,"inX":16,"inY":-8,"outX":16,"outY":-8},
       {"x":16,"y":8,"inX":16,"inY":8,"outX":16,"outY":8},{"x":0,"y":8,"inX":0,"inY":8,"outX":0,"outY":8}]]}]})";
  std::vector<std::string> unsupported;
  const auto px = painted(json, unsupported);
  CHECK(unsupported.empty());
  // Device x = local x + 32: both halves at about half coverage, outside clear.
  CHECK(std::abs(static_cast<int>(alpha(px, 24, 16)) - 128) <= 3);
  CHECK(std::abs(static_cast<int>(alpha(px, 40, 16)) - 128) <= 3);
  CHECK(alpha(px, 8, 16) == 0);
  CHECK(alpha(px, 56, 16) == 0);
  CHECK(alpha(px, 32, 2) == 0);
}

TEST_CASE("mask feather falloff: Linear reaches the canvas through the distance field", "[raster][mask]") {
  const auto square = [](const char* falloff) {
    std::string j = R"({"paths":[{"id":"m","mode":"add","closed":true,"feather":12,"opacity":1,"expansion":0,"featherFalloff":")";
    j += falloff;
    j += R"(","points":[{"x":-12,"y":-12,"inX":-12,"inY":-12,"outX":-12,"outY":-12},{"x":12,"y":-12,"inX":12,"inY":-12,"outX":12,"outY":-12},
      {"x":12,"y":12,"inX":12,"inY":12,"outX":12,"outY":12},{"x":-12,"y":12,"inX":-12,"inY":12,"outX":-12,"outY":12}]}]})";
    return j;
  };
  std::vector<std::string> unsupported;
  const auto linear = painted(square("linear").c_str(), unsupported);
  CHECK(unsupported.empty());
  // The edge at local x = 12 (device 44): half covered there, a straight ramp
  // across 12 px, hard coverage deep inside, nothing past the band.
  CHECK(std::abs(static_cast<int>(alpha(linear, 44, 16)) - 128) <= 24);
  CHECK(alpha(linear, 32, 16) == 255);
  CHECK(alpha(linear, 52, 16) == 0);
  for (int x = 38; x < 50; ++x) CHECK(alpha(linear, x, 16) >= alpha(linear, x + 1, 16));
}
