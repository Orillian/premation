// Hand tracking's arithmetic (docs/PERFORMANCE_ANIMATION_PLAN.md P1) — no
// model, no camera, no OS. Pure and deterministic.
//
// The models are MediaPipe's two-stage hand pipeline (OpenCV Zoo exports,
// Apache-2.0):
//
//   palm detector   192² RGB in [0, 1] (letterboxed frame) → 2016 SSD anchors,
//                   each a box + 7 palm keypoints + a score logit
//   hand landmarker 224² RGB in [0, 1] (a square crop turned so the hand
//                   points up) → 21 landmarks (crop px, z relative to the
//                   wrist), a presence score, handedness, 21 world points
//
// The crop geometry is MediaPipe's own: the palm's keypoints set the angle
// (wrist → middle-finger base points up), the box is grown and shifted
// toward the fingers. Unlike the OpenCV Zoo demo it is NOT clipped to the
// frame — a crop past the edge samples black, so the hand stays centred in
// the crop near the border, which is what the model was trained on.
//
// Tracking (MediaPipe's): once a hand is found, the next frame's crop comes
// from this frame's landmarks and the palm detector does not run until the
// hand is lost — the detector is the expensive half.
#pragma once

#include <array>
#include <cstdint>
#include <span>
#include <vector>

namespace premation::live {

struct P2 {
  double x = 0;
  double y = 0;
};

inline constexpr int kPalmInput = 192;
inline constexpr int kHandInput = 224;
inline constexpr std::size_t kAnchors = 2016;
inline constexpr std::size_t kHandLandmarks = 21;

/// One frame as the camera delivers it: 8-bit BGRA rows (Media Foundation's RGB32).
struct ImageView {
  const std::uint8_t* data = nullptr;
  int width = 0;
  int height = 0;
  /// Bytes per row.
  int stride = 0;
};

/// The SSD anchor centres for the 192² palm detector, normalized 0…1: strides
/// 8 (24² cells × 2) and 16 (12² cells × 6), x fastest — 2016 in all.
[[nodiscard]] const std::array<P2, kAnchors>& palm_anchors();

/// The letterboxed palm-detector input (NHWC, or NCHW when `planar`) and the
/// mapping back: frame px = (input px − pad) / ratio.
struct Letterbox {
  std::vector<float> input;
  double ratio = 1;
  double padX = 0;
  double padY = 0;
};
[[nodiscard]] Letterbox palm_input(const ImageView& frame, bool planar);

/// A palm the detector found, frame px.
struct Palm {
  P2 boxMin;
  P2 boxMax;
  /// Wrist, index / middle / ring / pinky bases, thumb CMC, thumb MCP — MediaPipe's order.
  std::array<P2, 7> keypoints{};
  double score = 0;
};

struct PalmDecodeOptions {
  double scoreThreshold = 0.5;
  double nmsThreshold = 0.3;
  std::size_t maxPalms = 2;
};

/// The detector's raw outputs → palms (best first), non-maximum suppressed.
/// `regressors` is 2016 × 18, `scores` 2016 logits.
[[nodiscard]] std::vector<Palm> decode_palms(std::span<const float> regressors, std::span<const float> scores, const Letterbox& lb,
                                             const PalmDecodeOptions& opts = {});

/// A rotated square in frame px: centre, side, angle (radians; the crop's up is
/// the frame's up turned by `angle`, y down).
struct Roi {
  P2 centre;
  double side = 0;
  double angle = 0;
};

/// The landmarker's crop for a palm: angle from wrist → middle base, the
/// keypoints' box in the turned frame shifted 0.4 toward the fingers and grown 3×.
[[nodiscard]] Roi roi_from_palm(const Palm& palm);

/// The next frame's crop from this frame's landmarks (frame px): the same rule
/// over the palm subset of the landmarks (wrist, the four bases, the thumb's
/// first two joints), so a tracked hand and a detected one crop alike.
[[nodiscard]] Roi roi_from_landmarks(std::span<const P2> landmarks);

/// The landmarker input for `roi` (kHandInput² RGB in [0, 1], NHWC or NCHW). Outside the frame is black.
[[nodiscard]] std::vector<float> hand_input(const ImageView& frame, const Roi& roi, bool planar);

/// Crop px (0…kHandInput) → frame px.
[[nodiscard]] P2 hand_crop_to_frame(const Roi& roi, P2 c) noexcept;

/// One tracked hand, frame px.
struct Hand {
  std::array<P2, kHandLandmarks> landmarks{};
  /// Relative depth per landmark (frame-px scale, wrist = 0; negative = toward the camera).
  std::array<double, kHandLandmarks> depth{};
  /// Metric 3D points (m), origin near the hand's centre, from the world output.
  std::array<std::array<double, 3>, kHandLandmarks> world{};
  /// 0…1: is there a hand in the crop.
  double presence = 0;
  /// 0…1: the model's "right hand" (on a mirrored, selfie-view frame).
  double handedness = 0;
  Roi roi;
};

/// The landmarker's raw outputs for one crop → a hand in frame px.
/// `screen` and `world` are 63 values (21 × xyz).
[[nodiscard]] Hand decode_hand(std::span<const float> screen, std::span<const float> world, double presence, double handedness,
                               const Roi& roi);

/// MediaPipe's hand landmark names, in model order.
enum class Landmark : std::uint8_t {
  Wrist = 0,
  ThumbCmc, ThumbMcp, ThumbIp, ThumbTip,
  IndexMcp, IndexPip, IndexDip, IndexTip,
  MiddleMcp, MiddlePip, MiddleDip, MiddleTip,
  RingMcp, RingPip, RingDip, RingTip,
  PinkyMcp, PinkyPip, PinkyDip, PinkyTip,
};

/// Pinch: thumb tip to index tip, as a share of the palm's size (wrist → middle
/// base). ~0.1 pinched, ≥0.5 open; scale-free, so a near and a far hand agree.
[[nodiscard]] double pinch_ratio(const Hand& h) noexcept;

/// Intersection over union of two axis-aligned boxes (for NMS and tests).
[[nodiscard]] double iou(P2 aMin, P2 aMax, P2 bMin, P2 bMax) noexcept;

}  // namespace premation::live
