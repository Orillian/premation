// Live performance input in two processes (docs/PERFORMANCE_ANIMATION_PLAN.md P1):
//
//   engine   LiveHost (core/live_port.hpp): starts the child, reads its lines
//            on a thread, hands the newest state / frame to the Session
//   child    `premation-engine --live FILE` (live_main): camera capture on its
//            own thread → newest frame → hand tracker → One Euro smoothing →
//            one JSON line per tracked frame on stdout
//
// A crash in the camera driver or the model ends the child only: the engine
// reports `failed` and keeps running. The child dies with the engine (a
// Windows job object; elsewhere its stdin closing), and with `stopLiveInput`.
//
// Child lines:
//   {"ev":"ready","camera":S,"width":N,"height":N,"fps":F}
//   {"ev":"hands","seq":N,"latencyMs":F,"hands":[{"lm":[63 numbers],"hd":F,"pr":F,"pi":F}…]}
//   {"ev":"error","message":S}
#pragma once

#include <memory>
#include <string>

#include "live_port.hpp"

namespace premation::live {

/// The engine side. `childExe` is the engine executable ('' = jobs::child_executable()).
[[nodiscard]] std::unique_ptr<LivePort> make_live_host(std::string childExe = {});

/// The child's main (`premation-engine --live FILE`). Returns the exit code.
int live_main(const std::string& configFile);

/// The model folder a start uses: `requested` when given, else the installed
/// models (PREMATION_HAND_USER_DIR), else the bundled ones (PREMATION_HAND_DIR).
/// '' when none of them holds both files.
[[nodiscard]] std::string resolve_model_dir(const std::string& requested);

inline constexpr const char* kPalmModelFile = "palm_detection.onnx";
inline constexpr const char* kHandModelFile = "hand_landmark.onnx";

}  // namespace premation::live
