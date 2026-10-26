// The engine side of live input (live/live_host.cpp) over a fake child
// (live_fake_child.cpp): starting → running with hands, stop → stopped, a
// child that dies → failed with words for the user, a missing model → failed
// before anything starts. No camera, no model.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <thread>

#include "live_host.hpp"

using namespace premation;
using Catch::Approx;

namespace {

/// A model folder with both (empty) model files — resolve_model_dir only checks they exist.
std::string fake_model_dir() {
  const auto dir = std::filesystem::temp_directory_path() / "premation-live-test-models";
  std::filesystem::create_directories(dir);
  std::ofstream(dir / live::kPalmModelFile) << "x";
  std::ofstream(dir / live::kHandModelFile) << "x";
  return dir.string();
}

/// Take events until `pred` holds for one, or 5 s pass.
template <class Pred>
bool wait_for(LivePort& p, api::LiveInputEvent& ev, Pred pred) {
  const auto until = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (std::chrono::steady_clock::now() < until) {
    if (p.take(ev) && pred(ev)) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  return false;
}

LiveStart start_with(const char* scenario) {
  LiveStart s;
  s.camera = scenario;
  s.modelDir = fake_model_dir();
  return s;
}

}  // namespace

TEST_CASE("live host: starting, then running with the child's hands, then stopped") {
  auto host = live::make_live_host(PREMATION_LIVE_FAKE_CHILD);
  host->start(start_with("ok"));
  CHECK(host->active());
  api::LiveInputEvent ev;
  REQUIRE(wait_for(*host, ev, [](const api::LiveInputEvent& e) { return !e.hands.empty(); }));
  CHECK(ev.state == api::LiveInputState::running);
  CHECK(ev.camera == "Fake Cam");
  CHECK(ev.width == 640);
  CHECK(ev.fps == Approx(30));
  CHECK(ev.latency_ms == Approx(42.5));
  REQUIRE(ev.hands.size() == 1);
  CHECK(ev.hands[0].landmarks.size() == 63);
  CHECK(ev.hands[0].landmarks[0] == Approx(0.5));
  CHECK(ev.hands[0].pinch == Approx(0.12));
  CHECK(ev.hands[0].handedness == Approx(0.8));
  host->stop();
  REQUIRE(host->take(ev));
  CHECK(ev.state == api::LiveInputState::stopped);
  CHECK(ev.hands.empty());
  CHECK_FALSE(host->active());
}

TEST_CASE("live host: a child that dies is `failed`, in words, and the host survives") {
  auto host = live::make_live_host(PREMATION_LIVE_FAKE_CHILD);
  host->start(start_with("crash"));
  api::LiveInputEvent ev;
  REQUIRE(wait_for(*host, ev, [](const api::LiveInputEvent& e) { return e.state == api::LiveInputState::failed; }));
  CHECK(ev.message.find("stopped unexpectedly") != std::string::npos);
  // It can be started again.
  host->start(start_with("ok"));
  REQUIRE(wait_for(*host, ev, [](const api::LiveInputEvent& e) { return e.state == api::LiveInputState::running; }));
  host->stop();
}

TEST_CASE("live host: the child's own error is passed on") {
  auto host = live::make_live_host(PREMATION_LIVE_FAKE_CHILD);
  host->start(start_with("error"));
  api::LiveInputEvent ev;
  REQUIRE(wait_for(*host, ev, [](const api::LiveInputEvent& e) { return e.state == api::LiveInputState::failed; }));
  CHECK(ev.message == "The camera could not be opened: busy");
  host->stop();
}

TEST_CASE("live host: no model installed fails at once, naming where to install it") {
  auto host = live::make_live_host(PREMATION_LIVE_FAKE_CHILD);
  LiveStart s;
  s.modelDir = (std::filesystem::temp_directory_path() / "premation-live-test-no-models").string();
  host->start(s);
  api::LiveInputEvent ev;
  REQUIRE(host->take(ev));
  CHECK(ev.state == api::LiveInputState::failed);
  CHECK(ev.message.find("Settings") != std::string::npos);
}
