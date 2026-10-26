// premation-live-spike — P1.0 of docs/PERFORMANCE_ANIMATION_PLAN.md: how long
// from the sensor capturing a frame to the hand landmarks being ready, on this
// machine, with the engine's own camera capture and hand pipeline, arranged as
// the live-input service runs them: a capture thread hands the NEWEST frame to
// the tracker (frame_mailbox.hpp), so a slow frame is skipped, never queued.
//
//   premation-live-spike --list
//   premation-live-spike --palm palm.onnx --hand hand.onnx [--seconds 10]
//                        [--camera NAME-PART] [--width 640] [--fps 60]
//                        [--gpu] [--force-hand]
//
// Prints the models' inputs / outputs, the camera's formats and the one
// chosen, then one JSON summary — per-stage p50 / p95 / max in ms:
//   capture      between frames from the camera (1000 / camera fps)
//   tracked      between frames the tracker finished (1000 / tracking fps)
//   driver       sensor capture → frame in this process (the driver's delay,
//                its colour conversion and scaling included)
//   pipeline     frame in → landmarks ready (mailbox wait + prep + models)
//   total        sensor capture → landmarks ready
//   palm, hand   the two models' run times alone; prep: crops and letterbox
// `--force-hand` runs the landmarker on a centre crop whenever no hand is
// held, so its cost is measured with nobody in front of the camera.
// Nothing is saved; frames are dropped as soon as they are measured.
#include <algorithm>
#include <atomic>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

#include "camera.hpp"
#include "frame_mailbox.hpp"
#include "hand_ort.hpp"
#include "hand_tracker.hpp"

using namespace premation::live;

namespace {

struct Series {
  std::vector<double> v;
  void add(double x) { v.push_back(x); }
  [[nodiscard]] double pct(double p) const {
    if (v.empty()) return 0;
    std::vector<double> s = v;
    std::sort(s.begin(), s.end());
    const auto i = static_cast<std::size_t>(std::min(static_cast<double>(s.size() - 1), p * static_cast<double>(s.size() - 1) + 0.5));
    return s[i];
  }
  [[nodiscard]] std::string json() const {
    char buf[160];
    std::snprintf(buf, sizeof buf, "{\"n\":%zu,\"p50\":%.2f,\"p95\":%.2f,\"max\":%.2f}", v.size(), pct(0.5), pct(0.95), pct(1.0));
    return buf;
  }
};

const char* arg(int argc, char** argv, const char* name) {
  for (int i = 1; i + 1 < argc; ++i) {
    if (std::strcmp(argv[i], name) == 0) return argv[i + 1];
  }
  return nullptr;
}

bool has(int argc, char** argv, const char* name) {
  for (int i = 1; i < argc; ++i) {
    if (std::strcmp(argv[i], name) == 0) return true;
  }
  return false;
}

std::string lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](char c) { return static_cast<char>(std::tolower(static_cast<unsigned char>(c))); });
  return s;
}

}  // namespace

int main(int argc, char** argv) {
  std::string error;
  const std::vector<CameraDevice> cams = list_cameras(error);
  if (has(argc, argv, "--list")) {
    for (const CameraDevice& c : cams) std::printf("%s\n  %s\n", c.name.c_str(), c.id.c_str());
    if (!error.empty()) std::fprintf(stderr, "%s\n", error.c_str());
    return 0;
  }
  const char* palmPath = arg(argc, argv, "--palm");
  const char* handPath = arg(argc, argv, "--hand");
  if (palmPath == nullptr || handPath == nullptr) {
    std::fprintf(stderr, "usage: premation-live-spike --palm palm.onnx --hand hand.onnx [--seconds N] [--camera NAME] [--width W] [--fps F] [--gpu] [--force-hand]\n");
    return 2;
  }
  // CPU by default: the models are small, and a GPU provider pays an upload and a readback per run.
  const bool cpu = !has(argc, argv, "--gpu");
  auto palm = load_model(palmPath, cpu, error);
  if (!palm) {
    std::fprintf(stderr, "palm model: %s\n", error.c_str());
    return 1;
  }
  auto hand = load_model(handPath, cpu, error);
  if (!hand) {
    std::fprintf(stderr, "hand model: %s\n", error.c_str());
    return 1;
  }
  std::printf("palm model (%s, side %d, %s)\n%s", palm->provider().c_str(), palm->input_side(), palm->planar() ? "NCHW" : "NHWC", palm->describe().c_str());
  std::printf("hand model (%s, side %d, %s)\n%s", hand->provider().c_str(), hand->input_side(), hand->planar() ? "NCHW" : "NHWC", hand->describe().c_str());

  CameraRequest req;
  if (const char* w = arg(argc, argv, "--width")) req.width = std::atoi(w);
  if (const char* f = arg(argc, argv, "--fps")) req.fps = std::atof(f);
  if (const char* want = arg(argc, argv, "--camera")) {
    for (const CameraDevice& c : cams) {
      if (lower(c.name).find(lower(want)) != std::string::npos) req.id = c.id;
    }
  }
  auto cam = open_camera(req, error);
  if (!cam) {
    std::fprintf(stderr, "camera: %s\n", error.c_str());
    return 1;
  }
  std::printf("camera offers:\n");
  for (const std::string& s : cam->formats()) std::printf("  %s\n", s.c_str());
  std::printf("camera: %s, sensor %s @ %.2f fps, delivered %dx%d\n", cam->name().c_str(), cam->format().c_str(), cam->fps(), cam->width(),
              cam->height());
  std::fflush(stdout);

  const double seconds = arg(argc, argv, "--seconds") ? std::atof(arg(argc, argv, "--seconds")) : 10.0;
  const bool forceHand = has(argc, argv, "--force-hand");

  // The capture thread: read, stamp, hand over the newest. Never waits on the tracker.
  FrameMailbox mailbox;
  std::atomic<bool> stop{false};
  std::atomic<std::uint64_t> captured{0};
  Series capture;
  std::string captureError;
  std::thread capturer([&] {
    CameraFrame f;
    std::int64_t last = 0;
    while (!stop.load()) {
      if (!cam->read(f, captureError)) break;
      if (last != 0 && captured.load() > 15) capture.add(static_cast<double>(f.arrivalNs - last) / 1e6);
      last = f.arrivalNs;
      captured.fetch_add(1);
      mailbox.put(f);
    }
    mailbox.close();
  });

  HandTracker tracker(*palm, *hand);
  Series tracked, driver, pipeline, total, palmMs, handMs, prepMs;
  std::size_t frames = 0;
  std::size_t withHand = 0;
  std::size_t noDeviceTime = 0;
  CameraFrame f;
  std::int64_t lastReady = 0;
  std::vector<TensorOut> scratch;
  const std::int64_t start = now_ns();
  // The first frames of a stream carry start-up delay (exposure settling, buffers filling): not the steady state.
  constexpr std::size_t kWarmup = 15;
  while (now_ns() - start < static_cast<std::int64_t>(seconds * 1e9)) {
    if (!mailbox.take(f, std::chrono::milliseconds(1000))) {
      if (!captureError.empty()) break;
      continue;
    }
    ++frames;
    const ImageView view{f.bgra.data(), f.width, f.height, f.stride};
    TrackerResult r = tracker.process(view);
    double forcedMs = 0;
    if (forceHand && r.hands.empty()) {
      Roi centre;
      centre.centre = {f.width / 2.0, f.height / 2.0};
      centre.side = std::min(f.width, f.height) * 0.6;
      const std::vector<float> in = hand_input(view, centre, hand->planar());
      const std::int64_t t0 = now_ns();
      if (hand->run(in, scratch, error)) forcedMs = static_cast<double>(now_ns() - t0) / 1e6;
    }
    const std::int64_t ready = now_ns();
    if (!r.error.empty()) std::fprintf(stderr, "frame %zu: %s\n", frames, r.error.c_str());
    if (frames > kWarmup) {
      if (lastReady != 0) tracked.add(static_cast<double>(ready - lastReady) / 1e6);
      pipeline.add(static_cast<double>(ready - f.arrivalNs) / 1e6);
      if (f.captureNs != 0) {
        driver.add(static_cast<double>(f.arrivalNs - f.captureNs) / 1e6);
        total.add(static_cast<double>(ready - f.captureNs) / 1e6);
      } else {
        ++noDeviceTime;
      }
      if (r.timings.ranPalm) palmMs.add(r.timings.palmMs);
      if (r.timings.landmarkRuns > 0) handMs.add(r.timings.handMs / static_cast<double>(r.timings.landmarkRuns));
      else if (forcedMs > 0) handMs.add(forcedMs);
      prepMs.add(r.timings.palmPrepMs + r.timings.handPrepMs);
      if (!r.hands.empty()) ++withHand;
    }
    lastReady = ready;
  }
  stop.store(true);
  capturer.join();
  if (!captureError.empty()) std::fprintf(stderr, "camera: %s\n", captureError.c_str());
  std::printf(
      "{\"camera\":\"%s\",\"sensor\":\"%s\",\"delivered\":[%d,%d],\"fps\":%.2f,\"provider\":\"%s\",\"captured\":%llu,\"tracked\":%zu,"
      "\"dropped\":%llu,\"framesWithHand\":%zu,\"framesWithoutDriverTime\":%zu,\n \"capture\":%s,\n \"tracked\":%s,\n \"driver\":%s,\n"
      " \"pipeline\":%s,\n \"total\":%s,\n \"palm\":%s,\n \"hand\":%s,\n \"prep\":%s}\n",
      cam->name().c_str(), cam->format().c_str(), cam->width(), cam->height(), cam->fps(), palm->provider().c_str(),
      static_cast<unsigned long long>(captured.load()), frames, static_cast<unsigned long long>(mailbox.dropped()), withHand, noDeviceTime,
      capture.json().c_str(), tracked.json().c_str(), driver.json().c_str(), pipeline.json().c_str(), total.json().c_str(),
      palmMs.json().c_str(), handMs.json().c_str(), prepMs.json().c_str());
  return 0;
}
