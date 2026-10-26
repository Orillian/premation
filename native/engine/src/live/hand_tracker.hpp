// Hands across frames (P1): the palm detector finds them, the landmarker
// follows them (hand_pipeline.hpp). The detector runs only while fewer hands
// are held than asked for — every frame when none is, every `redetectEvery`
// frames when one of two is — because it is the expensive half.
//
// The models come in through hand_ort.hpp's interface, so this file holds no
// ORT and the tests drive it with fake models.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "hand_ort.hpp"
#include "hand_pipeline.hpp"

namespace premation::live {

struct TrackerOptions {
  std::size_t maxHands = 2;
  /// Below this presence a held hand is lost (the detector looks again next frame).
  double presenceThreshold = 0.5;
  PalmDecodeOptions palm;
  /// With some but fewer than `maxHands` held, the detector runs on every Nth frame.
  int redetectEvery = 10;
};

/// Where one frame's time went, ms.
struct TrackerTimings {
  double palmPrepMs = 0;
  double palmMs = 0;
  double handPrepMs = 0;
  double handMs = 0;
  bool ranPalm = false;
  std::size_t landmarkRuns = 0;
};

struct TrackerResult {
  std::vector<Hand> hands;
  TrackerTimings timings;
  /// A model failed this frame (the message); hands found before it are kept.
  std::string error;
};

/// Which output of the landmarker is which — found once from the names and sizes.
struct HandOutputs {
  int screen = -1;
  int world = -1;
  int presence = -1;
  int handedness = -1;
};
[[nodiscard]] HandOutputs identify_hand_outputs(const std::vector<TensorOut>& outs);

class HandTracker {
 public:
  HandTracker(Model& palm, Model& hand, TrackerOptions opts = {});
  [[nodiscard]] TrackerResult process(const ImageView& frame);
  /// Forget held hands (the next frame detects from scratch).
  void reset() { held_.clear(); }

 private:
  Model& palm_;
  Model& hand_;
  TrackerOptions opts_;
  std::vector<Roi> held_;
  std::uint64_t frame_ = 0;
  HandOutputs outs_;
  bool outsKnown_ = false;
  std::vector<TensorOut> scratch_;
};

}  // namespace premation::live
