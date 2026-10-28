// Keyframe sampling reads a document track lazily (anim.cpp KeySource): one
// sample converts only the keys the sampler touches, never the whole track.
// The contract is bit-identity with the old path — convert every key to a
// motion_keyframe, then sample the array — which this test computes inline
// through the C ABI (the same motion::eval::sample over a StructSource).
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <vector>

#include "anim.hpp"
#include "motion/motion_eval.h"

using namespace premation;

namespace {

/// Deterministic 64-bit LCG (the test must not depend on the platform's RNG).
struct Lcg {
  std::uint64_t s = 0x9e3779b97f4a7c15ULL;
  std::uint32_t next() noexcept {
    s = s * 6364136223846793005ULL + 1442695040888963407ULL;
    return static_cast<std::uint32_t>(s >> 33U);
  }
  double unit() noexcept { return static_cast<double>(next()) / 4294967296.0; }  // [0, 1)
  std::size_t below(std::size_t n) noexcept { return static_cast<std::size_t>(next() % static_cast<std::uint32_t>(n)); }
};

/// The old conversion, written out: doc::Key → motion_keyframe.
std::int32_t motion_easing_of(api::Easing e) {
  switch (e) {
    case api::Easing::linear: return MOTION_EASING_LINEAR;
    case api::Easing::hold: return MOTION_EASING_HOLD;
    case api::Easing::bezier: return MOTION_EASING_BEZIER;
    case api::Easing::ease: return MOTION_EASING_EASE;
    case api::Easing::ease_in: return MOTION_EASING_EASE_IN;
    case api::Easing::ease_out: return MOTION_EASING_EASE_OUT;
    case api::Easing::ease_in_out: return MOTION_EASING_EASE_IN_OUT;
    case api::Easing::step: return MOTION_EASING_STEP;
    case api::Easing::auto_bezier: return MOTION_EASING_AUTO_BEZIER;
    case api::Easing::continuous_bezier: return MOTION_EASING_CONTINUOUS_BEZIER;
  }
  return MOTION_EASING_LINEAR;
}

motion_keyframe convert_whole(const doc::Key& k) {
  motion_keyframe m{};
  m.t = k.t;
  m.value = k.value;
  m.easing = motion_easing_of(k.easing.value_or(api::Easing::linear));
  m.flags = k.spatial ? ((static_cast<std::uint32_t>(*k.spatial) << MOTION_KF_SPATIAL_SHIFT) & MOTION_KF_SPATIAL_MASK) : 0U;
  if (k.roving.value_or(false)) m.flags |= MOTION_KF_ROVING;
  if (k.bezier) {
    m.flags |= MOTION_KF_HAS_BEZIER;
    m.c0 = (*k.bezier)[0];
    m.c1 = (*k.bezier)[1];
    m.c2 = (*k.bezier)[2];
    m.c3 = (*k.bezier)[3];
  }
  if (k.si) {
    m.flags |= MOTION_KF_HAS_SI;
    m.si = *k.si;
  }
  if (k.so) {
    m.flags |= MOTION_KF_HAS_SO;
    m.so = *k.so;
  }
  return m;
}

/// A long track that exercises every easing kind, stored handles, spatial
/// tangents and modes, roving keys — strictly increasing times.
std::vector<doc::Key> long_track(std::size_t n, Lcg& rng) {
  static constexpr std::array<api::Easing, 10> kEasings{
      api::Easing::linear,  api::Easing::hold,        api::Easing::bezier,      api::Easing::ease,
      api::Easing::ease_in, api::Easing::ease_out,    api::Easing::ease_in_out, api::Easing::step,
      api::Easing::auto_bezier, api::Easing::continuous_bezier};
  static constexpr std::array<api::SpatialInterp, 4> kSpatial{api::SpatialInterp::linear, api::SpatialInterp::bezier,
                                                              api::SpatialInterp::continuous, api::SpatialInterp::auto_};
  std::vector<doc::Key> keys;
  keys.reserve(n);
  double t = 0;
  for (std::size_t i = 0; i < n; ++i) {
    doc::Key k;
    t += 0.05 + rng.unit() * 0.5;
    k.t = t;
    k.value = (rng.unit() - 0.5) * 2000.0;
    if (rng.below(8) != 0) k.easing = kEasings[rng.below(kEasings.size())];
    if (rng.below(3) == 0) k.bezier = std::array<double, 4>{rng.unit(), rng.unit() * 2 - 0.5, rng.unit(), rng.unit() * 2 - 0.5};
    if (rng.below(4) == 0) k.si = (rng.unit() - 0.5) * 100.0;
    if (rng.below(4) == 0) k.so = (rng.unit() - 0.5) * 100.0;
    if (rng.below(3) == 0) k.spatial = kSpatial[rng.below(kSpatial.size())];
    if (rng.below(10) == 0) k.roving = true;
    keys.push_back(k);
  }
  return keys;
}

bool same_bits(double a, double b) noexcept {
  return std::bit_cast<std::uint64_t>(a) == std::bit_cast<std::uint64_t>(b);
}

}  // namespace

TEST_CASE("keyframe sampling: the lazy key source matches the whole-track conversion bit for bit",
          "[anim][keyframes][sampling]") {
  Lcg rng;
  const std::vector<doc::Key> keys = long_track(5000, rng);

  std::vector<motion_keyframe> whole;
  whole.reserve(keys.size());
  for (const doc::Key& k : keys) whole.push_back(convert_whole(k));

  // Before the first key, after the last, exactly at keys, and densely between.
  std::vector<double> times{keys.front().t - 1.0, keys.front().t, keys.back().t, keys.back().t + 1.0};
  for (std::size_t i = 0; i + 1 < keys.size(); i += 7) {
    times.push_back(keys[i].t);
    const double span = keys[i + 1].t - keys[i].t;
    for (std::size_t s = 1; s < 5; ++s) times.push_back(keys[i].t + span * static_cast<double>(s) / 5.0);
  }
  for (std::size_t i = 0; i < 20000; ++i) times.push_back(keys.front().t + rng.unit() * (keys.back().t - keys.front().t));

  std::size_t checked = 0;
  for (const double t : times) {
    double expected = 0;
    REQUIRE(motion_eval_sample_scalar(whole.data(), whole.size(), t, &expected, nullptr) == MOTION_OK);
    const std::optional<double> got = doc::sample_keys(keys, t);
    REQUIRE(got.has_value());
    if (!same_bits(*got, expected)) {
      INFO("t = " << t << " expected " << expected << " got " << *got);
      FAIL();
    }
    ++checked;
  }
  CHECK(checked == times.size());

  // Spatial tangents read through the same source.
  for (std::size_t i = 0; i < keys.size(); i += 97) {
    const auto [si, so] = doc::effective_spatial_tangents_of(keys, i);
    const bool has_si = keys[i].spatial != api::SpatialInterp::linear &&
                        (keys[i].spatial == api::SpatialInterp::auto_ ? i > 0 : keys[i].si.has_value());
    const bool has_so = keys[i].spatial != api::SpatialInterp::linear &&
                        (keys[i].spatial == api::SpatialInterp::auto_ ? i + 1 < keys.size() : keys[i].so.has_value());
    CHECK(si.has_value() == has_si);
    CHECK(so.has_value() == has_so);
  }
}

TEST_CASE("keyframe sampling: an empty or single-key track still answers as before", "[anim][keyframes][sampling]") {
  CHECK_FALSE(doc::sample_keys({}, 0.5).has_value());
  doc::Key k;
  k.t = 2;
  k.value = 7;
  const std::vector<doc::Key> one{k};
  CHECK(doc::sample_keys(one, 0).value_or(0) == 7);
  CHECK(doc::sample_keys(one, 2).value_or(0) == 7);
  CHECK(doc::sample_keys(one, 9).value_or(0) == 7);
}

TEST_CASE("data tracks: the segment search is the linear walk's answer", "[anim][keyframes][data]") {
  // A linear number track: the segment is read straight off the value.
  Lcg rng;
  doc::DataTrack tr;
  tr.kind = "number";
  double t = 0;
  for (std::size_t i = 0; i < 3000; ++i) {
    doc::DataKey k;
    t += 0.01 + rng.unit() * 0.3;
    k.t = t;
    k.value = doc::Json::number(static_cast<double>(i));
    tr.keys.push_back(std::move(k));
  }
  const auto& kfs = tr.keys;
  for (std::size_t n = 0; n < 5000; ++n) {
    const double at = kfs.front().t + rng.unit() * (kfs.back().t - kfs.front().t);
    std::size_t i = 0;
    while (i + 1 < kfs.size() && kfs[i + 1].t <= at) ++i;
    const double u = (at - kfs[i].t) / (kfs[i + 1].t - kfs[i].t);
    const double expected = static_cast<double>(i) + (static_cast<double>(i + 1) - static_cast<double>(i)) * u;
    const auto got = doc::sample_data_track(tr, at);
    REQUIRE(got.has_value());
    CHECK(same_bits(got->num(), expected));
  }
  // Exactly at a key: that key's segment starts there.
  for (std::size_t i = 1; i + 1 < kfs.size(); i += 101) {
    const auto got = doc::sample_data_track(tr, kfs[i].t);
    REQUIRE(got.has_value());
    CHECK(got->num() == static_cast<double>(i));
  }
  CHECK(doc::sample_data_track(tr, kfs.front().t - 1)->num() == 0.0);
  CHECK(doc::sample_data_track(tr, kfs.back().t + 1)->num() == static_cast<double>(kfs.size() - 1));
}
