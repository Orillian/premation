// Hand tracking's arithmetic — see hand_pipeline.hpp.
#include "hand_pipeline.hpp"

#include <algorithm>
#include <cmath>
#include <numeric>

namespace premation::live {

namespace {

constexpr double kPi = 3.14159265358979323846;

/// The palm subset of the 21 landmarks, in the detector's keypoint order.
constexpr std::array<std::size_t, 7> kPalmLandmarks{0, 5, 9, 13, 17, 1, 2};

/// `p` turned by `a` radians (y down: positive turns clockwise on screen).
P2 rotate(P2 p, double a) noexcept {
  const double c = std::cos(a);
  const double s = std::sin(a);
  return {c * p.x - s * p.y, s * p.x + c * p.y};
}

/// Bilinear BGRA → RGB at frame position (x, y) in px (pixel centres at +0.5); black outside.
void sample(const ImageView& f, double x, double y, float& r, float& g, float& b) noexcept {
  const double fx = x - 0.5;
  const double fy = y - 0.5;
  const double x0f = std::floor(fx);
  const double y0f = std::floor(fy);
  const double tx = fx - x0f;
  const double ty = fy - y0f;
  const int x0 = static_cast<int>(x0f);
  const int y0 = static_cast<int>(y0f);
  double acc[3] = {0, 0, 0};
  for (int j = 0; j < 2; ++j) {
    for (int i = 0; i < 2; ++i) {
      const int px = x0 + i;
      const int py = y0 + j;
      if (px < 0 || py < 0 || px >= f.width || py >= f.height) continue;
      const double w = (i == 0 ? 1 - tx : tx) * (j == 0 ? 1 - ty : ty);
      const std::uint8_t* p = f.data + static_cast<std::ptrdiff_t>(py) * f.stride + static_cast<std::ptrdiff_t>(px) * 4;
      acc[0] += w * p[2];  // BGRA: R is byte 2
      acc[1] += w * p[1];
      acc[2] += w * p[0];
    }
  }
  r = static_cast<float>(acc[0] / 255.0);
  g = static_cast<float>(acc[1] / 255.0);
  b = static_cast<float>(acc[2] / 255.0);
}

void put(std::vector<float>& out, int n, int u, int v, bool planar, float r, float g, float b) {
  const std::size_t plane = static_cast<std::size_t>(n) * static_cast<std::size_t>(n);
  const std::size_t at = static_cast<std::size_t>(v) * static_cast<std::size_t>(n) + static_cast<std::size_t>(u);
  if (planar) {
    out[at] = r;
    out[plane + at] = g;
    out[2 * plane + at] = b;
  } else {
    out[at * 3] = r;
    out[at * 3 + 1] = g;
    out[at * 3 + 2] = b;
  }
}

double sigmoid(double x) noexcept { return 1.0 / (1.0 + std::exp(-x)); }

}  // namespace

const std::array<P2, kAnchors>& palm_anchors() {
  static const std::array<P2, kAnchors> anchors = [] {
    std::array<P2, kAnchors> a{};
    std::size_t k = 0;
    // (grid, anchors per cell): stride 8 → 24², 2 each; stride 16 → 12², 6 each (three layers × 2).
    constexpr std::array<std::array<int, 2>, 2> layers{{{24, 2}, {12, 6}}};
    for (const auto& [grid, per] : layers) {
      for (int y = 0; y < grid; ++y) {
        for (int x = 0; x < grid; ++x) {
          for (int i = 0; i < per; ++i) {
            a[k++] = {(x + 0.5) / grid, (y + 0.5) / grid};
          }
        }
      }
    }
    return a;
  }();
  return anchors;
}

Letterbox palm_input(const ImageView& frame, bool planar) {
  Letterbox lb;
  lb.input.assign(static_cast<std::size_t>(kPalmInput) * kPalmInput * 3, 0.0f);
  if (frame.width <= 0 || frame.height <= 0 || frame.data == nullptr) return lb;
  lb.ratio = std::min(static_cast<double>(kPalmInput) / frame.width, static_cast<double>(kPalmInput) / frame.height);
  lb.padX = (kPalmInput - frame.width * lb.ratio) / 2;
  lb.padY = (kPalmInput - frame.height * lb.ratio) / 2;
  // Each input pixel is the average of a few frame samples when the frame is
  // much larger (a 1280-wide frame is 6.7 frame px per input px): a single
  // bilinear tap would alias, and the detector was trained on area-resized input.
  const int taps = std::clamp(static_cast<int>(std::ceil(1.0 / lb.ratio / 2.0)), 1, 4);
  for (int v = 0; v < kPalmInput; ++v) {
    for (int u = 0; u < kPalmInput; ++u) {
      double acc[3] = {0, 0, 0};
      for (int j = 0; j < taps; ++j) {
        for (int i = 0; i < taps; ++i) {
          const double ix = u + (i + 0.5) / taps;
          const double iy = v + (j + 0.5) / taps;
          float r = 0;
          float g = 0;
          float b = 0;
          sample(frame, (ix - lb.padX) / lb.ratio, (iy - lb.padY) / lb.ratio, r, g, b);
          acc[0] += r;
          acc[1] += g;
          acc[2] += b;
        }
      }
      const double n = static_cast<double>(taps) * taps;
      put(lb.input, kPalmInput, u, v, planar, static_cast<float>(acc[0] / n), static_cast<float>(acc[1] / n), static_cast<float>(acc[2] / n));
    }
  }
  return lb;
}

double iou(P2 aMin, P2 aMax, P2 bMin, P2 bMax) noexcept {
  const double ix = std::max(0.0, std::min(aMax.x, bMax.x) - std::max(aMin.x, bMin.x));
  const double iy = std::max(0.0, std::min(aMax.y, bMax.y) - std::max(aMin.y, bMin.y));
  const double inter = ix * iy;
  const double ua = (aMax.x - aMin.x) * (aMax.y - aMin.y) + (bMax.x - bMin.x) * (bMax.y - bMin.y) - inter;
  return ua > 0 ? inter / ua : 0;
}

std::vector<Palm> decode_palms(std::span<const float> regressors, std::span<const float> scores, const Letterbox& lb,
                               const PalmDecodeOptions& opts) {
  std::vector<Palm> found;
  if (regressors.size() < kAnchors * 18 || scores.size() < kAnchors || lb.ratio <= 0) return found;
  const auto& anchors = palm_anchors();
  // Input px (0…192) → frame px.
  const auto toFrame = [&](double ix, double iy) { return P2{(ix - lb.padX) / lb.ratio, (iy - lb.padY) / lb.ratio}; };
  std::vector<Palm> cand;
  for (std::size_t i = 0; i < kAnchors; ++i) {
    const double s = sigmoid(static_cast<double>(scores[i]));
    if (s < opts.scoreThreshold) continue;
    const float* r = regressors.data() + i * 18;
    const P2 a = anchors[i];
    const double cx = r[0] + a.x * kPalmInput;
    const double cy = r[1] + a.y * kPalmInput;
    const double hw = r[2] / 2.0;
    const double hh = r[3] / 2.0;
    Palm p;
    p.boxMin = toFrame(cx - hw, cy - hh);
    p.boxMax = toFrame(cx + hw, cy + hh);
    for (std::size_t k = 0; k < 7; ++k) {
      p.keypoints[k] = toFrame(r[4 + 2 * k] + a.x * kPalmInput, r[5 + 2 * k] + a.y * kPalmInput);
    }
    p.score = s;
    cand.push_back(p);
  }
  // Best first; equal scores keep anchor order (stable), so the result is deterministic.
  std::stable_sort(cand.begin(), cand.end(), [](const Palm& a, const Palm& b) { return a.score > b.score; });
  for (const Palm& c : cand) {
    bool keep = true;
    for (const Palm& k : found) {
      if (iou(c.boxMin, c.boxMax, k.boxMin, k.boxMax) > opts.nmsThreshold) {
        keep = false;
        break;
      }
    }
    if (!keep) continue;
    found.push_back(c);
    if (found.size() >= opts.maxPalms) break;
  }
  return found;
}

Roi roi_from_palm(const Palm& palm) {
  const P2 wrist = palm.keypoints[0];
  const P2 middle = palm.keypoints[2];
  // The turn that makes wrist → middle base point up (y down): 0 when it already does.
  double angle = std::atan2(middle.x - wrist.x, -(middle.y - wrist.y));
  angle -= 2 * kPi * std::floor((angle + kPi) / (2 * kPi));
  const P2 c0{(palm.boxMin.x + palm.boxMax.x) / 2, (palm.boxMin.y + palm.boxMax.y) / 2};
  // The keypoints in the hand's own upright frame, around c0.
  P2 lo{1e300, 1e300};
  P2 hi{-1e300, -1e300};
  for (const P2& k : palm.keypoints) {
    const P2 l = rotate({k.x - c0.x, k.y - c0.y}, -angle);
    lo = {std::min(lo.x, l.x), std::min(lo.y, l.y)};
    hi = {std::max(hi.x, l.x), std::max(hi.y, l.y)};
  }
  const double w = hi.x - lo.x;
  const double h = hi.y - lo.y;
  // Shifted 0.4 of the height toward the fingers, grown 3× (OpenCV Zoo's constants for these exports).
  const P2 centreLocal{(lo.x + hi.x) / 2, (lo.y + hi.y) / 2 - 0.4 * h};
  const P2 off = rotate(centreLocal, angle);
  Roi roi;
  roi.centre = {c0.x + off.x, c0.y + off.y};
  roi.side = std::max(w, h) * 3.0;
  roi.angle = angle;
  return roi;
}

Roi roi_from_landmarks(std::span<const P2> landmarks) {
  Palm p;
  if (landmarks.size() < kHandLandmarks) return {};
  P2 lo{1e300, 1e300};
  P2 hi{-1e300, -1e300};
  for (std::size_t k = 0; k < kPalmLandmarks.size(); ++k) {
    const P2 q = landmarks[kPalmLandmarks[k]];
    p.keypoints[k] = q;
    lo = {std::min(lo.x, q.x), std::min(lo.y, q.y)};
    hi = {std::max(hi.x, q.x), std::max(hi.y, q.y)};
  }
  p.boxMin = lo;
  p.boxMax = hi;
  return roi_from_palm(p);
}

P2 hand_crop_to_frame(const Roi& roi, P2 c) noexcept {
  const double k = roi.side / kHandInput;
  const P2 l = rotate({(c.x - kHandInput / 2.0) * k, (c.y - kHandInput / 2.0) * k}, roi.angle);
  return {roi.centre.x + l.x, roi.centre.y + l.y};
}

std::vector<float> hand_input(const ImageView& frame, const Roi& roi, bool planar) {
  std::vector<float> out(static_cast<std::size_t>(kHandInput) * kHandInput * 3, 0.0f);
  if (frame.data == nullptr || roi.side <= 0) return out;
  // Area-like downscale: a few taps per crop pixel when the hand is large on screen.
  const int taps = std::clamp(static_cast<int>(std::ceil(roi.side / kHandInput / 2.0)), 1, 4);
  for (int v = 0; v < kHandInput; ++v) {
    for (int u = 0; u < kHandInput; ++u) {
      double acc[3] = {0, 0, 0};
      for (int j = 0; j < taps; ++j) {
        for (int i = 0; i < taps; ++i) {
          const P2 f = hand_crop_to_frame(roi, {u + (i + 0.5) / taps, v + (j + 0.5) / taps});
          float r = 0;
          float g = 0;
          float b = 0;
          sample(frame, f.x, f.y, r, g, b);
          acc[0] += r;
          acc[1] += g;
          acc[2] += b;
        }
      }
      const double n = static_cast<double>(taps) * taps;
      put(out, kHandInput, u, v, planar, static_cast<float>(acc[0] / n), static_cast<float>(acc[1] / n), static_cast<float>(acc[2] / n));
    }
  }
  return out;
}

Hand decode_hand(std::span<const float> screen, std::span<const float> world, double presence, double handedness, const Roi& roi) {
  Hand h;
  h.presence = presence;
  h.handedness = handedness;
  h.roi = roi;
  const double k = roi.side / kHandInput;
  for (std::size_t i = 0; i < kHandLandmarks; ++i) {
    if (screen.size() >= (i + 1) * 3) {
      h.landmarks[i] = hand_crop_to_frame(roi, {screen[i * 3], screen[i * 3 + 1]});
      h.depth[i] = screen[i * 3 + 2] * k;
    }
    if (world.size() >= (i + 1) * 3) {
      // World points are metric and model-upright: turn them like the crop so
      // x / y agree with the frame's directions.
      const P2 w = rotate({world[i * 3], world[i * 3 + 1]}, roi.angle);
      h.world[i] = {w.x, w.y, world[i * 3 + 2]};
    }
  }
  return h;
}

double pinch_ratio(const Hand& h) noexcept {
  const auto d = [&](Landmark a, Landmark b) {
    const P2 p = h.landmarks[static_cast<std::size_t>(a)];
    const P2 q = h.landmarks[static_cast<std::size_t>(b)];
    return std::hypot(p.x - q.x, p.y - q.y);
  };
  const double palm = d(Landmark::Wrist, Landmark::MiddleMcp);
  return palm > 1e-9 ? d(Landmark::ThumbTip, Landmark::IndexTip) / palm : 0;
}

}  // namespace premation::live
