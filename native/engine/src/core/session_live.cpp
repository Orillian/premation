// Session: live performance input (97_live.eapi; docs/PERFORMANCE_ANIMATION_PLAN.md
// P1) — startLiveInput / stopLiveInput / listCameras and the `liveInput`
// events. Editor input: never the document, never history.
#include <algorithm>
#include <chrono>

#include "fail.hpp"
#include "live_port.hpp"
#include "session.hpp"
#include "variant_util.hpp"

namespace premation {

using api::ErrorCode;
using doc::fail;

api::CommandResult Session::start_live(const api::StartLiveInput& c) {
  if (live_ == nullptr) fail(ErrorCode::unsupported, "live input is not available in this engine build");
  LiveStart s;
  s.camera = c.camera;
  s.modelDir = c.model_dir;
  s.width = c.width > 0 ? c.width : 640;
  s.fps = c.fps > 0 ? c.fps : 60;
  s.maxHands = std::clamp<std::uint32_t>(c.max_hands > 0 ? c.max_hands : 2, 1, 2);
  live_->start(s);
  poll_live();  // `starting` goes out with the answer, not a poll later
  return result_for<api::StartLiveInput>();
}

api::CommandResult Session::stop_live() {
  if (live_ != nullptr) {
    live_->stop();
    poll_live();
  }
  return result_for<api::StopLiveInput>();
}

api::QueryResult Session::list_cameras() {
  if (live_ == nullptr) fail(ErrorCode::unsupported, "live input is not available in this engine build");
  return query_result_for<api::ListCameras>(api::CameraList{live_->cameras()});
}

void Session::poll_live() {
  if (live_ == nullptr || phase_ != Phase::open) return;
  api::LiveInputEvent ev;
  if (!live_->take(ev)) return;
  std::vector<api::Event> out;
  out.push_back(make_event(std::move(ev)));
  send_events(revision_, revision_, std::move(out), std::nullopt, api::Origin::engine);
}

}  // namespace premation
