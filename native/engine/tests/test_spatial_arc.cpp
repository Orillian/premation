// Spatial properties move at constant speed in ARC LENGTH (After Effects): a
// position segment with spatial tangents is traversed by the fraction of its
// path covered, the temporal ease remapping that fraction — not the bezier
// parameter. doc::anim_sample_member_keys over the session's evaluated values.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <utility>
#include <vector>

#include "session_harness.hpp"

using namespace premation;
using namespace premation::test;
using Catch::Approx;

namespace {

constexpr api::Time kSec = 705'600'000;

api::ItemId make_comp(Harness& h) {
  api::CreateComposition c;
  c.settings.name = "Arc";
  c.settings.width = 1920;
  c.settings.height = 1080;
  c.settings.frame_rate = api::Rational{24, 1};  // query times snap to frames: 0.25 s and 0.5 s are whole frames here
  c.settings.duration = 10 * kSec;
  const auto r = h.run(cmd(c));
  REQUIRE(is_ok(r));
  return result_item(r);
}

api::LayerId make_layer(Harness& h, const api::ItemId& comp) {
  api::CreateLayer c;
  c.comp = comp;
  c.kind = api::LayerKind::shape;
  const auto r = h.run(cmd(c));
  REQUIRE(is_ok(r));
  return result_layer(r);
}

api::Vec2 position_at(Harness& h, const api::LayerId& layer, api::Time t) {
  api::GetPropertyValues q;
  q.props = {api::PropRef{layer, "transform/position"}};
  q.time = t;
  q.evaluated = true;
  const auto r = h.ask(qry(q));
  REQUIRE(is_ok(r));
  const auto values = result_as<api::PropertyValues>(std::get<api::QueryResult>(r.outcome.v));
  REQUIRE(values.values.size() == 1);
  return std::get<api::Vec2>(values.values.at(0).value.v);
}

struct Kf {
  api::Time t;
  double x, y;
  std::vector<double> so;
  std::vector<double> si;
};

void add_position_keys(Harness& h, const api::LayerId& layer, const std::vector<Kf>& kfs) {
  api::AddKeyframes a;
  for (const Kf& f : kfs) {
    api::KeyframeInsert k;
    k.prop = {layer, "transform/position"};
    k.time = f.t;
    k.value = vec2(f.x, f.y);
    k.spatial_out = f.so;
    k.spatial_in = f.si;
    a.keys.push_back(std::move(k));
  }
  REQUIRE(is_ok(h.run(cmd(a))));
}

/// The point at `fraction` of the ARC LENGTH of the cubic (p0, c1, c2, p3), by a fine chord sum.
std::pair<double, double> arc_point(const double (&x)[4], const double (&y)[4], double fraction) {
  const auto cubic = [](const double (&c)[4], double u) {
    const double m = 1 - u;
    return m * m * m * c[0] + 3 * m * m * u * c[1] + 3 * m * u * u * c[2] + u * u * u * c[3];
  };
  constexpr int kN = 1 << 16;
  std::vector<double> cum(kN + 1, 0.0);
  double px = cubic(x, 0), py = cubic(y, 0);
  for (int i = 1; i <= kN; ++i) {
    const double u = static_cast<double>(i) / kN;
    const double vx = cubic(x, u), vy = cubic(y, u);
    cum[static_cast<std::size_t>(i)] = cum[static_cast<std::size_t>(i - 1)] + std::hypot(vx - px, vy - py);
    px = vx;
    py = vy;
  }
  const double target = cum[static_cast<std::size_t>(kN)] * fraction;
  std::size_t lo = 0;
  for (std::size_t i = 0; i < static_cast<std::size_t>(kN); ++i) {
    if (cum[i] <= target) lo = i;
  }
  const double u = (static_cast<double>(lo) + (target - cum[lo]) / (cum[lo + 1] - cum[lo])) / kN;
  return {cubic(x, u), cubic(y, u)};
}

}  // namespace

TEST_CASE("spatial arc length: a curved position segment is at half its ARC at t = 0.5, not at bezier u = 0.5",
          "[anim][spatial][arc]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  // (0, 0) → (100, 0): the out tangent dives +100 in y, the in tangent is folded
  // onto the end key. Controls x: 0, 0, 100, 100; y: 0, 100, 0, 0 — a lopsided
  // arc whose first half is mostly the dive.
  add_position_keys(h, layer, {{0, 0, 0, {0, 100}, {}}, {kSec, 100, 0, {}, {0, 0}}});
  const auto mid = position_at(h, layer, kSec / 2);
  const auto want = arc_point({0, 0, 100, 100}, {0, 100, 0, 0}, 0.5);
  // Bezier u = 0.5 is (50, 37.5); half the arc is (40.64, 41.54).
  CHECK(mid.x == Approx(want.first).margin(0.05));
  CHECK(mid.y == Approx(want.second).margin(0.05));
  CHECK(std::abs(mid.x - 50) > 5);
  // Endpoints and the quarter points stay on the same curve.
  const auto q = position_at(h, layer, kSec / 4);
  const auto wq = arc_point({0, 0, 100, 100}, {0, 100, 0, 0}, 0.25);
  CHECK(q.x == Approx(wq.first).margin(0.05));
  CHECK(q.y == Approx(wq.second).margin(0.05));
  CHECK(position_at(h, layer, 0).x == Approx(0));
  CHECK(position_at(h, layer, kSec).x == Approx(100));
}

TEST_CASE("spatial arc length: the eased fraction is a fraction of the ARC", "[anim][spatial][arc]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  add_position_keys(h, layer, {{0, 0, 0, {0, 100}, {}}, {kSec, 100, 0, {}, {0, 0}}});
  // easeIn: eased(0.5) = 0.25 → the point a quarter of the way along the arc.
  api::GetKeyframes gk;
  gk.props = {api::PropRef{layer, "transform/position"}};
  const auto r = h.ask(qry(gk));
  REQUIRE(is_ok(r));
  const auto sets = result_as<api::KeyframeSets>(std::get<api::QueryResult>(r.outcome.v));
  REQUIRE(sets.sets.size() == 1);
  REQUIRE(sets.sets[0].keyframes.size() == 2);
  api::UpdateKeyframes p;
  api::KeyframePatch kp;
  kp.id = sets.sets[0].keyframes[0].id;
  kp.easing = api::Easing::ease_in;
  p.patches.push_back(kp);
  REQUIRE(is_ok(h.run(cmd(p))));
  const auto mid = position_at(h, layer, kSec / 2);
  const auto want = arc_point({0, 0, 100, 100}, {0, 100, 0, 0}, 0.25);
  CHECK(mid.x == Approx(want.first).margin(0.05));
  CHECK(mid.y == Approx(want.second).margin(0.05));
}

TEST_CASE("spatial arc length: a straight path with a zero / folded handle is traversed exactly", "[anim][spatial][arc]") {
  // The graph-editor parity case: key A stored as `bezier` with a ZERO out
  // tangent and no in tangent, key B a `linear` corner; x constant, y 0 → 50.
  // The path is a straight line whatever the handle does to its
  // parametrisation, so the midpoint is exactly 25 (the TS twin
  // sampleSpatialMember answers the same; interpolating u linearly inside a
  // chord gave 24.9996).
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  api::SetMemberKeyframes set;
  set.layer = layer;
  set.tracks.push_back({"x", R"([{"t":0,"value":100,"spatialInterp":"bezier","so":0},{"t":1,"value":100,"spatialInterp":"linear"}])"});
  set.tracks.push_back({"y", R"([{"t":0,"value":0,"spatialInterp":"bezier","so":0},{"t":1,"value":50,"spatialInterp":"linear"}])"});
  REQUIRE(is_ok(h.run(cmd(set))));
  const auto mid = position_at(h, layer, kSec / 2);
  CHECK(mid.x == Approx(100).margin(1e-9));
  CHECK(mid.y == Approx(25).margin(1e-6));
  const auto q = position_at(h, layer, kSec / 4);
  CHECK(q.y == Approx(12.5).margin(1e-6));
  // No stored zero at all: the straight short-cut, the same number.
  set.tracks = {{"y", R"([{"t":0,"value":0,"spatialInterp":"bezier"},{"t":1,"value":50,"spatialInterp":"linear"}])"}};
  REQUIRE(is_ok(h.run(cmd(set))));
  CHECK(position_at(h, layer, kSec / 2).y == Approx(25).margin(1e-12));
}

TEST_CASE("spatial arc length: a straight segment and misaligned axes sample as before", "[anim][spatial][arc]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  // No tangents: the straight line, u is the arc fraction already.
  const auto straight = make_layer(h, comp);
  add_position_keys(h, straight, {{0, 0, 0, {}, {}}, {kSec, 100, 40, {}, {}}});
  const auto s = position_at(h, straight, kSec / 2);
  CHECK(s.x == Approx(50));
  CHECK(s.y == Approx(20));
  // y keyed on a different segment than x: no shared curve, each axis on its own
  // (x's 1D cubic at the eased parameter, as it always sampled).
  const auto split = make_layer(h, comp);
  api::SetMemberKeyframes set;
  set.layer = split;
  set.tracks.push_back({"x", R"([{"t":0,"value":0,"so":0},{"t":1,"value":100}])"});
  set.tracks.push_back({"y", R"([{"t":0,"value":0},{"t":0.5,"value":50},{"t":1,"value":0}])"});
  REQUIRE(is_ok(h.run(cmd(set))));
  const auto m = position_at(h, split, kSec / 4);
  // x: controls 0, 0, 66.67, 100 at u = 0.25 → 3·0.75·0.0625·66.67 + 0.015625·100 ≈ 10.94
  CHECK(m.x == Approx(3 * 0.75 * 0.0625 * (100 - 100.0 / 3) + 0.015625 * 100).margin(1e-6));
  CHECK(m.y == Approx(25));
}
