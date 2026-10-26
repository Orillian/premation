// The hand pipeline's arithmetic and the tracker (P1, src/live) — no camera,
// no ONNX: the tracker runs on fake models that answer like the real ones.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <vector>

#include "hand_pipeline.hpp"
#include "hand_tracker.hpp"

using namespace premation::live;
using Catch::Approx;

namespace {

constexpr double kPi = 3.14159265358979323846;

/// A BGRA frame, black, with an optional filled rectangle of one colour.
struct Frame {
  int w;
  int h;
  std::vector<std::uint8_t> px;
  Frame(int width, int height) : w(width), h(height), px(static_cast<std::size_t>(width) * static_cast<std::size_t>(height) * 4, 0) {}
  void fill(int x0, int y0, int x1, int y1, std::uint8_t r, std::uint8_t g, std::uint8_t b) {
    for (int y = y0; y < y1; ++y) {
      for (int x = x0; x < x1; ++x) {
        std::uint8_t* p = px.data() + (static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x)) * 4;
        p[0] = b;
        p[1] = g;
        p[2] = r;
        p[3] = 255;
      }
    }
  }
  [[nodiscard]] ImageView view() const { return {px.data(), w, h, w * 4}; }
};

/// The palm keypoints of an upright hand centred at (cx, cy) with palm size s, turned by `angle`.
Palm palm_at(double cx, double cy, double s, double angle) {
  // Upright: wrist below, finger bases in a row above, thumb to the side.
  // The middle base (index 2) straight above the wrist, so "upright" is exactly angle 0.
  const std::array<P2, 7> local{{{0, 0.5}, {-0.3, -0.3}, {0, -0.4}, {0.15, -0.35}, {0.35, -0.25}, {-0.4, 0.3}, {-0.5, 0.05}}};
  Palm p;
  P2 lo{1e9, 1e9};
  P2 hi{-1e9, -1e9};
  for (std::size_t i = 0; i < 7; ++i) {
    const double x = local[i].x * s;
    const double y = local[i].y * s;
    const P2 q{cx + std::cos(angle) * x - std::sin(angle) * y, cy + std::sin(angle) * x + std::cos(angle) * y};
    p.keypoints[i] = q;
    lo = {std::min(lo.x, q.x), std::min(lo.y, q.y)};
    hi = {std::max(hi.x, q.x), std::max(hi.y, q.y)};
  }
  p.boxMin = lo;
  p.boxMax = hi;
  p.score = 0.9;
  return p;
}

}  // namespace

TEST_CASE("palm anchors are the 192² SSD grid: strides 8 and 16, x fastest") {
  const auto& a = palm_anchors();
  REQUIRE(a.size() == 2016);
  CHECK(a[0].x == Approx(0.5 / 24));
  CHECK(a[1].x == Approx(0.5 / 24));
  CHECK(a[2].x == Approx(1.5 / 24));
  CHECK(a[48].y == Approx(1.5 / 24));
  CHECK(a[1152].x == Approx(0.5 / 12));
  CHECK(a[1152].y == Approx(0.5 / 12));
  CHECK(a[2015].x == Approx(11.5 / 12));
  CHECK(a[2015].y == Approx(11.5 / 12));
}

TEST_CASE("the palm input letterboxes the frame and maps back exactly") {
  Frame f(640, 480);
  f.fill(0, 0, 640, 480, 255, 0, 0);
  const Letterbox lb = palm_input(f.view(), false);
  CHECK(lb.ratio == Approx(0.3));
  CHECK(lb.padX == Approx(0));
  CHECK(lb.padY == Approx(24));
  // Inside the content: red; in the bars: black.
  const auto at = [&](int u, int v, int c) { return lb.input[(static_cast<std::size_t>(v) * 192 + static_cast<std::size_t>(u)) * 3 + static_cast<std::size_t>(c)]; };
  CHECK(at(96, 96, 0) == Approx(1.0f));
  CHECK(at(96, 96, 1) == Approx(0.0f));
  CHECK(at(96, 5, 0) == Approx(0.0f));
}

TEST_CASE("decode_palms turns an anchor's box and keypoints into frame px, best first, suppressed") {
  Frame f(640, 480);
  const Letterbox lb = palm_input(f.view(), false);
  std::vector<float> reg(kAnchors * 18, 0.0f);
  std::vector<float> sc(kAnchors, -10.0f);
  // Anchor 1152 sits at (8, 8) input px. A 40 × 40 box centred 2 px right of it.
  const std::size_t i = 1152;
  reg[i * 18 + 0] = 2;
  reg[i * 18 + 1] = 0;
  reg[i * 18 + 2] = 40;
  reg[i * 18 + 3] = 40;
  reg[i * 18 + 4] = 1;  // wrist keypoint offset
  reg[i * 18 + 5] = 3;
  sc[i] = 4;
  // A near-duplicate on the neighbouring anchor, weaker: NMS removes it.
  reg[(i + 1) * 18 + 2] = 40;
  reg[(i + 1) * 18 + 3] = 40;
  sc[i + 1] = 2;
  const std::vector<Palm> palms = decode_palms(reg, sc, lb);
  REQUIRE(palms.size() == 1);
  const Palm& p = palms[0];
  CHECK(p.score == Approx(1.0 / (1.0 + std::exp(-4.0))));
  // centre (10, 8) input px → frame ((10 − 0) / 0.3, (8 − 24) / 0.3).
  CHECK((p.boxMin.x + p.boxMax.x) / 2 == Approx(10 / 0.3));
  CHECK((p.boxMin.y + p.boxMax.y) / 2 == Approx((8 - 24) / 0.3));
  CHECK(p.boxMax.x - p.boxMin.x == Approx(40 / 0.3));
  CHECK(p.keypoints[0].x == Approx(9 / 0.3));
  CHECK(p.keypoints[0].y == Approx((11 - 24) / 0.3));
}

TEST_CASE("the landmark crop turns with the hand: upright = 0, pointing right = +90°") {
  const Roi up = roi_from_palm(palm_at(300, 200, 100, 0));
  CHECK(up.angle == Approx(0).margin(1e-9));
  // Shifted toward the fingers (up = −y) and grown: about 3× the keypoints' extent.
  CHECK(up.centre.y < 200);
  CHECK(up.side == Approx(3 * 90).margin(1.0));
  const Roi right = roi_from_palm(palm_at(300, 200, 100, kPi / 2));
  CHECK(right.angle == Approx(kPi / 2));
  CHECK(right.centre.x > 300);  // toward the fingers, now to the right
  CHECK(right.side == Approx(up.side));
}

TEST_CASE("crop px and frame px round-trip through the turned square") {
  Roi r;
  r.centre = {320, 240};
  r.side = 224;
  r.angle = kPi / 2;
  const P2 c = hand_crop_to_frame(r, {112, 112});
  CHECK(c.x == Approx(320));
  CHECK(c.y == Approx(240));
  // The crop's top-centre is the hand's "up", which for +90° is the frame's right.
  const P2 top = hand_crop_to_frame(r, {112, 0});
  CHECK(top.x == Approx(320 + 112));
  CHECK(top.y == Approx(240));
}

TEST_CASE("the landmarker crop samples the turned square (black outside the frame)") {
  Frame f(640, 480);
  f.fill(400, 220, 440, 260, 0, 255, 0);  // a green block right of centre
  Roi r;
  r.centre = {320, 240};
  r.side = 224;
  r.angle = kPi / 2;  // the crop's up looks right: the block lands at the crop's top
  const std::vector<float> in = hand_input(f.view(), r, false);
  const auto g = [&](int u, int v) { return in[(static_cast<std::size_t>(v) * 224 + static_cast<std::size_t>(u)) * 3 + 1]; };
  CHECK(g(112, 112 - 100) == Approx(1.0f));
  CHECK(g(112, 112 + 100) == Approx(0.0f));
  // A crop hanging off the frame's edge is black there, not clamped.
  Roi edge;
  edge.centre = {0, 0};
  edge.side = 224;
  const std::vector<float> e = hand_input(f.view(), edge, false);
  CHECK(e[0] == 0.0f);
}

TEST_CASE("decode_hand maps the 21 crop landmarks into the frame and scales depth") {
  Roi r;
  r.centre = {100, 100};
  r.side = 448;  // 2 frame px per crop px
  std::vector<float> screen(63, 0.0f);
  screen[0] = 112;
  screen[1] = 112;
  screen[2] = 0;
  screen[8 * 3] = 112 + 10;
  screen[8 * 3 + 1] = 112 - 20;
  screen[8 * 3 + 2] = -5;
  const Hand h = decode_hand(screen, {}, 0.9, 0.2, r);
  CHECK(h.landmarks[0].x == Approx(100));
  CHECK(h.landmarks[8].x == Approx(120));
  CHECK(h.landmarks[8].y == Approx(60));
  CHECK(h.depth[8] == Approx(-10));
  CHECK(h.presence == Approx(0.9));
}

TEST_CASE("pinch is scale-free: thumb–index distance over palm size") {
  Hand h;
  h.landmarks[0] = {0, 100};   // wrist
  h.landmarks[9] = {0, 0};     // middle base: palm size 100
  h.landmarks[4] = {10, -50};  // thumb tip
  h.landmarks[8] = {20, -50};  // index tip
  CHECK(pinch_ratio(h) == Approx(0.1));
}

TEST_CASE("the landmarker's outputs are told apart by name, then by order") {
  std::vector<TensorOut> outs(4);
  outs[0] = {"Identity", {1, 63}, std::vector<float>(63)};
  outs[1] = {"Identity_1", {1, 1}, {0.9f}};
  outs[2] = {"Identity_2", {1, 1}, {0.2f}};
  outs[3] = {"Identity_3", {1, 63}, std::vector<float>(63)};
  HandOutputs o = identify_hand_outputs(outs);
  CHECK(o.screen == 0);
  CHECK(o.presence == 1);
  CHECK(o.handedness == 2);
  CHECK(o.world == 3);
  outs[0].name = "world_landmarks";
  outs[3].name = "landmarks";
  outs[1].name = "handedness";
  outs[2].name = "score";
  o = identify_hand_outputs(outs);
  CHECK(o.world == 0);
  CHECK(o.screen == 3);
  CHECK(o.handedness == 1);
  CHECK(o.presence == 2);
}

namespace {

/// Answers like the palm detector: one palm on anchor 1500, or none.
class FakePalm final : public Model {
 public:
  bool present = true;
  int runs = 0;
  [[nodiscard]] bool planar() const noexcept override { return false; }
  [[nodiscard]] int input_side() const noexcept override { return 192; }
  [[nodiscard]] std::string provider() const override { return "fake"; }
  [[nodiscard]] std::string describe() const override { return {}; }
  bool run(std::span<const float> /*input*/, std::vector<TensorOut>& out, std::string& /*error*/) override {
    ++runs;
    out.assign(2, {});
    out[0].data.assign(kAnchors * 18, 0.0f);
    out[1].data.assign(kAnchors, -10.0f);
    if (present) {
      const std::size_t i = 1500;
      float* r = out[0].data.data() + i * 18;
      r[2] = 30;
      r[3] = 30;
      // Wrist below the anchor, middle base above it: an upright palm.
      r[4] = 0;
      r[5] = 10;
      r[8] = 0;
      r[9] = -10;
      out[1].data[i] = 3;
    }
    return true;
  }
};

/// Answers like the landmarker: a hand filling the crop's middle, presence settable.
class FakeHand final : public Model {
 public:
  float presence = 0.95f;
  int runs = 0;
  [[nodiscard]] bool planar() const noexcept override { return false; }
  [[nodiscard]] int input_side() const noexcept override { return 224; }
  [[nodiscard]] std::string provider() const override { return "fake"; }
  [[nodiscard]] std::string describe() const override { return {}; }
  bool run(std::span<const float> /*input*/, std::vector<TensorOut>& out, std::string& /*error*/) override {
    ++runs;
    out.assign(4, {});
    out[0].name = "Identity";
    out[0].data.assign(63, 0.0f);
    for (std::size_t k = 0; k < 21; ++k) {
      out[0].data[k * 3] = 112.0f + static_cast<float>(k % 5) * 8.0f - 16.0f;
      out[0].data[k * 3 + 1] = 150.0f - static_cast<float>(k) * 4.0f;
    }
    out[1] = {"Identity_1", {1, 1}, {presence}};
    out[2] = {"Identity_2", {1, 1}, {0.7f}};
    out[3] = {"Identity_3", {1, 63}, std::vector<float>(63, 0.0f)};
    return true;
  }
};

}  // namespace

TEST_CASE("the tracker detects once, then follows without the detector until the hand is lost") {
  Frame f(640, 480);
  FakePalm palm;
  FakeHand hand;
  TrackerOptions o;
  o.maxHands = 1;
  HandTracker tr(palm, hand, o);

  TrackerResult r = tr.process(f.view());
  CHECK(r.timings.ranPalm);
  REQUIRE(r.hands.size() == 1);
  CHECK(r.hands[0].handedness == Approx(0.7));

  r = tr.process(f.view());
  CHECK_FALSE(r.timings.ranPalm);  // followed from the landmarks
  CHECK(r.hands.size() == 1);
  CHECK(palm.runs == 1);

  hand.presence = 0.1f;  // gone
  r = tr.process(f.view());
  CHECK(r.hands.empty());
  hand.presence = 0.95f;
  r = tr.process(f.view());
  CHECK(r.timings.ranPalm);  // lost → the detector looks again
  CHECK(r.hands.size() == 1);
}

TEST_CASE("no palm, no landmark runs") {
  Frame f(640, 480);
  FakePalm palm;
  palm.present = false;
  FakeHand hand;
  HandTracker tr(palm, hand);
  const TrackerResult r = tr.process(f.view());
  CHECK(r.hands.empty());
  CHECK(hand.runs == 0);
}
