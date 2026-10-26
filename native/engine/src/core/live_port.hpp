// Live performance input as the Session sees it (docs/PERFORMANCE_ANIMATION_PLAN.md
// P1): start / stop, the cameras, and the newest tracked frame. The
// implementation (live/live_host.cpp) runs the camera and the hand model in
// a CHILD engine process and lives outside engine_core; a Session without one
// (the headless engine, tests) answers `unsupported`.
//
// Editor input, like the pointer: nothing here is the document, nothing is
// undoable. Threads: every call comes from the core thread; the
// implementation's reader thread only fills what `take` hands over.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "engine_api.hpp"

namespace premation {

struct LiveStart {
  std::string camera;
  std::string modelDir;
  std::uint32_t width = 640;
  double fps = 60;
  std::uint32_t maxHands = 2;
};

class LivePort {
 public:
  LivePort() = default;
  virtual ~LivePort() = default;
  LivePort(const LivePort&) = delete;
  LivePort& operator=(const LivePort&) = delete;
  LivePort(LivePort&&) = delete;
  LivePort& operator=(LivePort&&) = delete;

  /// Start (or restart) live input; the outcome arrives through `take` (starting → running | failed).
  virtual void start(const LiveStart& s) = 0;
  /// Stop and release the camera. Idempotent.
  virtual void stop() = 0;
  /// True while live input may still produce something for `take` (starting or running).
  [[nodiscard]] virtual bool active() const = 0;
  /// The newest state + frame, when it changed since the last take.
  virtual bool take(api::LiveInputEvent& out) = 0;
  /// The cameras this platform can open. Throws doc::EngineFail `unsupported` where there is no capture.
  [[nodiscard]] virtual std::vector<api::CameraInfo> cameras() = 0;
};

}  // namespace premation
