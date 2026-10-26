// Hands across frames — see hand_tracker.hpp.
#include "hand_tracker.hpp"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>

namespace premation::live {

namespace {

double ms_since(std::chrono::steady_clock::time_point t0) {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
}

bool contains(const std::string& s, const char* part) {
  std::string l = s;
  std::transform(l.begin(), l.end(), l.begin(), [](char c) { return static_cast<char>(std::tolower(static_cast<unsigned char>(c))); });
  return l.find(part) != std::string::npos;
}

/// A landmark crop's box in frame px (axis-aligned bound of the turned square), for de-duplication.
void roi_box(const Roi& r, P2& lo, P2& hi) {
  const double h = r.side / 2 * (std::abs(std::cos(r.angle)) + std::abs(std::sin(r.angle)));
  lo = {r.centre.x - h, r.centre.y - h};
  hi = {r.centre.x + h, r.centre.y + h};
}

}  // namespace

HandOutputs identify_hand_outputs(const std::vector<TensorOut>& outs) {
  HandOutputs o;
  std::vector<int> sixtyThree;
  std::vector<int> scalars;
  for (std::size_t i = 0; i < outs.size(); ++i) {
    const auto n = outs[i].data.size();
    if (n == kHandLandmarks * 3) sixtyThree.push_back(static_cast<int>(i));
    else if (n == 1) scalars.push_back(static_cast<int>(i));
  }
  // Names first ("world", "handedness" / "hand_flag", "score" / "presence"), then model order:
  // the MediaPipe export lists landmarks, presence, handedness, world landmarks.
  for (int i : sixtyThree) {
    if (contains(outs[static_cast<std::size_t>(i)].name, "world")) o.world = i;
  }
  for (int i : sixtyThree) {
    if (i != o.world && o.screen < 0) o.screen = i;
  }
  if (o.world < 0 && sixtyThree.size() > 1) o.world = sixtyThree[1];
  for (int i : scalars) {
    const std::string& nm = outs[static_cast<std::size_t>(i)].name;
    if (contains(nm, "handed") || contains(nm, "flag_l") || contains(nm, "left")) o.handedness = i;
    else if (contains(nm, "presence") || contains(nm, "score") || contains(nm, "conf") || contains(nm, "flag")) o.presence = i;
  }
  for (int i : scalars) {
    if (i == o.handedness || i == o.presence) continue;
    if (o.presence < 0) o.presence = i;
    else if (o.handedness < 0) o.handedness = i;
  }
  return o;
}

HandTracker::HandTracker(Model& palm, Model& hand, TrackerOptions opts) : palm_(palm), hand_(hand), opts_(opts) {}

TrackerResult HandTracker::process(const ImageView& frame) {
  TrackerResult res;
  ++frame_;
  std::vector<Roi> rois = held_;
  const bool want = held_.size() < opts_.maxHands &&
                    (held_.empty() || opts_.redetectEvery <= 1 || frame_ % static_cast<std::uint64_t>(opts_.redetectEvery) == 0);
  if (want) {
    res.timings.ranPalm = true;
    auto t0 = std::chrono::steady_clock::now();
    const Letterbox lb = palm_input(frame, palm_.planar());
    res.timings.palmPrepMs = ms_since(t0);
    t0 = std::chrono::steady_clock::now();
    if (!palm_.run(lb.input, scratch_, res.error)) return res;
    res.timings.palmMs = ms_since(t0);
    std::span<const float> reg;
    std::span<const float> sc;
    for (const TensorOut& t : scratch_) {
      if (t.data.size() == kAnchors * 18) reg = t.data;
      else if (t.data.size() == kAnchors) sc = t.data;
    }
    PalmDecodeOptions po = opts_.palm;
    po.maxPalms = opts_.maxHands;
    for (const Palm& p : decode_palms(reg, sc, lb, po)) {
      const Roi r = roi_from_palm(p);
      // A detection where a hand is already held is that hand.
      P2 lo;
      P2 hi;
      roi_box(r, lo, hi);
      bool dup = false;
      for (const Roi& h : held_) {
        P2 hlo;
        P2 hhi;
        roi_box(h, hlo, hhi);
        if (iou(lo, hi, hlo, hhi) > 0.3) dup = true;
      }
      if (!dup && rois.size() < opts_.maxHands) rois.push_back(r);
    }
  }
  held_.clear();
  for (const Roi& roi : rois) {
    auto t0 = std::chrono::steady_clock::now();
    const std::vector<float> input = hand_input(frame, roi, hand_.planar());
    res.timings.handPrepMs += ms_since(t0);
    t0 = std::chrono::steady_clock::now();
    if (!hand_.run(input, scratch_, res.error)) break;
    res.timings.handMs += ms_since(t0);
    ++res.timings.landmarkRuns;
    if (!outsKnown_) {
      outs_ = identify_hand_outputs(scratch_);
      outsKnown_ = true;
    }
    if (outs_.screen < 0) {
      res.error = "the hand model has no 21-point landmark output";
      break;
    }
    const auto scalar = [&](int i, double fallback) {
      return i >= 0 && !scratch_[static_cast<std::size_t>(i)].data.empty() ? static_cast<double>(scratch_[static_cast<std::size_t>(i)].data[0]) : fallback;
    };
    double presence = scalar(outs_.presence, 1.0);
    if (presence < 0 || presence > 1) presence = 1.0 / (1.0 + std::exp(-presence));  // a logit
    if (presence < opts_.presenceThreshold) continue;
    const std::span<const float> world = outs_.world >= 0 ? std::span<const float>(scratch_[static_cast<std::size_t>(outs_.world)].data)
                                                          : std::span<const float>{};
    Hand h = decode_hand(scratch_[static_cast<std::size_t>(outs_.screen)].data, world, presence, scalar(outs_.handedness, 0.5), roi);
    // Two crops that converged on one hand: keep the first.
    P2 lo;
    P2 hi;
    const Roi next = roi_from_landmarks(h.landmarks);
    roi_box(next, lo, hi);
    bool dup = false;
    for (const Roi& k : held_) {
      P2 klo;
      P2 khi;
      roi_box(k, klo, khi);
      if (iou(lo, hi, klo, khi) > 0.5) dup = true;
    }
    if (dup) continue;
    held_.push_back(next);
    res.hands.push_back(h);
  }
  return res;
}

}  // namespace premation::live
