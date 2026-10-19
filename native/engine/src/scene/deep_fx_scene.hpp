// Program X batch 4 (docs/PROGRAM_DEEP_EFFECTS.md): the 3D-aware deep effects
// (Volumetric Lights, Relight, Volumetric Clouds, Starfield, CC Environment,
// Ocean, Aurora, 3D Stroke) see the frame's camera and the comp's lights. The
// walk hands them over at resolve time as hidden params (as Lens Flare's
// linked light, snapshot_build.cpp):
//
//   __camera  [eye x y z, focal, principal x y, R (world → view, 9 row-major),
//              comp width, height] — comp px; AE's default camera when the comp
//              has none. A comp px (sx, sy) looks along R^T ((sx − px) / f,
//              (sy − py) / f, 1) from the eye.
//   __lights  per light (at most 8; the environment rig's CPU-only lights
//             left out) 16 numbers: [type (0 ambient 1 parallel 2 point 3 spot),
//             position x y z, colour (linear) r g b, intensity (1 = 100 %),
//             aim x y z, cone half angle (rad), feather 0..1, falloff (0 none
//             1 smooth 2 inverse square), falloff distance].
#pragma once

#include <optional>
#include <vector>

#include "lights3d.hpp"
#include "scene_types.hpp"
#include "transform.hpp"

namespace premation::scene {

/// Whether a deep effect type reads `__camera` / `__lights`.
[[nodiscard]] bool deep_effect_reads_scene(std::string_view type);

/// Sets `__camera` / `__lights` on every resolved deep effect that reads them.
void inject_deep_scene(std::vector<Json>& resolved, const std::optional<motion::xf::Camera>& camera,
                       const std::vector<SceneLight>* lights, double compWidth, double compHeight);

// ── Program X1: time taps ────────────────────────────────────────────────────
// A temporal deep effect (Timewarp, Pixel Motion Blur, Time Displacement, ...)
// reads its layer's CONTENT at other times — AE's time effects work in layer
// space, so a tap is the layer built at that time (footage frame, precomp
// time, animated shape / text) and placed where the layer is now. The walk
// builds each tap (an isolated snapshot at t + dt, its own taps off) and emits
// it hidden (a matte source: drawn only when the chain reads it).

struct TimeTap {
  std::string id;  ///< `<layer>__tt_<effect id>_<k>`
  double dt = 0;   ///< seconds from now
};
/// The comp frame rate and the layer time the walk hands temporal deep
/// effects (`__fps`, `__time`).
void inject_deep_fps(std::vector<Json>& resolved, double fps, std::optional<double> layerTime);
/// A temporal deep effect's tap offsets (seconds from now, at most 4), from its
/// resolved params (`__fps`, `time`, ...). Empty for any other effect.
[[nodiscard]] std::vector<double> deep_effect_time_offsets(const Json& effect);
[[nodiscard]] std::string time_tap_id(std::string_view layerId, std::string_view effectId, std::size_t k);
/// Every tap the layer's enabled temporal deep effects read.
[[nodiscard]] std::vector<TimeTap> deep_time_taps(const RLayer& l);
/// The tap layer: `at` (the layer as built at the tap's time) placed where `now`
/// is, without its effects, hidden.
[[nodiscard]] RLayer time_tap_layer(RLayer at, const RLayer& now, std::string id);

}  // namespace premation::scene
