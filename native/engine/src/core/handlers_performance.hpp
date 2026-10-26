// Edit handlers: performance takes (docs/PERFORMANCE_ANIMATION_PLAN.md §4.1,
// decision D5) — a recorded take kept on its layer as source material, so
// the Detail control can re-fit it after save / reopen and undo.
//
// Stored on the layer's `fx.performanceTakes`, an object keyed by the API
// path of the property the take drives:
//
//   { "<path>": { source, dims, times: [...], values: [...],
//                 fit: {reduction, detail, captureSpeedPct, wholeFrames,
//                       holdSeconds, frameDuration, spatial},
//                 span: [start, end] } }
//
// Times and the span are on the layer's OWN time axis (keyframe seconds), as
// the saved trackers are, so retiming the layer keeps the take on its frames;
// the API speaks composition time. Never rendered: only the keys are.
#pragma once

#include <string_view>

#include "handlers_common.hpp"

namespace premation::doc {

/// The most samples one take may hold: 10 minutes at 60 Hz.
inline constexpr std::size_t kMaxPerformanceTakeSamples = 36'000;

ResultOf<api::SetPerformanceTake> handle(const api::SetPerformanceTake& c, HCtx& x);
ResultOf<api::ClearPerformanceTakes> handle(const api::ClearPerformanceTakes& c, HCtx& x);

/// The layer's stored takes, times and spans in composition time. A record that does not parse is skipped.
[[nodiscard]] api::PerformanceTakes performance_takes(const Document& d, const EditorView& view, std::string_view layer);

}  // namespace premation::doc
