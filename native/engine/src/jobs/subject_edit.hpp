// The subject's soft matte, edited one frame at a time (the Object Matte tool
// group: Object Matte click / marquee, Quick Selection, Selection Brush,
// Refine Edge). Pure: alpha planes are floats in [0, 1], rows top-down,
// pictures straight RGBA8; no model, no document, no files.
//
//   sample_stroke      a brush stroke as the few prompts SAM was trained on
//                      (its arc-length samples, 3–6 of them) — a dense chain
//                      of points is out of distribution and comes back as a
//                      blob of floor and background, or nothing;
//   choose_candidate   which of the decoder's three masks the prompts mean:
//                      SAM's own score plus how much of the prompts it
//                      covers, less how much of the frame's edge it runs
//                      along (backgrounds do, subjects rarely); a lone click
//                      prefers the whole object, a subtracting prompt the
//                      smallest thing under it;
//   keep_touching      only the regions the prompts touch survive (a stray
//                      island elsewhere in the frame is not "this person");
//   paint              the brush's own footprint, anti-aliased (Selection
//                      Brush: no snapping);
//   refine_band        soft alpha inside a painted band, from the colours of
//                      the sure foreground and sure background nearby
//                      (Refine Edge: hair, fur);
//   combine            replace / add / subtract against the frame's matte.
//
// Deterministic.
#pragma once

#include <cstdint>
#include <optional>
#include <span>
#include <vector>

#include "sam_pipeline.hpp"

namespace premation::jobs::subject {

enum class Op { replace, add, subtract };

struct Pt {
  double x = 0;
  double y = 0;
};

/// A stroke as at most `maxPoints` points spread evenly along its length (its ends included).
[[nodiscard]] std::vector<Pt> sample_stroke(std::span<const Pt> stroke, std::size_t maxPoints);

/// What the prompts are for: a lone click (no stroke, no box) wants the whole object under it.
struct Intent {
  bool loneClick = false;
  bool subtract = false;
};

/// How one decoder candidate reads against the prompts (choose_candidate's inputs; the job reports them).
struct CandidateScore {
  double iou = 0;      ///< the decoder's own estimate
  double fgCover = 0;  ///< share of the foreground prompts inside it
  double bgHit = 0;    ///< share of the background prompts inside it
  double area = 0;     ///< share of the 256² grid it covers
  double border = 0;   ///< share of the frame's edge it runs along
  int edges = 0;       ///< how many of the frame's four edges it runs along (> 10 % of that edge)
};
[[nodiscard]] std::vector<CandidateScore> score_candidates(std::span<const float> iouScores, std::span<const float> logits,
                                                          std::span<const sam::Point> prompts, double scale, std::uint32_t width,
                                                          std::uint32_t height);

/// The decoder candidate (0…n−1) the prompts mean. `logits` holds n planes of
/// sam::kMaskSize², in the letterboxed frame (point coords × `scale` / 4) of a
/// `width`×`height` frame; prompts in frame px. A candidate that runs along the
/// frame's edges is background-like (a wall, the floor, the sky): it loses.
[[nodiscard]] std::size_t choose_candidate(std::span<const float> iouScores, std::span<const float> logits, std::span<const sam::Point> prompts,
                                           double scale, Intent intent, std::uint32_t width, std::uint32_t height);

/// Zero every region of `alpha` (connected above 0.5) that no seed (frame px) falls in
/// and that does not lie mostly inside `box`; soft edges within 3 px of a kept region stay.
void keep_touching(std::vector<float>& alpha, int width, int height, std::span<const Pt> seeds, const std::optional<sam::Box>& box);

/// The strokes' footprint at brush radius `radius` px, anti-aliased (1 inside, 0 outside).
[[nodiscard]] std::vector<float> paint(int width, int height, std::span<const std::vector<Pt>> strokes, double radius);

/// Refine Edge: inside `band` (0…1), alpha estimated per pixel from the mean colours of
/// the sure foreground (base > 0.95) and sure background (base < 0.05) around it, then
/// blended into `base` by the band. Pixels where the two colours are alike keep `base`.
[[nodiscard]] std::vector<float> refine_band(std::span<const std::uint8_t> rgba, int width, int height, std::span<const float> base,
                                             std::span<const float> band, double radius);

/// What a subtract takes away: the segmentation made firm (its soft fringe counts as
/// inside) and grown by `growPx` — taking a thing away must not leave its outline behind.
void harden_for_subtract(std::vector<float>& delta, int width, int height, int growPx);

/// `base` edited by `delta`: replace = delta; add = max; subtract = base × (1 − delta).
[[nodiscard]] std::vector<float> combine(std::span<const float> base, std::span<const float> delta, Op op);

/// A plane resampled to another size (bilinear); used for a stored matte of another size.
[[nodiscard]] std::vector<float> resample(std::span<const float> plane, int fromW, int fromH, int toW, int toH);

}  // namespace premation::jobs::subject
