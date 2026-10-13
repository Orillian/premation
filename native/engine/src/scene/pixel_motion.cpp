#include "pixel_motion.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <cstring>

#include "jsmath.hpp"

namespace premation::scene::pixmo {

namespace {

namespace mjs = motion::js;

using Sz = std::size_t;

Sz uz(int v) { return static_cast<Sz>(v); }

/// blockSad: SAD between the block in `a` at (ax, ay) and the one in `b` at
/// (ax+dx, ay+dy); out-of-bounds samples clamp. Integer, exact.
double block_sad(std::span<const std::int32_t> a, std::span<const std::int32_t> b, int w, int h, int ax, int ay, int dx, int dy,
                 int r) {
  std::int64_t sad = 0;
  for (int oy = -r; oy <= r; ++oy) {
    const int ya = std::min(h - 1, std::max(0, ay + oy));
    const int yb = std::min(h - 1, std::max(0, ay + oy + dy));
    for (int ox = -r; ox <= r; ++ox) {
      const int xa = std::min(w - 1, std::max(0, ax + ox));
      const int xb = std::min(w - 1, std::max(0, ax + ox + dx));
      sad += std::llabs(static_cast<std::int64_t>(a[(uz(ya) * uz(w)) + uz(xa)]) - b[(uz(yb) * uz(w)) + uz(xb)]);
    }
  }
  return static_cast<double>(sad);
}

/// parabolic: the three-point vertex, clamped to ±0.5.
double parabolic(double cm, double c0, double cp) {
  const double denom = cm - (2 * c0) + cp;
  if (denom <= 1e-9) return 0;
  const double off = (0.5 * (cm - cp)) / denom;
  return std::max(-0.5, std::min(0.5, off));
}

/// bilinearRgba: edge-clamped bilinear fetch into float32 `px`.
void bilinear_rgba(std::span<const std::uint8_t> data, int w, int h, double x, double y, std::array<float, 4>& px) {
  const double cx = std::min(static_cast<double>(w - 1), std::max(0.0, x));
  const double cy = std::min(static_cast<double>(h - 1), std::max(0.0, y));
  const double x0 = std::floor(cx);
  const double y0 = std::floor(cy);
  const double x1 = std::min(static_cast<double>(w - 1), x0 + 1);
  const double y1 = std::min(static_cast<double>(h - 1), y0 + 1);
  const double fx = cx - x0;
  const double fy = cy - y0;
  const Sz W = uz(w);
  const Sz p00 = ((static_cast<Sz>(y0) * W) + static_cast<Sz>(x0)) * 4;
  const Sz p10 = ((static_cast<Sz>(y0) * W) + static_cast<Sz>(x1)) * 4;
  const Sz p01 = ((static_cast<Sz>(y1) * W) + static_cast<Sz>(x0)) * 4;
  const Sz p11 = ((static_cast<Sz>(y1) * W) + static_cast<Sz>(x1)) * 4;
  for (Sz c = 0; c < 4; ++c) {
    const double v = (((data[p00 + c] * (1 - fx)) + (data[p10 + c] * fx)) * (1 - fy)) +
                     (((data[p01 + c] * (1 - fx)) + (data[p11 + c] * fx)) * fy);
    px[c] = static_cast<float>(v);
  }
}

}  // namespace

std::uint8_t to_uint8_clamp(double v) noexcept {
  if (std::isnan(v) || v <= 0) return 0;
  if (v >= 255) return 255;
  const double f = std::floor(v);
  double r = f;
  if (f + 0.5 < v) {
    r = f + 1;
  } else if (!(v < f + 0.5)) {
    r = std::fmod(f, 2) == 0 ? f : f + 1;  // a tie rounds to even
  }
  return static_cast<std::uint8_t>(r);
}

ResolvedFlowOptions resolve_flow_options(const FlowOptions& o) {
  ResolvedFlowOptions r;
  r.step = static_cast<int>(std::max(4.0, o.step));
  r.r = static_cast<int>(std::max(2.0, o.blockRadius));
  r.s = static_cast<int>(std::max(2.0, o.searchRadius));
  r.minImp = o.minImprovement;
  return r;
}

std::vector<std::int32_t> luma_int_of(std::span<const std::uint8_t> rgba, int w, int h) {
  std::vector<std::int32_t> out(uz(w) * uz(h), 0);
  for (Sz i = 0, p = 0; i < out.size(); ++i, p += 4) {
    out[i] = (rgba[p] * 77) + (rgba[p + 1] * 150) + (rgba[p + 2] * 29);
  }
  return out;
}

std::vector<double> search_all_cells(std::span<const std::int32_t> a, std::span<const std::int32_t> b, int w, int h, int step, int r,
                                     int s, double minImp) {
  const int cols = std::max(1, w / step);
  const int rows = std::max(1, h / step);
  std::vector<double> raw(uz(cols) * uz(rows) * kSearchStride, 0);
  for (int gy = 0; gy < rows; ++gy) {
    for (int gx = 0; gx < cols; ++gx) {
      const int ax = std::min(w - 1, static_cast<int>(mjs::round((gx + 0.5) * step)));
      const int ay = std::min(h - 1, static_cast<int>(mjs::round((gy + 0.5) * step)));
      const double zero = block_sad(a, b, w, h, ax, ay, 0, 0, r);
      double best = zero;
      int bx = 0;
      int by = 0;
      for (int oy = -s; oy <= s; oy += 2) {
        for (int ox = -s; ox <= s; ox += 2) {
          if (ox == 0 && oy == 0) continue;
          const double sad = block_sad(a, b, w, h, ax, ay, ox, oy, r);
          if (sad < best) {
            best = sad;
            bx = ox;
            by = oy;
          }
        }
      }
      // Refine around the coarse winner (anchored: a neighbourhood argmin).
      const int cx = bx;
      const int cy = by;
      for (int oy = -1; oy <= 1; ++oy) {
        for (int ox = -1; ox <= 1; ++ox) {
          if (ox == 0 && oy == 0) continue;
          const double sad = block_sad(a, b, w, h, ax, ay, cx + ox, cy + oy, r);
          if (sad < best) {
            best = sad;
            bx = cx + ox;
            by = cy + oy;
          }
        }
      }
      const Sz o = ((uz(gy) * uz(cols)) + uz(gx)) * kSearchStride;
      raw[o] = zero;
      raw[o + 1] = best;
      raw[o + 2] = bx;
      raw[o + 3] = by;
      if (zero - best < minImp * std::max(1.0, zero)) continue;
      raw[o + 4] = block_sad(a, b, w, h, ax, ay, bx - 1, by, r);
      raw[o + 5] = block_sad(a, b, w, h, ax, ay, bx + 1, by, r);
      raw[o + 6] = block_sad(a, b, w, h, ax, ay, bx, by - 1, r);
      raw[o + 7] = block_sad(a, b, w, h, ax, ay, bx, by + 1, r);
    }
  }
  return raw;
}

FlowField finalize_flow(std::span<const double> raw, int cols, int rows, int step, double minImp) {
  const Sz n = uz(cols) * uz(rows);
  std::vector<float> dx(n, 0.0F);
  std::vector<float> dy(n, 0.0F);
  FlowField f;
  f.cols = cols;
  f.rows = rows;
  f.step = step;
  f.valid.assign(n, 0);
  for (Sz i = 0; i < n; ++i) {
    const Sz o = i * kSearchStride;
    const double zero = raw[o];
    const double best = raw[o + 1];
    if (zero - best < minImp * std::max(1.0, zero)) continue;
    dx[i] = static_cast<float>(raw[o + 2] + parabolic(raw[o + 4], best, raw[o + 5]));
    dy[i] = static_cast<float>(raw[o + 3] + parabolic(raw[o + 6], best, raw[o + 7]));
    f.valid[i] = 1;
  }
  // One 3×3 box-smooth so neighbours share their estimate.
  f.dx = dx;
  f.dy = dy;
  for (int gy = 0; gy < rows; ++gy) {
    for (int gx = 0; gx < cols; ++gx) {
      double sx = 0;
      double sy = 0;
      int cnt = 0;
      for (int oy = -1; oy <= 1; ++oy) {
        for (int ox = -1; ox <= 1; ++ox) {
          const int yy = gy + oy;
          const int xx = gx + ox;
          if (yy < 0 || yy >= rows || xx < 0 || xx >= cols) continue;
          sx += static_cast<double>(dx[(uz(yy) * uz(cols)) + uz(xx)]);
          sy += static_cast<double>(dy[(uz(yy) * uz(cols)) + uz(xx)]);
          ++cnt;
        }
      }
      f.dx[(uz(gy) * uz(cols)) + uz(gx)] = static_cast<float>(sx / cnt);
      f.dy[(uz(gy) * uz(cols)) + uz(gx)] = static_cast<float>(sy / cnt);
    }
  }
  return f;
}

FlowField compute_flow(std::span<const std::int32_t> a, std::span<const std::int32_t> b, int w, int h, const FlowOptions& opts) {
  const ResolvedFlowOptions o = resolve_flow_options(opts);
  const int cols = std::max(1, w / o.step);
  const int rows = std::max(1, h / o.step);
  const std::vector<double> raw = search_all_cells(a, b, w, h, o.step, o.r, o.s, o.minImp);
  return finalize_flow(raw, cols, rows, o.step, o.minImp);
}

void warp_blend(std::span<const std::uint8_t> a, std::span<const std::uint8_t> b, int w, int h, const FlowField& flow,
                double flowScaleX, double flowScaleY, double t, std::span<std::uint8_t> out) {
  std::array<float, 4> pa{};
  std::array<float, 4> pb{};
  const double invSX = 1 / flowScaleX;
  const double invSY = 1 / flowScaleY;
  const int cols = flow.cols;
  const int rows = flow.rows;
  const double step = flow.step;
  const auto fget = [](const std::vector<float>& v, Sz i) { return static_cast<double>(v[i]); };
  std::vector<Sz> x0s(uz(w));
  std::vector<Sz> x1s(uz(w));
  std::vector<double> fxs(uz(w));
  for (int x = 0; x < w; ++x) {
    const double gx = std::min(static_cast<double>(cols - 1), std::max(0.0, ((x * invSX) / step) - 0.5));
    const double x0 = std::floor(gx);
    x0s[uz(x)] = static_cast<Sz>(x0);
    x1s[uz(x)] = static_cast<Sz>(std::min(static_cast<double>(cols - 1), x0 + 1));
    fxs[uz(x)] = gx - x0;
  }
  Sz o = 0;
  for (int y = 0; y < h; ++y) {
    const double gy = std::min(static_cast<double>(rows - 1), std::max(0.0, ((y * invSY) / step) - 0.5));
    const double y0 = std::floor(gy);
    const double y1 = std::min(static_cast<double>(rows - 1), y0 + 1);
    const double fy = gy - y0;
    const Sz r0 = static_cast<Sz>(y0) * uz(cols);
    const Sz r1 = static_cast<Sz>(y1) * uz(cols);
    for (int x = 0; x < w; ++x, o += 4) {
      const Sz x0 = x0s[uz(x)];
      const Sz x1 = x1s[uz(x)];
      const double fx = fxs[uz(x)];
      const Sz i00 = r0 + x0;
      const Sz i10 = r0 + x1;
      const Sz i01 = r1 + x0;
      const Sz i11 = r1 + x1;
      const double fdxv = (((fget(flow.dx, i00) * (1 - fx)) + (fget(flow.dx, i10) * fx)) * (1 - fy)) +
                          (((fget(flow.dx, i01) * (1 - fx)) + (fget(flow.dx, i11) * fx)) * fy);
      const double fdyv = (((fget(flow.dy, i00) * (1 - fx)) + (fget(flow.dy, i10) * fx)) * (1 - fy)) +
                          (((fget(flow.dy, i01) * (1 - fx)) + (fget(flow.dy, i11) * fx)) * fy);
      const double dx = fdxv * flowScaleX;
      const double dy = fdyv * flowScaleY;
      bilinear_rgba(a, w, h, x - (dx * t), y - (dy * t), pa);
      bilinear_rgba(b, w, h, x + (dx * (1 - t)), y + (dy * (1 - t)), pb);
      for (Sz c = 0; c < 4; ++c) {
        out[o + c] = to_uint8_clamp((static_cast<double>(pa[c]) * (1 - t)) + (static_cast<double>(pb[c]) * t));
      }
    }
  }
}

namespace {

/// A float luma plane (0–255), edge-clamped reads.
struct Plane {
  int w = 0;
  int h = 0;
  std::vector<float> v;
  [[nodiscard]] float at(int x, int y) const noexcept {
    const int cx = std::clamp(x, 0, w - 1);
    const int cy = std::clamp(y, 0, h - 1);
    return v[(uz(cy) * uz(w)) + uz(cx)];
  }
};

/// Full-res RGBA box-averaged down to fw × fh luma (77 R + 150 G + 29 B) / 256.
Plane luma_plane(std::span<const std::uint8_t> rgba, int w, int h, int fw, int fh) {
  Plane p{fw, fh, std::vector<float>(uz(fw) * uz(fh), 0.0F)};
  for (int y = 0; y < fh; ++y) {
    const int y0 = y * h / fh;
    const int y1 = std::max(y0 + 1, (y + 1) * h / fh);
    for (int x = 0; x < fw; ++x) {
      const int x0 = x * w / fw;
      const int x1 = std::max(x0 + 1, (x + 1) * w / fw);
      double sum = 0;
      for (int yy = y0; yy < y1; ++yy) {
        for (int xx = x0; xx < x1; ++xx) {
          const Sz i = ((uz(yy) * uz(w)) + uz(xx)) * 4;
          sum += (rgba[i] * 77.0) + (rgba[i + 1] * 150.0) + (rgba[i + 2] * 29.0);
        }
      }
      p.v[(uz(y) * uz(fw)) + uz(x)] = static_cast<float>(sum / (256.0 * (y1 - y0) * (x1 - x0)));
    }
  }
  return p;
}

/// The next pyramid level: a 2×2 box average.
Plane half_plane(const Plane& s) {
  Plane p{std::max(1, s.w / 2), std::max(1, s.h / 2), {}};
  p.v.resize(uz(p.w) * uz(p.h));
  for (int y = 0; y < p.h; ++y) {
    for (int x = 0; x < p.w; ++x) {
      const float sum = s.at(2 * x, 2 * y) + s.at((2 * x) + 1, 2 * y) + s.at(2 * x, (2 * y) + 1) +
                        s.at((2 * x) + 1, (2 * y) + 1);
      p.v[(uz(y) * uz(p.w)) + uz(x)] = sum * 0.25F;
    }
  }
  return p;
}

float block_cost(const Plane& a, const Plane& b, int cx, int cy, int dx, int dy, int r) {
  float s = 0;
  for (int oy = -r; oy <= r; ++oy) {
    for (int ox = -r; ox <= r; ++ox)
      s += std::abs(a.at(cx + ox, cy + oy) - b.at(cx + ox + dx, cy + oy + dy));
  }
  return s;
}

/// The field's vector at plane coordinates (x, y): bilinear over the grid
/// points ((g + 0.5)·step), edge-clamped — warp_blend's convention.
void sample_field(const FlowField& f, double x, double y, double& dx, double& dy) noexcept {
  const double gx = std::clamp((x / f.step) - 0.5, 0.0, static_cast<double>(f.cols - 1));
  const double gy = std::clamp((y / f.step) - 0.5, 0.0, static_cast<double>(f.rows - 1));
  const int x0 = static_cast<int>(gx);
  const int y0 = static_cast<int>(gy);
  const int x1 = std::min(f.cols - 1, x0 + 1);
  const int y1 = std::min(f.rows - 1, y0 + 1);
  const double fx = gx - x0;
  const double fy = gy - y0;
  const auto idx = [&f](int cx, int cy) { return (uz(cy) * uz(f.cols)) + uz(cx); };
  const auto lerp2 = [&](const std::vector<float>& v) {
    const double top = (static_cast<double>(v[idx(x0, y0)]) * (1 - fx)) +
                       (static_cast<double>(v[idx(x1, y0)]) * fx);
    const double bot = (static_cast<double>(v[idx(x0, y1)]) * (1 - fx)) +
                       (static_cast<double>(v[idx(x1, y1)]) * fx);
    return (top * (1 - fy)) + (bot * fy);
  };
  dx = lerp2(f.dx);
  dy = lerp2(f.dy);
}

constexpr int kPmStep = 4;          // grid spacing, level px
constexpr int kPmRadius = 3;        // 7×7 blocks
constexpr int kPmTopSearch = 6;     // exhaustive ± at the coarsest level
constexpr int kPmLocalSearch = 2;   // ± around the best seed below it
constexpr float kPmLambda = 0.25F;  // luma per block px per px of departure from the seed

/// One pyramid level: each grid point's best integer offset among the seeds
/// (the coarser level's vector here and at the four neighbouring points, and
/// zero), a local search around it, then the parabolic sub-pixel vertex.
void run_rows(const RowRunner& rows, int n, const std::function<void(int, int)>& fn) {
  if (n <= 0) return;
  if (rows) {
    rows(n, fn);
  } else {
    fn(0, n);
  }
}

FlowField match_level(const Plane& a, const Plane& b, const FlowField* coarse,
                      const RowRunner& rows) {
  FlowField f;
  f.cols = std::max(1, a.w / kPmStep);
  f.rows = std::max(1, a.h / kPmStep);
  f.step = kPmStep;
  const Sz n = uz(f.cols) * uz(f.rows);
  f.dx.assign(n, 0.0F);
  f.dy.assign(n, 0.0F);
  f.valid.assign(n, 1);
  const auto area = static_cast<float>(((2 * kPmRadius) + 1) * ((2 * kPmRadius) + 1));
  run_rows(rows, f.rows, [&](int gy0, int gy1) {
    for (int gy = gy0; gy < gy1; ++gy) {
      for (int gx = 0; gx < f.cols; ++gx) {
        const int cx = std::min(a.w - 1, static_cast<int>(std::lround((gx + 0.5) * kPmStep)));
        const int cy = std::min(a.h - 1, static_cast<int>(std::lround((gy + 0.5) * kPmStep)));
        std::array<std::array<int, 2>, 6> seeds{};
        std::size_t count = 1;  // seeds[0] = zero
        double px = 0;
        double py = 0;
        if (coarse != nullptr) {
          constexpr std::array<std::array<int, 2>, 5> kAround{
              {{0, 0}, {-kPmStep, 0}, {kPmStep, 0}, {0, -kPmStep}, {0, kPmStep}}};
          for (const auto& o : kAround) {
            double sx = 0;
            double sy = 0;
            sample_field(*coarse, (cx + o[0]) * 0.5, (cy + o[1]) * 0.5, sx, sy);
            if (count == 1) {
              px = sx * 2;
              py = sy * 2;
            }
            seeds.at(count++) = {static_cast<int>(std::lround(sx * 2)),
                                 static_cast<int>(std::lround(sy * 2))};
          }
        }
        const auto cost = [&](int dx, int dy) {
          return block_cost(a, b, cx, cy, dx, dy, kPmRadius) +
                 (kPmLambda * area * static_cast<float>(std::abs(dx - px) + std::abs(dy - py)));
        };
        int bx = 0;
        int by = 0;
        float best = cost(0, 0);
        for (std::size_t i = 1; i < count; ++i) {
          const float c = cost(seeds.at(i)[0], seeds.at(i)[1]);
          if (c < best) {
            best = c;
            bx = seeds.at(i)[0];
            by = seeds.at(i)[1];
          }
        }
        const int reach = coarse == nullptr ? kPmTopSearch : kPmLocalSearch;
        const int sx0 = bx;
        const int sy0 = by;
        for (int oy = -reach; oy <= reach; ++oy) {
          for (int ox = -reach; ox <= reach; ++ox) {
            const float c = cost(sx0 + ox, sy0 + oy);
            if (c < best) {
              best = c;
              bx = sx0 + ox;
              by = sy0 + oy;
            }
          }
        }
        const double c0 = block_cost(a, b, cx, cy, bx, by, kPmRadius);
        const double subX = parabolic(block_cost(a, b, cx, cy, bx - 1, by, kPmRadius), c0,
                                      block_cost(a, b, cx, cy, bx + 1, by, kPmRadius));
        const double subY = parabolic(block_cost(a, b, cx, cy, bx, by - 1, kPmRadius), c0,
                                      block_cost(a, b, cx, cy, bx, by + 1, kPmRadius));
        const Sz i = (uz(gy) * uz(f.cols)) + uz(gx);
        f.dx[i] = static_cast<float>(bx + subX);
        f.dy[i] = static_cast<float>(by + subY);
      }
    }
  });
  return f;
}

/// 3×3 component-wise median: keeps motion edges where a mean smeared them.
void median3(FlowField& f) {
  const std::vector<float> dx = f.dx;
  const std::vector<float> dy = f.dy;
  std::array<float, 9> bx{};
  std::array<float, 9> by{};
  for (int gy = 0; gy < f.rows; ++gy) {
    for (int gx = 0; gx < f.cols; ++gx) {
      std::size_t k = 0;
      for (int oy = -1; oy <= 1; ++oy) {
        for (int ox = -1; ox <= 1; ++ox) {
          const int yy = gy + oy;
          const int xx = gx + ox;
          if (yy < 0 || yy >= f.rows || xx < 0 || xx >= f.cols) continue;
          const Sz j = (uz(yy) * uz(f.cols)) + uz(xx);
          bx.at(k) = dx[j];
          by.at(k) = dy[j];
          ++k;
        }
      }
      const auto mid = static_cast<std::ptrdiff_t>(k / 2);
      std::nth_element(bx.begin(), bx.begin() + mid, bx.begin() + static_cast<std::ptrdiff_t>(k));
      std::nth_element(by.begin(), by.begin() + mid, by.begin() + static_cast<std::ptrdiff_t>(k));
      const Sz i = (uz(gy) * uz(f.cols)) + uz(gx);
      f.dx[i] = bx.at(uz(static_cast<int>(mid)));
      f.dy[i] = by.at(uz(static_cast<int>(mid)));
    }
  }
}

FlowField pyramid_flow(const std::vector<Plane>& pa, const std::vector<Plane>& pb,
                       const RowRunner& rows) {
  FlowField f;
  for (std::size_t k = pa.size(); k-- > 0;) {
    FlowField next = match_level(pa[k], pb[k], k + 1 == pa.size() ? nullptr : &f, rows);
    median3(next);
    f = std::move(next);
  }
  return f;
}

/// The through-vector raster samples every kThroughStride-th flow-raster px
/// (the field it reads is a 4 px grid, so nothing finer exists to resolve).
constexpr int kThroughStride = 2;

/// Per through-raster point (flow-raster px (x, y)·stride), the vector of the
/// point that passes through it at time `s` along `f` (s = t forward, 1 − t
/// backward): the fixed point of p = x − s·F(p).
std::vector<float> through_vectors(const FlowField& f, int tw, int th, double s,
                                   const RowRunner& rows) {
  std::vector<float> out(uz(tw) * uz(th) * 2);
  run_rows(rows, th, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < tw; ++x) {
        const double px = static_cast<double>(x) * kThroughStride;
        const double py = static_cast<double>(y) * kThroughStride;
        double dx = 0;
        double dy = 0;
        sample_field(f, px, py, dx, dy);
        for (int it = 0; it < 4; ++it) sample_field(f, px - (s * dx), py - (s * dy), dx, dy);
        const Sz o = ((uz(y) * uz(tw)) + uz(x)) * 2;
        out[o] = static_cast<float>(dx);
        out[o + 1] = static_cast<float>(dy);
      }
    }
  });
  return out;
}

/// Edge-clamped bilinear RGBA fetch, float (the interpolation's hot path;
/// bilinear_rgba above stays float64 for warp_blend's parity).
void fetch_rgba(const std::uint8_t* data, int w, int h, float x, float y,
                std::array<float, 4>& px) noexcept {
  const float cx = std::clamp(x, 0.0F, static_cast<float>(w - 1));
  const float cy = std::clamp(y, 0.0F, static_cast<float>(h - 1));
  const int x0 = static_cast<int>(cx);
  const int y0 = static_cast<int>(cy);
  const int x1 = std::min(w - 1, x0 + 1);
  const int y1 = std::min(h - 1, y0 + 1);
  const float fx = cx - static_cast<float>(x0);
  const float fy = cy - static_cast<float>(y0);
  const Sz W = uz(w);
  // NOLINTBEGIN(cppcoreguidelines-pro-bounds-pointer-arithmetic): indices are clamped into the
  // w·h·4 frame above
  const std::uint8_t* p00 = data + (((uz(y0) * W) + uz(x0)) * 4);
  const std::uint8_t* p10 = data + (((uz(y0) * W) + uz(x1)) * 4);
  const std::uint8_t* p01 = data + (((uz(y1) * W) + uz(x0)) * 4);
  const std::uint8_t* p11 = data + (((uz(y1) * W) + uz(x1)) * 4);
  for (Sz c = 0; c < 4; ++c) {
    const float top = static_cast<float>(p00[c]) +
                      ((static_cast<float>(p10[c]) - static_cast<float>(p00[c])) * fx);
    const float bot = static_cast<float>(p01[c]) +
                      ((static_cast<float>(p11[c]) - static_cast<float>(p01[c])) * fx);
    px.at(c) = top + ((bot - top) * fy);
  }
  // NOLINTEND(cppcoreguidelines-pro-bounds-pointer-arithmetic)
}

float rgb_diff(const std::array<float, 4>& p, const std::array<float, 4>& q) noexcept {
  return (std::abs(p[0] - q[0]) + std::abs(p[1] - q[1]) + std::abs(p[2] - q[2])) * (1.0F / 3.0F);
}

std::uint8_t to_byte(float v) noexcept {
  // Clamped non-negative first, so +0.5 then truncation rounds correctly (no
  // lround call per channel: this runs 4·w·h times per in-between).
  return static_cast<std::uint8_t>(std::clamp(v, 0.0F, 255.0F) + 0.5F);  // NOLINT(bugprone-incorrect-roundings)
}

// The forward pair is trusted outright below this mean difference (8-bit
// levels; most pixels): the backward pair is only fetched where it may win.
constexpr float kForwardAgrees = 4;
// Where even the better direction's two samples differ by more than this the
// pixel is treated as occluded and leans on the nearer frame.
constexpr float kOccludedFrom = 20;
constexpr float kOccludedFull = 60;

}  // namespace

PairFlow estimate_pair_flow(std::span<const std::uint8_t> a, std::span<const std::uint8_t> b, int w,
                            int h, int maxDim, const RowRunner& rows) {
  PairFlow pf;
  const double scale = std::min(1.0, static_cast<double>(maxDim) / std::max(w, h));
  pf.fw = std::max(8, static_cast<int>(std::lround(w * scale)));
  pf.fh = std::max(8, static_cast<int>(std::lround(h * scale)));
  std::vector<Plane> pa{luma_plane(a, w, h, pf.fw, pf.fh)};
  std::vector<Plane> pb{luma_plane(b, w, h, pf.fw, pf.fh)};
  // Down to ~16 px on the short side: the coarsest search (±6) then spans
  // about a sixth of the frame per source frame.
  while (pa.size() < 6 && std::min(pa.back().w, pa.back().h) / 2 >= 16) {
    pa.push_back(half_plane(pa.back()));
    pb.push_back(half_plane(pb.back()));
  }
  pf.fwd = pyramid_flow(pa, pb, rows);
  pf.bwd = pyramid_flow(pb, pa, rows);
  return pf;
}

void interpolate_pair(std::span<const std::uint8_t> a, std::span<const std::uint8_t> b, int w,
                      int h, const PairFlow& flow, double t, std::span<std::uint8_t> out,
                      const RowRunner& rows) {
  const double fsx = static_cast<double>(w) / flow.fw;  // full-res px per flow-raster px
  const double fsy = static_cast<double>(h) / flow.fh;
  const int tw = ((flow.fw - 1) / kThroughStride) + 1;  // the through raster
  const int th = ((flow.fh - 1) / kThroughStride) + 1;
  const double sx = fsx * kThroughStride;  // full-res px per through-raster px
  const double sy = fsy * kThroughStride;
  // Vectors in flow-raster px, scaled to full-res px here once.
  std::vector<float> vf = through_vectors(flow.fwd, tw, th, t, rows);
  std::vector<float> vb = through_vectors(flow.bwd, tw, th, 1 - t, rows);
  for (Sz i = 0; i < vf.size(); i += 2) {
    vf[i] = static_cast<float>(vf[i] * fsx);
    vf[i + 1] = static_cast<float>(vf[i + 1] * fsy);
    vb[i] = static_cast<float>(vb[i] * fsx);
    vb[i + 1] = static_cast<float>(vb[i + 1] * fsy);
  }
  // The through-raster column each output column reads (x / sx, clamped).
  std::vector<int> col0(uz(w));
  std::vector<int> col1(uz(w));
  std::vector<float> colF(uz(w));
  for (int x = 0; x < w; ++x) {
    const double u = std::clamp(x / sx, 0.0, static_cast<double>(tw - 1));
    col0[uz(x)] = static_cast<int>(u);
    col1[uz(x)] = std::min(tw - 1, col0[uz(x)] + 1);
    colF[uz(x)] = static_cast<float>(u - col0[uz(x)]);
  }
  const auto tf = static_cast<float>(t);
  const float nearA = t < 0.5 ? 1.0F : 0.0F;
  const std::uint8_t* pa = a.data();
  const std::uint8_t* pb = b.data();
  run_rows(rows, h, [&](int ya, int yb) {
    std::array<float, 4> af{};
    std::array<float, 4> bf{};
    std::array<float, 4> ab{};
    std::array<float, 4> bb{};
    Sz o = uz(ya) * uz(w) * 4;
    for (int y = ya; y < yb; ++y) {
      const double v = std::clamp(y / sy, 0.0, static_cast<double>(th - 1));
      const int r0 = static_cast<int>(v);
      const int r1 = std::min(th - 1, r0 + 1);
      const auto fy = static_cast<float>(v - r0);
      const Sz row0 = uz(r0) * uz(tw);
      const Sz row1 = uz(r1) * uz(tw);
      const auto yf = static_cast<float>(y);
      for (int x = 0; x < w; ++x, o += 4) {
        const Sz i00 = (row0 + uz(col0[uz(x)])) * 2;
        const Sz i10 = (row0 + uz(col1[uz(x)])) * 2;
        const Sz i01 = (row1 + uz(col0[uz(x)])) * 2;
        const Sz i11 = (row1 + uz(col1[uz(x)])) * 2;
        const float fx = colF[uz(x)];
        const auto lerp4 = [&](const std::vector<float>& vv, Sz c) {
          const float top = vv[i00 + c] + ((vv[i10 + c] - vv[i00 + c]) * fx);
          const float bot = vv[i01 + c] + ((vv[i11 + c] - vv[i01 + c]) * fx);
          return top + ((bot - top) * fy);
        };
        const auto xf = static_cast<float>(x);
        // Forward: the A pixel at x − t·F lands on x at t, and on x + (1−t)·F in B.
        const float fdx = lerp4(vf, 0);
        const float fdy = lerp4(vf, 1);
        fetch_rgba(pa, w, h, xf - (tf * fdx), yf - (tf * fdy), af);
        fetch_rgba(pb, w, h, xf + ((1 - tf) * fdx), yf + ((1 - tf) * fdy), bf);
        const float ef = rgb_diff(af, bf);
        float kf = 1;  // the forward pair's share
        float e = ef;
        if (ef > kForwardAgrees) {
          // Backward: the B pixel at x − (1−t)·G lands on x, and on x + t·G in A.
          const float bdx = lerp4(vb, 0);
          const float bdy = lerp4(vb, 1);
          fetch_rgba(pb, w, h, xf - ((1 - tf) * bdx), yf - ((1 - tf) * bdy), bb);
          fetch_rgba(pa, w, h, xf + (tf * bdx), yf + (tf * bdy), ab);
          const float eb = rgb_diff(ab, bb);
          kf = (eb + 1) / (ef + eb + 2);  // the better-agreeing direction dominates
          e = (kf * ef) + ((1 - kf) * eb);
        }
        const float occ =
            std::clamp((e - kOccludedFrom) / (kOccludedFull - kOccludedFrom), 0.0F, 1.0F);
        const float wa = (1 - tf) + (occ * (nearA - (1 - tf)));
        for (Sz c = 0; c < 4; ++c) {
          const float sa = kf < 1 ? (kf * af.at(c)) + ((1 - kf) * ab.at(c)) : af.at(c);
          const float sb = kf < 1 ? (kf * bf.at(c)) + ((1 - kf) * bb.at(c)) : bf.at(c);
          out[o + c] = to_byte((sa * wa) + (sb * (1 - wa)));
        }
      }
    }
  });
}

void deinterlace_data(std::span<std::uint8_t> data, int width, int height, bool keepUpper) {
  if (width < 1 || height < 2) return;
  const int keepParity = keepUpper ? 0 : 1;
  const Sz rowBytes = uz(width) * 4;
  for (int y = 0; y < height; ++y) {
    if (y % 2 == keepParity) continue;  // y >= 0
    const int above = y - 1;
    const int below = y + 1;
    const Sz row = uz(y) * rowBytes;
    if (above < 0) {  // top edge: only the kept row below exists
      std::memmove(data.subspan(row).data(), data.subspan(uz(below) * rowBytes).data(), rowBytes);
      continue;
    }
    if (below >= height) {
      std::memmove(data.subspan(row).data(), data.subspan(uz(above) * rowBytes).data(), rowBytes);
      continue;
    }
    const Sz ra = uz(above) * rowBytes;
    const Sz rb = uz(below) * rowBytes;
    for (Sz x = 0; x < rowBytes; ++x) {
      data[row + x] = static_cast<std::uint8_t>((unsigned{data[ra + x]} + data[rb + x] + 1U) >> 1U);  // +1 rounds to nearest
    }
  }
}

}  // namespace premation::scene::pixmo
