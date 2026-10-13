// Pixel Motion in-between quality (pixel_motion.hpp interpolate_pair) on
// synthetic footage whose true in-between frames are known: a textured
// object moving over a textured (optionally panning) background. Each case
// reports the mean error against the true frame for a plain cross-fade, the
// previous block flow (compute_flow + warp_blend on a ≤384 px raster) and the
// current path, and the error inside the object's swept band — where a
// doubled ("ghosted") edge shows.
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <functional>
#include <span>
#include <thread>
#include <vector>

#include "pixel_motion.hpp"

namespace pm = premation::scene::pixmo;

namespace {

using Sz = std::size_t;

Sz uz(int v) { return static_cast<Sz>(v); }

std::uint32_t hash2(int x, int y, std::uint32_t seed) {
  std::uint32_t h = (static_cast<std::uint32_t>(x) * 374761393U) ^ (static_cast<std::uint32_t>(y) * 668265263U) ^ (seed * 2246822519U);
  h = (h ^ (h >> 13U)) * 1274126177U;
  return h ^ (h >> 16U);
}

/// Smooth value noise in [0, 1], lattice every `cell` px.
double noise(double x, double y, double cell, std::uint32_t seed) {
  const double gx = x / cell;
  const double gy = y / cell;
  const double x0 = std::floor(gx);
  const double y0 = std::floor(gy);
  const double fx = gx - x0;
  const double fy = gy - y0;
  const auto v = [&](double ix, double iy) { return (hash2(static_cast<int>(ix), static_cast<int>(iy), seed) & 0xFFFFU) / 65535.0; };
  const double sx = fx * fx * (3 - 2 * fx);
  const double sy = fy * fy * (3 - 2 * fy);
  const double top = v(x0, y0) + (v(x0 + 1, y0) - v(x0, y0)) * sx;
  const double bot = v(x0, y0 + 1) + (v(x0 + 1, y0 + 1) - v(x0, y0 + 1)) * sx;
  return top + (bot - top) * sy;
}

struct Scene {
  int w = 0;
  int h = 0;
  double objW = 0;  // the object's box
  double objH = 0;
  double objX0 = 0;  // its top-left at time 0
  double objY0 = 0;
  double objVx = 0;  // px per source frame
  double objVy = 0;
  double bgVx = 0;
};

std::array<double, 3> bg_color(double x, double y) {
  const double n = noise(x, y, 7, 1) * 0.7 + noise(x, y, 23, 2) * 0.3;
  return {40 + 120 * n, 60 + 100 * noise(x, y, 11, 3), 90 + 80 * n};
}

std::array<double, 3> obj_color(double x, double y) {
  const double n = noise(x, y, 5, 7);
  return {170 + 80 * n, 120 + 100 * noise(x, y, 9, 8), 30 + 60 * n};
}

/// The frame at source time s (0 = A, 1 = B, between = the true in-between).
std::vector<std::uint8_t> render(const Scene& sc, double s) {
  std::vector<std::uint8_t> px(uz(sc.w) * uz(sc.h) * 4);
  const double ox = sc.objX0 + sc.objVx * s;
  const double oy = sc.objY0 + sc.objVy * s;
  for (int y = 0; y < sc.h; ++y) {
    for (int x = 0; x < sc.w; ++x) {
      const double cx = x + 0.5;
      const double cy = y + 0.5;
      const bool inside = cx >= ox && cx < ox + sc.objW && cy >= oy && cy < oy + sc.objH;
      const auto c = inside ? obj_color(cx - ox, cy - oy) : bg_color(cx + sc.bgVx * s, cy);
      const Sz o = ((uz(y) * uz(sc.w)) + uz(x)) * 4;
      for (Sz k = 0; k < 3; ++k) px[o + k] = static_cast<std::uint8_t>(std::clamp(std::lround(c.at(k)), 0L, 255L));
      px[o + 3] = 255;
    }
  }
  return px;
}

/// scene_textures.cpp box_downscale (the previous path's flow raster).
std::vector<std::uint8_t> box_downscale(const std::vector<std::uint8_t>& rgba, int w, int h, int fw, int fh) {
  std::vector<std::uint8_t> out(uz(fw) * uz(fh) * 4);
  for (int y = 0; y < fh; ++y) {
    const int y0 = y * h / fh;
    const int y1 = std::max(y0 + 1, (y + 1) * h / fh);
    for (int x = 0; x < fw; ++x) {
      const int x0 = x * w / fw;
      const int x1 = std::max(x0 + 1, (x + 1) * w / fw);
      std::array<std::uint32_t, 4> sum{};
      for (int yy = y0; yy < y1; ++yy) {
        for (int xx = x0; xx < x1; ++xx) {
          for (Sz c = 0; c < 4; ++c) sum.at(c) += rgba[((uz(yy) * uz(w)) + uz(xx)) * 4 + c];
        }
      }
      const auto n = static_cast<std::uint32_t>((y1 - y0) * (x1 - x0));
      for (Sz c = 0; c < 4; ++c) out[((uz(y) * uz(fw)) + uz(x)) * 4 + c] = static_cast<std::uint8_t>((sum.at(c) + n / 2) / n);
    }
  }
  return out;
}

double ms_since(std::chrono::steady_clock::time_point t0) {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
}

std::vector<std::uint8_t> previous_path(const std::vector<std::uint8_t>& a, const std::vector<std::uint8_t>& b, int w, int h, double t,
                                        double& flowMs, double& warpMs) {
  const auto t0 = std::chrono::steady_clock::now();
  const double scale = std::min(1.0, 384.0 / std::max(w, h));
  const int fw = std::max(8, static_cast<int>(std::lround(w * scale)));
  const int fh = std::max(8, static_cast<int>(std::lround(h * scale)));
  const auto sa = box_downscale(a, w, h, fw, fh);
  const auto sb = box_downscale(b, w, h, fw, fh);
  const pm::FlowField f = pm::compute_flow(pm::luma_int_of(sa, fw, fh), pm::luma_int_of(sb, fw, fh), fw, fh);
  flowMs = ms_since(t0);
  std::vector<std::uint8_t> out(a.size());
  const auto w0 = std::chrono::steady_clock::now();
  pm::warp_blend(a, b, w, h, f, static_cast<double>(w) / fw, static_cast<double>(h) / fh, t, out);
  warpMs = ms_since(w0);
  return out;
}

std::vector<std::uint8_t> crossfade(const std::vector<std::uint8_t>& a, const std::vector<std::uint8_t>& b, double t) {
  std::vector<std::uint8_t> out(a.size());
  for (Sz i = 0; i < a.size(); ++i) out[i] = pm::to_uint8_clamp(a[i] * (1 - t) + b[i] * t);
  return out;
}

struct Err {
  double all = 0;   // mean |Δ| over RGB, whole frame
  double band = 0;  // inside the object's swept band (its box from A to B)
};

Err error_of(const Scene& sc, const std::vector<std::uint8_t>& got, const std::vector<std::uint8_t>& truth) {
  const double bx0 = std::min(sc.objX0, sc.objX0 + sc.objVx) - 2;
  const double bx1 = std::max(sc.objX0, sc.objX0 + sc.objVx) + sc.objW + 2;
  const double by0 = std::min(sc.objY0, sc.objY0 + sc.objVy) - 2;
  const double by1 = std::max(sc.objY0, sc.objY0 + sc.objVy) + sc.objH + 2;
  double all = 0;
  double band = 0;
  std::size_t nb = 0;
  for (int y = 0; y < sc.h; ++y) {
    for (int x = 0; x < sc.w; ++x) {
      const Sz o = ((uz(y) * uz(sc.w)) + uz(x)) * 4;
      double d = 0;
      for (Sz k = 0; k < 3; ++k) d += std::abs(static_cast<double>(got[o + k]) - truth[o + k]);
      d /= 3;
      all += d;
      if (x >= bx0 && x < bx1 && y >= by0 && y < by1) {
        band += d;
        ++nb;
      }
    }
  }
  return {all / (static_cast<double>(sc.w) * sc.h), nb > 0 ? band / static_cast<double>(nb) : 0};
}

struct Totals {
  Err fade;
  Err prev;
  Err next;
};

Totals run_case(const char* name, const Scene& sc) {
  const auto a = render(sc, 0);
  const auto b = render(sc, 1);
  const auto t0 = std::chrono::steady_clock::now();
  const pm::PairFlow flow = pm::estimate_pair_flow(a, b, sc.w, sc.h);
  const auto t1 = std::chrono::steady_clock::now();
  Totals tot;
  double warpMs = 0;
  double prevFlowMs = 0;
  double prevWarpMs = 0;
  constexpr std::array<double, 3> kTs{0.25, 0.5, 0.75};
  for (const double t : kTs) {
    const auto truth = render(sc, t);
    const Err ef = error_of(sc, crossfade(a, b, t), truth);
    double pf = 0;
    double pw = 0;
    const Err ep = error_of(sc, previous_path(a, b, sc.w, sc.h, t, pf, pw), truth);
    prevFlowMs += pf / 3;
    prevWarpMs += pw / 3;
    std::vector<std::uint8_t> out(a.size());
    const auto w0 = std::chrono::steady_clock::now();
    pm::interpolate_pair(a, b, sc.w, sc.h, flow, t, out);
    warpMs += ms_since(w0);
    const Err en = error_of(sc, out, truth);
    tot.fade.all += ef.all / 3;
    tot.fade.band += ef.band / 3;
    tot.prev.all += ep.all / 3;
    tot.prev.band += ep.band / 3;
    tot.next.all += en.all / 3;
    tot.next.band += en.band / 3;
  }
  // The same on 8 threads (SceneTextures' pool: min(8, cores)).
  const pm::RowRunner split = [](int n, const std::function<void(int, int)>& fn) {
    std::vector<std::thread> ts;
    for (int k = 0; k < 8; ++k) ts.emplace_back(fn, n * k / 8, n * (k + 1) / 8);
    for (std::thread& th : ts) th.join();
  };
  const auto m0 = std::chrono::steady_clock::now();
  const pm::PairFlow flowMt = pm::estimate_pair_flow(a, b, sc.w, sc.h, pm::kPairFlowMaxDim, split);
  const double flowMtMs = ms_since(m0);
  std::vector<std::uint8_t> mt(a.size());
  const auto m1 = std::chrono::steady_clock::now();
  pm::interpolate_pair(a, b, sc.w, sc.h, flowMt, 0.5, mt, split);
  std::printf("pixel motion %-22s 8 threads: flow %.1f ms, warp %.1f ms/frame\n", name, flowMtMs, ms_since(m1));
  std::printf("pixel motion %-22s %4dx%-4d | mean err all/band: crossfade %5.2f/%5.2f  previous %5.2f/%5.2f  now %5.2f/%5.2f"
              " | flow ms previous %.1f now %.1f | warp ms/frame previous %.1f now %.1f\n",
              name, sc.w, sc.h, tot.fade.all, tot.fade.band, tot.prev.all, tot.prev.band, tot.next.all, tot.next.band, prevFlowMs,
              std::chrono::duration<double, std::milli>(t1 - t0).count(), prevWarpMs, warpMs / 3);
  return tot;
}

}  // namespace

TEST_CASE("pixel motion in-betweens: closer to the true frame than the previous flow", "[scene][pixmo][quality]") {
  SECTION("slow object, static background") {
    const Totals r = run_case("slow object", {384, 216, 80, 60, 100, 70, 6, 2, 0});
    CHECK(r.next.band <= r.prev.band * 1.05);
    CHECK(r.next.band < r.fade.band * 0.5);
  }
  SECTION("fast object (beyond the previous search)") {
    const Totals r = run_case("fast object", {384, 216, 70, 60, 60, 80, 48, 6, 0});
    CHECK(r.next.band < r.prev.band * 0.6);
  }
  SECTION("object over a panning background") {
    const Totals r = run_case("object + pan", {384, 216, 70, 60, 80, 70, 24, -4, 5});
    CHECK(r.next.band < r.prev.band * 0.8);
    CHECK(r.next.all < r.prev.all);
  }
  SECTION("720p, fast object") {
    const Totals r = run_case("720p fast object", {1280, 720, 220, 180, 200, 250, 120, 15, 8});
    CHECK(r.next.band < r.prev.band * 0.6);
    CHECK(r.next.all < r.prev.all);
  }
  SECTION("1080p, moderate object") {
    const Totals r = run_case("1080p moderate object", {1920, 1080, 300, 260, 600, 400, 60, 10, 4});
    CHECK(r.next.band <= r.prev.band);
  }
}

TEST_CASE("pixel motion in-betweens: deterministic, and exact at the ends", "[scene][pixmo][quality]") {
  const Scene sc{256, 144, 50, 40, 60, 50, 30, 4, 3};
  const auto a = render(sc, 0);
  const auto b = render(sc, 1);
  const pm::PairFlow f1 = pm::estimate_pair_flow(a, b, sc.w, sc.h);
  const pm::PairFlow f2 = pm::estimate_pair_flow(a, b, sc.w, sc.h);
  std::vector<std::uint8_t> o1(a.size());
  std::vector<std::uint8_t> o2(a.size());
  pm::interpolate_pair(a, b, sc.w, sc.h, f1, 0.4, o1);
  pm::interpolate_pair(a, b, sc.w, sc.h, f2, 0.4, o2);
  CHECK(o1 == o2);
  // Rows split across threads (as SceneTextures' pool does): the same bytes.
  const pm::RowRunner split = [](int n, const std::function<void(int, int)>& fn) {
    std::vector<std::thread> ts;
    for (int k = 0; k < 4; ++k) ts.emplace_back(fn, n * k / 4, n * (k + 1) / 4);
    for (std::thread& th : ts) th.join();
  };
  const pm::PairFlow f3 = pm::estimate_pair_flow(a, b, sc.w, sc.h, pm::kPairFlowMaxDim, split);
  CHECK(f3.fwd.dx == f1.fwd.dx);
  CHECK(f3.bwd.dy == f1.bwd.dy);
  pm::interpolate_pair(a, b, sc.w, sc.h, f3, 0.4, o2, split);
  CHECK(o1 == o2);
  pm::interpolate_pair(a, b, sc.w, sc.h, f1, 0, o1);
  CHECK(o1 == a);
  pm::interpolate_pair(a, b, sc.w, sc.h, f1, 1, o1);
  CHECK(o1 == b);
}
