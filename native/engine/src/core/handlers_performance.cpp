// Performance takes — see handlers_performance.hpp.

#include "handlers_performance.hpp"

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "time_conv.hpp"

namespace premation::doc {

namespace {

constexpr std::uint32_t kMaxDims = 4;
constexpr const char* kSlot = "performanceTakes";

Json nums_json(const std::vector<double>& v) {
  Json a = Json::array();
  a.arr_mut().reserve(v.size());
  for (const double c : v) a.arr_mut().push_back(Json::number(c));
  return a;
}

std::vector<double> nums_of(const Json& a) {
  std::vector<double> out;
  if (!a.is_array()) return out;
  out.reserve(a.arr().size());
  for (const Json& v : a.arr()) out.push_back(v.is_number() ? v.num() : 0);
  return out;
}

double num_or(const Json& j, const char* key, double fallback) {
  const Json& v = j.at(key);
  return v.is_number() ? v.num() : fallback;
}

Json fit_json(const api::PerformanceFit& f) {
  Json j = Json::object();
  j.set("reduction", Json::string(f.reduction));
  j.set("detail", Json::number(f.detail));
  j.set("captureSpeedPct", Json::number(f.capture_speed_pct));
  j.set("wholeFrames", Json::boolean(f.whole_frames));
  j.set("holdSeconds", Json::number(f.hold_seconds));
  j.set("frameDuration", Json::number(f.frame_duration));
  j.set("spatial", Json::boolean(f.spatial));
  return j;
}

api::PerformanceFit fit_of(const Json& j) {
  api::PerformanceFit f;
  f.reduction = j.at("reduction").is_string() ? j.at("reduction").str() : std::string("smart");
  f.detail = num_or(j, "detail", 50);
  f.capture_speed_pct = num_or(j, "captureSpeedPct", 100);
  f.whole_frames = j.bool_at("wholeFrames").value_or(true);
  f.hold_seconds = num_or(j, "holdSeconds", 0.25);
  f.frame_duration = num_or(j, "frameDuration", 1.0 / 30.0);
  f.spatial = j.bool_at("spatial").value_or(false);
  return f;
}

void validate(const api::PerformanceTake& t) {
  if (t.path.empty()) fail(api::ErrorCode::invalid_argument, "a performance take needs a property path", {.layer = t.layer});
  if (t.dims < 1 || t.dims > kMaxDims) {
    fail(api::ErrorCode::invalid_argument, "a performance take has 1 to 4 dimensions, not " + std::to_string(t.dims), {.layer = t.layer, .path = t.path});
  }
  if (t.times.empty()) fail(api::ErrorCode::invalid_argument, "a performance take needs at least one sample", {.layer = t.layer, .path = t.path});
  if (t.times.size() > kMaxPerformanceTakeSamples) {
    fail(api::ErrorCode::out_of_range,
         "a performance take is limited to " + std::to_string(kMaxPerformanceTakeSamples) + " samples (10 minutes at 60 Hz); this one has " +
             std::to_string(t.times.size()),
         {.layer = t.layer, .path = t.path});
  }
  if (t.values.size() != t.times.size() * t.dims) {
    fail(api::ErrorCode::invalid_argument,
         "a performance take's values are dims × samples numbers: expected " + std::to_string(t.times.size() * t.dims) + ", got " +
             std::to_string(t.values.size()),
         {.layer = t.layer, .path = t.path});
  }
  for (const double v : t.times) {
    if (!std::isfinite(v)) fail(api::ErrorCode::invalid_argument, "a performance take's times must be finite", {.layer = t.layer, .path = t.path});
  }
  for (const double v : t.values) {
    if (!std::isfinite(v)) fail(api::ErrorCode::invalid_argument, "a performance take's values must be finite", {.layer = t.layer, .path = t.path});
  }
  const api::PerformanceFit& f = t.fit;
  if (!std::isfinite(f.detail) || !std::isfinite(f.capture_speed_pct) || !std::isfinite(f.hold_seconds) || !std::isfinite(f.frame_duration)) {
    fail(api::ErrorCode::invalid_argument, "a performance take's fit settings must be finite", {.layer = t.layer, .path = t.path});
  }
}

/// The record as stored: times on the layer's own axis.
Json take_json(const Document& d, const EditorView& view, const api::PerformanceTake& t) {
  Json j = Json::object();
  j.set("source", Json::string(t.source));
  j.set("dims", Json::number(static_cast<double>(t.dims)));
  std::vector<double> times;
  times.reserve(t.times.size());
  for (const double s : t.times) times.push_back(comp_to_keyframe_time(d, view, t.layer, s));
  j.set("times", nums_json(times));
  j.set("values", nums_json(t.values));
  j.set("fit", fit_json(t.fit));
  Json span = Json::array();
  const double s0 = flicks_to_seconds(t.span.start);
  const double s1 = flicks_to_seconds(t.span.start + t.span.duration);
  span.arr_mut().push_back(Json::number(comp_to_keyframe_time(d, view, t.layer, s0)));
  span.arr_mut().push_back(Json::number(comp_to_keyframe_time(d, view, t.layer, s1)));
  j.set("span", std::move(span));
  return j;
}

/// The stored record back as the API's take (comp time), or nullopt when it does not parse.
std::optional<api::PerformanceTake> take_of(const Document& d, const EditorView& view, std::string_view layer, std::string_view path, const Json& j) {
  if (!j.is_object()) return std::nullopt;
  api::PerformanceTake t;
  t.layer = std::string(layer);
  t.path = std::string(path);
  t.source = j.at("source").is_string() ? j.at("source").str() : std::string();
  const double dims = num_or(j, "dims", 0);
  if (!(dims >= 1 && dims <= kMaxDims)) return std::nullopt;
  t.dims = static_cast<std::uint32_t>(dims);
  const std::vector<double> stored = nums_of(j.at("times"));
  t.times.reserve(stored.size());
  for (const double s : stored) t.times.push_back(keyframe_to_comp_time(d, view, layer, s));
  t.values = nums_of(j.at("values"));
  if (t.times.empty() || t.values.size() != t.times.size() * t.dims) return std::nullopt;
  t.fit = fit_of(j.at("fit"));
  const Json& span = j.at("span");
  const double a = span.is_array() && span.arr().size() == 2 && span.arr()[0].is_number() ? span.arr()[0].num() : stored.front();
  const double b = span.is_array() && span.arr().size() == 2 && span.arr()[1].is_number() ? span.arr()[1].num() : stored.back();
  const api::Time start = seconds_to_flicks(keyframe_to_comp_time(d, view, layer, a));
  const api::Time end = seconds_to_flicks(keyframe_to_comp_time(d, view, layer, b));
  t.span = api::TimeRange{.start = start, .duration = end > start ? end - start : 0};
  return t;
}

}  // namespace

ResultOf<api::SetPerformanceTake> handle(const api::SetPerformanceTake& c, HCtx& x) {
  Document& d = x.d;
  const api::PerformanceTake& t = c.take;
  (void)require_layer(d, t.layer);
  validate(t);
  x.label = "Store Take";
  const Json& cur = d.node(t.layer)->fx().at(kSlot);
  Json next = cur.is_object() ? cur : Json::object();
  next.set(t.path, take_json(d, x.view, t));
  sg_set_fx(d, t.layer, kSlot, std::move(next));
  return {};
}

ResultOf<api::ClearPerformanceTakes> handle(const api::ClearPerformanceTakes& c, HCtx& x) {
  Document& d = x.d;
  (void)require_layer(d, c.layer);
  x.label = "Discard Takes";
  const Json& cur = d.node(c.layer)->fx().at(kSlot);
  if (!cur.is_object()) return {};
  if (c.paths.empty()) {
    sg_set_fx(d, c.layer, kSlot, Json());
    return {};
  }
  Json next = cur;
  for (const std::string& p : c.paths) next.erase(p);
  sg_set_fx(d, c.layer, kSlot, next.obj().empty() ? Json() : std::move(next));
  return {};
}

api::PerformanceTakes performance_takes(const Document& d, const EditorView& view, std::string_view layer) {
  const Node& n = require_layer(d, layer);
  api::PerformanceTakes out;
  const Json& slot = n.fx().at(kSlot);
  if (!slot.is_object()) return out;
  for (const Json::Member& m : slot.obj()) {
    if (std::optional<api::PerformanceTake> t = take_of(d, view, layer, m.key, m.value)) out.takes.push_back(std::move(*t));
  }
  return out;
}

}  // namespace premation::doc
