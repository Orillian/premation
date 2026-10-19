// Program X (docs/PROGRAM_DEEP_EFFECTS.md): an effect's controls by key for the
// deep effects' packers (effects_spatial_x*.cpp) — the same reading rules as
// Program E's (effects_spatial_c.cpp Params): declared defaults under stored
// values, percentages as fractions, colours as display 0..1 or linear.
#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <numbers>
#include <string>
#include <string_view>

#include "scene_types.hpp"

namespace premation::scene::deepfx {

using V3 = std::array<double, 3>;
inline constexpr double kPi = std::numbers::pi;

inline double clampd(double v, double lo, double hi) { return std::max(lo, std::min(hi, std::isfinite(v) ? v : lo)); }
inline double s2l(double c) { return c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4); }
inline V3 lin3(const V3& c) { return {s2l(c[0]), s2l(c[1]), s2l(c[2])}; }

struct Params {
  const Json& p;
  [[nodiscard]] const Json& raw(std::string_view k) const {
    static const Json kUndef;
    const Json* v = p.find(k);
    return v != nullptr ? *v : kUndef;
  }
  [[nodiscard]] double n(std::string_view k) const {
    const Json& v = raw(k);
    return v.is_number() && std::isfinite(v.num()) ? v.num() : 0.0;
  }
  [[nodiscard]] double pct(std::string_view k) const { return n(k) / 100; }
  [[nodiscard]] double rad(std::string_view k) const { return n(k) * kPi / 180; }
  [[nodiscard]] bool on(std::string_view k) const {
    const Json& v = raw(k);
    return v.is_bool() && v.b();
  }
  [[nodiscard]] int e(std::string_view k) const { return static_cast<int>(std::lround(n(k))); }
  /// `#rrggbb` / `#rgb` as display 0..1 (`def` when unreadable).
  [[nodiscard]] V3 u3(std::string_view k, V3 def = {0.5, 0.5, 0.5}) const {
    const Json& v = raw(k);
    if (!v.is_string()) return def;
    std::string_view s = v.str();
    while (!s.empty() && s.front() == ' ') s.remove_prefix(1);
    if (s.empty() || s.front() != '#') return def;
    s.remove_prefix(1);
    const auto hex = [](char c) {
      if (c >= '0' && c <= '9') return c - '0';
      if (c >= 'a' && c <= 'f') return c - 'a' + 10;
      if (c >= 'A' && c <= 'F') return c - 'A' + 10;
      return -1;
    };
    V3 out = def;
    if (s.size() >= 6) {
      for (std::size_t i = 0; i < 3; ++i) {
        const int a = hex(s[i * 2]);
        const int b = hex(s[(i * 2) + 1]);
        if (a < 0 || b < 0) return def;
        out.at(i) = (a * 16 + b) / 255.0;
      }
    } else if (s.size() >= 3) {
      for (std::size_t i = 0; i < 3; ++i) {
        const int a = hex(s[i]);
        if (a < 0) return def;
        out.at(i) = (a * 17) / 255.0;
      }
    }
    return out;
  }
  /// The same, decoded to linear light.
  [[nodiscard]] V3 l3(std::string_view k, V3 def = {0.5, 0.5, 0.5}) const { return lin3(u3(k, def)); }
  /// A layer reference ('' = none).
  [[nodiscard]] std::string layer(std::string_view k) const {
    const Json& v = raw(k);
    return v.is_string() ? v.str() : std::string();
  }
};

}  // namespace premation::scene::deepfx
