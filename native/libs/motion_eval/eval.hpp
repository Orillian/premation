// motion_eval — internal C++ API. Not part of the ABI; include/motion is.
//
// A line-by-line port of packages/animation/src/interpolate.ts
// (cubicBezierEase, ease, cubicValueAt, autoSpatialTangents,
// effectiveSpatialTangents, sampleTrack). Each function names the TypeScript
// function it mirrors and keeps its arithmetic ORDER, because the contract is
// bit-identity with a JavaScript engine's IEEE-754 doubles: same operations,
// same associativity, no fused multiply-add (the library is compiled with
// -ffp-contract=off, see cmake/warnings.cmake).
//
// Everything here is noexcept, allocation-free and pure: the sampler reads
// keyframes through a `KeyframeSource` (a struct array or the packed
// Float64Array layout) and never copies the track.

#ifndef MOTION_EVAL_INTERNAL_EVAL_HPP
#define MOTION_EVAL_INTERNAL_EVAL_HPP

#include <concepts>
#include <cstddef>
#include <array>
#include <cstdint>
#include <span>
#include <string_view>

#include "motion/motion_eval.h"

namespace motion::eval {

using Keyframe = motion_keyframe;

/// MOTION_KEYFRAME_PACKED_DOUBLES as a size_t, so index arithmetic stays unsigned.
inline constexpr std::size_t kPackedDoubles = MOTION_KEYFRAME_PACKED_DOUBLES;

/// motion_easing values as the int32_t `Keyframe::easing` is compared with.
/// (An unscoped C enum with no negative enumerators may be unsigned underneath;
/// comparing it with an int32_t directly is a -Wsign-compare question that
/// should not exist.)
inline constexpr std::int32_t kEasingHold = MOTION_EASING_HOLD;
inline constexpr std::int32_t kEasingBezier = MOTION_EASING_BEZIER;
inline constexpr std::int32_t kEasingAutoBezier = MOTION_EASING_AUTO_BEZIER;
inline constexpr std::int32_t kEasingContinuousBezier = MOTION_EASING_CONTINUOUS_BEZIER;
inline constexpr std::int32_t kEasingStep = MOTION_EASING_STEP;
inline constexpr std::int32_t kEasingCount = MOTION_EASING_COUNT_;

/// Anything the sampler can read keyframes from. `get(i)` may return by value
/// (the packed layout decodes on the fly) or by const reference.
template <class S>
concept KeyframeSource = requires(const S& s, std::size_t i) {
  { s.size() } -> std::convertible_to<std::size_t>;
  { s.get(i) } -> std::convertible_to<Keyframe>;
};

/// A contiguous `motion_keyframe[]`.
struct StructSource {
  std::span<const Keyframe> kfs;

  [[nodiscard]] std::size_t size() const noexcept { return kfs.size(); }
  [[nodiscard]] const Keyframe& get(std::size_t i) const noexcept { return kfs[i]; }
};

/// The MOTION_KEYFRAME_PACKED_DOUBLES-per-keyframe Float64Array layout.
/// Precondition for `get`: `validate_packed` returned OK (the integer fields
/// are exact small integers, so the casts are lossless).
struct PackedSource {
  std::span<const double> data;
  std::size_t count = 0;

  [[nodiscard]] std::size_t size() const noexcept { return count; }
  [[nodiscard]] Keyframe get(std::size_t i) const noexcept;
};

// ── Easing curves (interpolate.ts lines 13–29, 32–52, 59–63) ───────────────

/// `cubicBezierEase([x1, y1, x2, y2], x)`: CSS cubic-bezier y for x, Newton on
/// x(s) = x for at most 8 steps, |dx| < 1e-5 or |x'(s)| < 1e-6 stops early.
/// The TypeScript has no bisection fallback, so neither does this.
[[nodiscard]] double cubic_bezier_ease(double x1, double y1, double x2, double y2,
                                       double x) noexcept;

/// `ease(kind, x)` — the named presets. `kind` must be a valid motion_easing.
[[nodiscard]] double ease(std::int32_t kind, double x) noexcept;

/// `cubicValueAt(v0, v1, v2, v3, u)` — 1D cubic bezier through value handles.
[[nodiscard]] double cubic_value_at(double v0, double v1, double v2, double v3,
                                    double u) noexcept;

// ── Validation ──────────────────────────────────────────────────────────────

/// Empty when the keyframe is well-formed, otherwise the reason (static text).
[[nodiscard]] std::string_view validate_keyframe(const Keyframe& k) noexcept;

/// Empty when the ten packed doubles decode to a well-formed keyframe.
[[nodiscard]] std::string_view validate_packed_keyframe(std::span<const double> ten) noexcept;

/// Whole-track check: count >= 1, every keyframe valid, times non-decreasing.
template <KeyframeSource S>
[[nodiscard]] std::string_view validate_track(const S& src) noexcept {
  const std::size_t n = src.size();
  if (n == 0) return "track has no keyframes";
  double prev_t = 0.0;
  for (std::size_t i = 0; i < n; ++i) {
    const Keyframe& k = src.get(i);
    const std::string_view why = validate_keyframe(k);
    if (!why.empty()) return why;
    if (i > 0 && k.t < prev_t) return "keyframes are not sorted by time";
    prev_t = k.t;
  }
  return {};
}

// ── Spatial tangents (interpolate.ts lines 159–189) ────────────────────────

struct Tangents {
  bool has_si = false;
  bool has_so = false;
  double si = 0.0;
  double so = 0.0;
};

[[nodiscard]] constexpr std::uint32_t spatial_mode(const Keyframe& k) noexcept {
  return (k.flags & MOTION_KF_SPATIAL_MASK) >> MOTION_KF_SPATIAL_SHIFT;
}

/// `autoSpatialTangents(kfs, i)`: Catmull-Rom chord through the neighbours,
/// each side scaled by its segment duration ÷ 3; ends get no open-side tangent.
template <KeyframeSource S>
[[nodiscard]] Tangents auto_spatial_tangents(const S& src, std::size_t i) noexcept {
  Tangents out;
  const std::size_t n = src.size();
  if (i >= n || n < 2) return out;
  const Keyframe& k = src.get(i);
  const Keyframe& prev = src.get(i > 0 ? i - 1 : 0);
  const Keyframe& next = src.get(i + 1 < n ? i + 1 : n - 1);
  const double dt = next.t - prev.t;
  const double m = dt > 0 ? (next.value - prev.value) / dt : 0.0;
  if (i < n - 1) {
    out.has_so = true;
    out.so = (m * (src.get(i + 1).t - k.t)) / 3.0;
  }
  if (i > 0) {
    out.has_si = true;
    out.si = (-m * (k.t - src.get(i - 1).t)) / 3.0;
  }
  return out;
}

/// `effectiveSpatialTangents(kfs, i)`: honours the per-keyframe spatial mode.
template <KeyframeSource S>
[[nodiscard]] Tangents effective_spatial_tangents(const S& src, std::size_t i) noexcept {
  Tangents out;
  if (i >= src.size()) return out;
  const Keyframe& k = src.get(i);
  const std::uint32_t mode = spatial_mode(k);
  if (mode == MOTION_SPATIAL_LINEAR) return out;
  if (mode == MOTION_SPATIAL_AUTO) return auto_spatial_tangents(src, i);
  if ((k.flags & MOTION_KF_HAS_SI) != 0u) {
    out.has_si = true;
    out.si = k.si;
  }
  if ((k.flags & MOTION_KF_HAS_SO) != 0u) {
    out.has_so = true;
    out.so = k.so;
  }
  return out;
}

// ── The sampler (interpolate.ts lines 80–151) ───────────────────────────────

/// `segmentIndexFor`: smallest i in [0, n-2] with t <= kfs[i+1].t. The
/// TypeScript's cursor cache is an accelerator that returns the same index
/// (see its comment), so only the binary search is ported. Precondition:
/// first.t < t < last.t.
template <KeyframeSource S>
[[nodiscard]] std::size_t segment_index_for(const S& src, double t) noexcept {
  std::size_t lo = 0;
  std::size_t hi = src.size() - 2;
  while (lo < hi) {
    const std::size_t mid = lo + (hi - lo) / 2;  // == (lo + hi) >> 1, overflow-free
    if (src.get(mid + 1).t >= t) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}

/// After Effects' Auto Bezier temporal tangent at key `i`: the chord slope
/// through its neighbours (one-sided at the ends), value units per second
/// (interpolate.ts autoTemporalSlope).
template <KeyframeSource S>
[[nodiscard]] double auto_temporal_slope(const S& src, std::size_t i) noexcept {
  const std::size_t n = src.size();
  if (i >= n || n < 2) return 0.0;
  const Keyframe& prev = src.get(i > 0 ? i - 1 : 0);
  const Keyframe& next = src.get(i + 1 < n ? i + 1 : n - 1);
  const double dt = next.t - prev.t;
  return dt > 0 ? (next.value - prev.value) / dt : 0.0;
}

[[nodiscard]] constexpr bool named_easing(std::int32_t kind) noexcept {
  return kind == MOTION_EASING_EASE || kind == MOTION_EASING_EASE_IN || kind == MOTION_EASING_EASE_OUT ||
         kind == MOTION_EASING_EASE_IN_OUT;
}

/// `segmentTemporalBezier(kfs, i)` (interpolate.ts): the cubic segment i → i+1
/// is sampled with when either end is Auto Bezier — that end's side is the
/// computed tangent (a handle at x = 1/3 or 2/3 with y = slope·dt/3 ÷ dv), the
/// other side the key's own handle or the straight line. Auto bezier was a
/// fixed ease-in-out here, which stopped the motion at every key; AE's is
/// smooth through it. A flat segment (dv = 0) cannot carry a tangent.
template <KeyframeSource S>
[[nodiscard]] std::array<double, 4> segment_temporal_bezier(const S& src, std::size_t i) noexcept {
  const Keyframe& a = src.get(i);
  const Keyframe& b = src.get(i + 1);
  const bool autoA = a.easing == kEasingAutoBezier;
  const bool autoB = b.easing == kEasingAutoBezier;
  // A roving key's sides are linear (interpolate.ts segmentTemporalBezier):
  // it was placed for constant speed through the run.
  const bool roveA = (a.flags & MOTION_KF_ROVING) != 0u;
  const bool roveB = (b.flags & MOTION_KF_ROVING) != 0u;
  const bool has_handles = (a.flags & MOTION_KF_HAS_BEZIER) != 0u;
  std::array<double, 4> bz{1.0 / 3.0, 1.0 / 3.0, 2.0 / 3.0, 2.0 / 3.0};
  if (has_handles) bz = {a.c0, a.c1, a.c2, a.c3};  // stored handles still carry the other end's side
  else if (!autoA && a.easing == kEasingContinuousBezier) bz = {0.333, 0.0, 0.667, 1.0};
  const double dv = b.value - a.value;
  const double dt = b.t - a.t;
  if (autoA) {
    bz[0] = 1.0 / 3.0;
    bz[1] = (dv != 0.0 && dt > 0.0) ? (auto_temporal_slope(src, i) * dt / 3.0) / dv : 1.0 / 3.0;
  }
  if (autoB) {
    bz[2] = 2.0 / 3.0;
    bz[3] = (dv != 0.0 && dt > 0.0) ? 1.0 - (auto_temporal_slope(src, i + 1) * dt / 3.0) / dv : 2.0 / 3.0;
  }
  if (roveA) {
    bz[0] = 1.0 / 3.0;
    bz[1] = 1.0 / 3.0;
  }
  if (roveB) {
    bz[2] = 2.0 / 3.0;
    bz[3] = 2.0 / 3.0;
  }
  return bz;
}

/// The segment `i → i+1`'s eased fraction at `local` (0..1 along its time
/// span): the temporal half of `sampleTrack` — the segment's bezier when an
/// end is Auto Bezier or roving, else the key's handles or its named ease.
template <KeyframeSource S>
[[nodiscard]] double segment_eased(const S& src, std::size_t i, double local) noexcept {
  const Keyframe& a = src.get(i);
  const Keyframe& b = src.get(i + 1);
  const std::int32_t kind = a.easing;
  const bool bezier_kind =
      kind == kEasingBezier || kind == kEasingAutoBezier || kind == kEasingContinuousBezier;
  const bool has_handles = (a.flags & MOTION_KF_HAS_BEZIER) != 0u;
  const bool roving = ((a.flags | b.flags) & MOTION_KF_ROVING) != 0u;
  const bool auto_end = kind == kEasingAutoBezier || b.easing == kEasingAutoBezier || roving;
  if (auto_end && (!named_easing(kind) || roving)) {
    const std::array<double, 4> sb = segment_temporal_bezier(src, i);
    return cubic_bezier_ease(sb[0], sb[1], sb[2], sb[3], local);
  }
  return (bezier_kind && has_handles) ? cubic_bezier_ease(a.c0, a.c1, a.c2, a.c3, local) : ease(kind, local);
}

/// The 1D cubic the segment `i → i+1` traces in its shared parameter: the key
/// values with the effective spatial tangents as control values (the linear
/// third-point for a missing side). `has_tangent` is false when neither side
/// carries one — the segment is then the straight line `v0 + (v3 − v0)·u`.
struct SegmentControls {
  double v0 = 0.0;
  double c1 = 0.0;
  double c2 = 0.0;
  double v3 = 0.0;
  bool has_tangent = false;
};

template <KeyframeSource S>
[[nodiscard]] SegmentControls segment_controls(const S& src, std::size_t i) noexcept {
  const Keyframe& a = src.get(i);
  const Keyframe& b = src.get(i + 1);
  SegmentControls out;
  out.v0 = a.value;
  out.v3 = b.value;
  // Spatial mode absent = the stored tangents as-is; otherwise resolve the mode.
  Tangents out_side;
  if (spatial_mode(a) == MOTION_SPATIAL_UNSET) {
    out_side.has_so = (a.flags & MOTION_KF_HAS_SO) != 0u;
    out_side.so = a.so;
  } else {
    out_side = effective_spatial_tangents(src, i);
  }
  Tangents in_side;
  if (spatial_mode(b) == MOTION_SPATIAL_UNSET) {
    in_side.has_si = (b.flags & MOTION_KF_HAS_SI) != 0u;
    in_side.si = b.si;
  } else {
    in_side = effective_spatial_tangents(src, i + 1);
  }
  const double third = (b.value - a.value) / 3.0;  // linear default for the missing side
  out.c1 = a.value + (out_side.has_so ? out_side.so : third);
  out.c2 = b.value + (in_side.has_si ? in_side.si : -third);
  out.has_tangent = out_side.has_so || in_side.has_si;
  return out;
}

/// `sampleTrack(track, t)`. Preconditions: `validate_track` passed and `t` is
/// not NaN (the C wrappers check both; this never fails).
template <KeyframeSource S>
[[nodiscard]] double sample(const S& src, double t) noexcept {
  const std::size_t n = src.size();
  const Keyframe& first = src.get(0);
  const Keyframe& last = src.get(n - 1);
  if (t <= first.t) return first.value;
  if (t >= last.t) return last.value;

  const std::size_t i = segment_index_for(src, t);
  const Keyframe& a = src.get(i);
  const Keyframe& b = src.get(i + 1);
  const std::int32_t kind = a.easing;

  // Hold/step hold the start value UP TO — but not AT — the next keyframe.
  if (kind == kEasingHold || kind == kEasingStep) {
    return t < b.t ? a.value : b.value;
  }
  const double seg_span = b.t - a.t;
  const double local = seg_span <= 0 ? 0.0 : (t - a.t) / seg_span;
  const double eased = segment_eased(src, i, local);
  const SegmentControls c = segment_controls(src, i);
  if (c.has_tangent) return cubic_value_at(c.v0, c.c1, c.c2, c.v3, eased);
  return a.value + (b.value - a.value) * eased;
}

// ── Spatial arc length (After Effects motion paths) ─────────────────────────
//
// A spatial property (position, anchor point, point of interest) keeps one
// scalar track per axis; the axes share the segment's eased parameter, so
// together they trace one cubic bezier. After Effects moves along that curve
// at constant speed in ARC LENGTH: the temporal ease remaps the fraction of
// the path covered, not the bezier parameter. These two functions give a
// segment's cumulative chord-length table and the parameter at a fraction of
// it; the sampler (premation::doc::anim_sample_member_keys) caches the table
// per segment. Pure functions of the control values — deterministic.

/// How many axes a spatial segment can carry (x, y, z).
inline constexpr std::size_t kSpatialAxes = 3;
/// Chord samples per segment: u = i / kArcSamples, i = 0..kArcSamples.
inline constexpr std::size_t kArcSamples = 64;

/// One keyframe segment of a spatial property: `axes` 1D cubics (v0, c1, c2,
/// v3 — `segment_controls`) in the shared parameter u. An axis without a
/// track is constant and may be left at zeros (it adds no length).
struct SpatialSegment {
  std::size_t axes = 0;
  std::array<std::array<double, 4>, kSpatialAxes> ctrl{};
};

/// `cum[i]`: the curve's chord length from u = 0 to u = i / kArcSamples.
struct ArcTable {
  std::array<double, kArcSamples + 1> cum{};
};

/// Fills `out` for `seg`.
void arc_table(const SpatialSegment& seg, ArcTable& out) noexcept;

/// The parameter u ∈ [0, 1] at which the curve has covered `fraction`
/// (clamped to 0..1) of its total length: the chord table picks the bin, a
/// bisection on the distance along `seg`'s own cubic places u inside it (so
/// a straight path answers exactly, whatever its parametrisation — a folded
/// or zero handle changes the parametrisation, not the line). A zero-length
/// curve (every axis constant) answers `fraction` itself.
[[nodiscard]] double arc_param(const SpatialSegment& seg, const ArcTable& table, double fraction) noexcept;

}  // namespace motion::eval

#endif  // MOTION_EVAL_INTERNAL_EVAL_HPP
