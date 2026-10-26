// Performance takes (docs/PERFORMANCE_ANIMATION_PLAN.md §4.1, D5): a recorded
// take stored on its layer — set / query / clear with inverses, the sample
// cap, save / reopen, and the take going with its layer.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cstddef>
#include <string>
#include <variant>
#include <vector>

#include "session_harness.hpp"

using namespace premation;
using namespace premation::test;
using Catch::Approx;

namespace {

constexpr api::Time kSec = 705'600'000;

api::ItemId make_comp(Harness& h) {
  api::CreateComposition c;
  c.settings.name = "Test";
  c.settings.width = 1920;
  c.settings.height = 1080;
  c.settings.frame_rate = api::Rational{30, 1};
  c.settings.duration = 10 * kSec;
  const auto r = h.run(cmd(c));
  REQUIRE(is_ok(r));
  return result_item(r);
}

api::LayerId make_layer(Harness& h, const api::ItemId& comp) {
  api::CreateLayer c;
  c.comp = comp;
  c.kind = api::LayerKind::solid;
  const auto r = h.run(cmd(c));
  REQUIRE(is_ok(r));
  return result_layer(r);
}

template <class T>
T query(Harness& h, api::Query q) {
  const auto r = h.ask(std::move(q));
  REQUIRE(is_ok(r));
  return result_as<T>(std::get<api::QueryResult>(r.outcome.v));
}

api::HistoryState history(Harness& h) { return query<api::HistoryState>(h, qry(api::GetHistory{})); }

api::PerformanceTakes takes_of(Harness& h, const api::LayerId& layer) {
  return query<api::PerformanceTakes>(h, qry(api::GetPerformanceTakes{layer}));
}

/// A take of `n` samples on `path`: x = 100·t, y = 7, at 60 Hz from 1 s.
api::PerformanceTake sample_take(const api::LayerId& layer, const std::string& path, std::size_t n) {
  api::PerformanceTake t;
  t.layer = layer;
  t.path = path;
  t.source = "mouse";
  t.dims = 2;
  for (std::size_t i = 0; i < n; ++i) {
    const double s = 1.0 + static_cast<double>(i) / 60.0;
    t.times.push_back(s);
    t.values.push_back(100.0 * s);
    t.values.push_back(7.0);
  }
  t.fit = api::PerformanceFit{"smart", 50, 100, true, 0.25, 1.0 / 30.0, true};
  t.span = api::TimeRange{kSec, 2 * kSec};
  return t;
}

}  // namespace

TEST_CASE("a performance take is stored on its layer, answered in comp time, undone and redone", "[performance][session]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  CHECK(takes_of(h, layer).takes.empty());

  const std::size_t entries = history(h).entries.size();
  const api::PerformanceTake t = sample_take(layer, "transform/position", 121);
  REQUIRE(is_ok(h.run(cmd(api::SetPerformanceTake{t}))));
  const auto hist = history(h);
  REQUIRE(hist.entries.size() == entries + 1);
  CHECK(hist.entries.back().label == "Store Take");

  auto got = takes_of(h, layer);
  REQUIRE(got.takes.size() == 1);
  const api::PerformanceTake& g = got.takes.front();
  CHECK(g.layer == layer);
  CHECK(g.path == "transform/position");
  CHECK(g.source == "mouse");
  CHECK(g.dims == 2);
  REQUIRE(g.times.size() == 121);
  REQUIRE(g.values.size() == 242);
  CHECK(g.times.front() == Approx(1.0));
  CHECK(g.times.back() == Approx(3.0));
  CHECK(g.values[2] == Approx(100.0 * (1.0 + 1.0 / 60.0)));
  CHECK(g.values[3] == Approx(7.0));
  CHECK(g.fit.reduction == "smart");
  CHECK(g.fit.detail == Approx(50));
  CHECK(g.fit.spatial);
  CHECK(g.fit.whole_frames);
  CHECK(g.span.start == kSec);
  CHECK(g.span.duration == 2 * kSec);

  // Replacing the take for the same path keeps one record; another path adds one.
  api::PerformanceTake t2 = sample_take(layer, "transform/position", 5);
  t2.source = "hand";
  REQUIRE(is_ok(h.run(cmd(api::SetPerformanceTake{t2}))));
  REQUIRE(is_ok(h.run(cmd(api::SetPerformanceTake{sample_take(layer, "transform/rotation", 3)}))));
  got = takes_of(h, layer);
  REQUIRE(got.takes.size() == 2);
  CHECK(got.takes[0].source == "hand");
  CHECK(got.takes[0].times.size() == 5);

  // Undo the last two: the first take is back as it was.
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  got = takes_of(h, layer);
  REQUIRE(got.takes.size() == 1);
  CHECK(got.takes.front().times.size() == 121);
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  CHECK(takes_of(h, layer).takes.empty());
  REQUIRE(is_ok(h.run(cmd(api::Redo{}))));
  REQUIRE(is_ok(h.run(cmd(api::Redo{}))));
  REQUIRE(is_ok(h.run(cmd(api::Redo{}))));
  got = takes_of(h, layer);
  REQUIRE(got.takes.size() == 2);
  CHECK(got.takes[0].source == "hand");
}

TEST_CASE("clearPerformanceTakes removes named takes or every take, with an inverse", "[performance][session]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  REQUIRE(is_ok(h.run(cmd(api::SetPerformanceTake{sample_take(layer, "transform/position", 4)}))));
  REQUIRE(is_ok(h.run(cmd(api::SetPerformanceTake{sample_take(layer, "transform/rotation", 4)}))));
  REQUIRE(is_ok(h.run(cmd(api::SetPerformanceTake{sample_take(layer, "transform/opacity", 4)}))));

  REQUIRE(is_ok(h.run(cmd(api::ClearPerformanceTakes{layer, {"transform/rotation"}}))));
  auto got = takes_of(h, layer);
  REQUIRE(got.takes.size() == 2);
  CHECK(got.takes[0].path == "transform/position");
  CHECK(got.takes[1].path == "transform/opacity");
  CHECK(history(h).entries.back().label == "Discard Takes");

  REQUIRE(is_ok(h.run(cmd(api::ClearPerformanceTakes{layer, {}}))));
  CHECK(takes_of(h, layer).takes.empty());
  // Clearing a layer with no takes is a no-op that still succeeds (and adds no entry).
  const std::size_t entries = history(h).entries.size();
  REQUIRE(is_ok(h.run(cmd(api::ClearPerformanceTakes{layer, {}}))));
  CHECK(history(h).entries.size() == entries);

  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  CHECK(takes_of(h, layer).takes.size() == 2);
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  CHECK(takes_of(h, layer).takes.size() == 3);
}

TEST_CASE("a performance take is validated: the sample cap, the values count, the dimensions, the layer", "[performance][session]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);

  CHECK(is_error(h.run(cmd(api::SetPerformanceTake{sample_take(layer, "transform/position", 36'001)})), api::ErrorCode::out_of_range));
  CHECK(is_ok(h.run(cmd(api::SetPerformanceTake{sample_take(layer, "transform/position", 36'000)}))));

  api::PerformanceTake bad = sample_take(layer, "transform/position", 3);
  bad.values.pop_back();
  CHECK(is_error(h.run(cmd(api::SetPerformanceTake{bad})), api::ErrorCode::invalid_argument));

  bad = sample_take(layer, "transform/position", 3);
  bad.dims = 0;
  CHECK(is_error(h.run(cmd(api::SetPerformanceTake{bad})), api::ErrorCode::invalid_argument));

  bad = sample_take(layer, "", 3);
  CHECK(is_error(h.run(cmd(api::SetPerformanceTake{bad})), api::ErrorCode::invalid_argument));

  bad = sample_take(layer, "transform/position", 0);
  CHECK(is_error(h.run(cmd(api::SetPerformanceTake{bad})), api::ErrorCode::invalid_argument));

  CHECK(is_error(h.run(cmd(api::SetPerformanceTake{sample_take("nope", "transform/position", 3)})), api::ErrorCode::not_found));
  CHECK(is_error(h.run(cmd(api::SetPerformanceTake{sample_take(comp, "transform/position", 3)})), api::ErrorCode::not_found));
  CHECK(is_error(h.ask(qry(api::GetPerformanceTakes{"nope"})), api::ErrorCode::not_found));
}

TEST_CASE("a performance take survives save and reopen, and rides the layer's own time axis", "[performance][session]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  REQUIRE(is_ok(h.run(cmd(api::SetPerformanceTake{sample_take(layer, "transform/position", 61)}))));

  // Moving the layer later in the comp moves the take with it (stored on the layer's axis).
  api::MoveLayersInTime mv;
  mv.layers = {layer};
  mv.delta = 2 * kSec;
  REQUIRE(is_ok(h.run(cmd(mv))));
  auto got = takes_of(h, layer);
  REQUIRE(got.takes.size() == 1);
  CHECK(got.takes.front().times.front() == Approx(3.0));
  CHECK(got.takes.front().span.start == 3 * kSec);
  CHECK(got.takes.front().span.duration == 2 * kSec);

  api::SaveProject save;
  save.path = "C:/out/takes.motion";
  REQUIRE(is_ok(h.run(cmd(save))));
  REQUIRE(is_ok(h.run(cmd(api::NewProject{}))));
  CHECK(is_error(h.ask(qry(api::GetPerformanceTakes{layer})), api::ErrorCode::not_found));
  REQUIRE(is_ok(h.run(cmd(api::OpenProject{"C:/out/takes.motion"}))));
  got = takes_of(h, layer);
  REQUIRE(got.takes.size() == 1);
  const api::PerformanceTake& g = got.takes.front();
  CHECK(g.times.size() == 61);
  CHECK(g.values.size() == 122);
  CHECK(g.times.front() == Approx(3.0));
  CHECK(g.times.back() == Approx(4.0));
  CHECK(g.values[0] == Approx(100.0));
  CHECK(g.fit.reduction == "smart");
  CHECK(g.fit.frame_duration == Approx(1.0 / 30.0));
  CHECK(g.span.start == 3 * kSec);
}

TEST_CASE("deleting the layer deletes its takes; undo brings them back", "[performance][session]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  REQUIRE(is_ok(h.run(cmd(api::SetPerformanceTake{sample_take(layer, "transform/position", 10)}))));
  api::DeleteLayers del;
  del.layers = {layer};
  REQUIRE(is_ok(h.run(cmd(del))));
  CHECK(is_error(h.ask(qry(api::GetPerformanceTakes{layer})), api::ErrorCode::not_found));
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  const auto got = takes_of(h, layer);
  REQUIRE(got.takes.size() == 1);
  CHECK(got.takes.front().times.size() == 10);
}
