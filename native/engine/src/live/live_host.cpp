// Live performance input in two processes — see live_host.hpp.
#include "live_host.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <sstream>
#include <thread>

#include "camera.hpp"
#include "child_job.hpp"
#include "child_process.hpp"
#include "fail.hpp"
#include "frame_mailbox.hpp"
#include "hand_ort.hpp"
#include "hand_tracker.hpp"
#include "json.hpp"
#include "log.hpp"
#include "one_euro.hpp"

namespace premation::live {

using api::ErrorCode;
using js::Json;

namespace {

std::filesystem::path u8path(const std::string& utf8) {
  return std::filesystem::path(std::u8string(reinterpret_cast<const char8_t*>(utf8.data()), utf8.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
}

std::string u8str(const std::filesystem::path& p) {
  const std::u8string u = p.u8string();
  return std::string(reinterpret_cast<const char*>(u.data()), u.size());  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
}

bool has_models(const std::string& dir) {
  if (dir.empty()) return false;
  std::error_code ec;
  return std::filesystem::exists(u8path(dir) / kPalmModelFile, ec) && std::filesystem::exists(u8path(dir) / kHandModelFile, ec);
}

double num_or(const Json& j, const char* k, double d) { return j.at(k).is_number() ? j.at(k).num() : d; }
std::string str_or(const Json& j, const char* k) { return j.at(k).is_string() ? j.at(k).str() : std::string(); }

// ── the engine side ─────────────────────────────────────────────────────────

class LiveHost final : public LivePort {
 public:
  explicit LiveHost(std::string exe) : exe_(std::move(exe)) {}
  ~LiveHost() override { stop(); }
  LiveHost(const LiveHost&) = delete;
  LiveHost& operator=(const LiveHost&) = delete;
  LiveHost(LiveHost&&) = delete;
  LiveHost& operator=(LiveHost&&) = delete;

  void start(const LiveStart& s) override {
    stop();
    const std::string dir = resolve_model_dir(s.modelDir);
    if (dir.empty()) {
      publish_state(api::LiveInputState::failed, "The hand tracking model is not installed — install it in Settings ▸ Hand Tracking.");
      return;
    }
    const std::string exe = exe_.empty() ? jobs::child_executable() : exe_;
    if (exe.empty()) {
      publish_state(api::LiveInputState::failed, "Live input needs the engine executable (not available in this process).");
      return;
    }
    Json cfg = Json::object();
    cfg.set("palm", Json::string(u8str(u8path(dir) / kPalmModelFile)));
    cfg.set("hand", Json::string(u8str(u8path(dir) / kHandModelFile)));
    cfg.set("camera", Json::string(s.camera));
    cfg.set("width", Json::number(s.width));
    cfg.set("fps", Json::number(s.fps));
    cfg.set("maxHands", Json::number(s.maxHands));
    std::error_code ec;
    const std::filesystem::path folder = std::filesystem::temp_directory_path(ec) / "premation-live";
    std::filesystem::create_directories(folder, ec);
    file_ = folder / ("live-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + ".json");
    {
      std::ofstream f(file_, std::ios::binary | std::ios::trunc);
      f << js::stringify(cfg);
      if (!f) {
        publish_state(api::LiveInputState::failed, "Could not write the live input settings to the temp folder.");
        return;
      }
    }
    std::string error;
    const std::string logPath = u8str(file_) + ".log";
    child_ = exporter::ChildProcess::spawn(exe, {"--live", u8str(file_)}, logPath, error, /*captureStdout=*/true);
    if (!child_) {
      publish_state(api::LiveInputState::failed, "Could not start live input: " + error);
      return;
    }
    stopping_ = false;
    publish_state(api::LiveInputState::starting, "");
    PREMATION_LOG(info, "live_started").kv("camera", s.camera).kv("width", static_cast<std::uint64_t>(s.width));
    reader_ = std::thread([this] { read_lines(); });
  }

  void stop() override {
    if (!child_) return;
    stopping_ = true;
    child_->kill();
    if (reader_.joinable()) reader_.join();
    child_.reset();
    std::error_code ec;
    std::filesystem::remove(file_, ec);
    publish_state(api::LiveInputState::stopped, "");
    PREMATION_LOG(info, "live_stopped");
  }

  [[nodiscard]] bool active() const override {
    const std::lock_guard<std::mutex> lock(m_);
    return latest_.state == api::LiveInputState::starting || latest_.state == api::LiveInputState::running || changed_;
  }

  bool take(api::LiveInputEvent& out) override {
    const std::lock_guard<std::mutex> lock(m_);
    if (!changed_) return false;
    out = latest_;
    changed_ = false;
    return true;
  }

  std::vector<api::CameraInfo> cameras() override {
    std::string error;
    const std::vector<CameraDevice> found = list_cameras(error);
    if (found.empty() && !error.empty()) doc::fail(ErrorCode::unsupported, error);
    std::vector<api::CameraInfo> out;
    for (const CameraDevice& d : found) out.push_back(api::CameraInfo{d.id, d.name});
    return out;
  }

 private:
  void publish_state(api::LiveInputState state, std::string message) {
    const std::lock_guard<std::mutex> lock(m_);
    latest_.state = state;
    latest_.message = std::move(message);
    if (state != api::LiveInputState::running) latest_.hands.clear();
    changed_ = true;
  }

  void read_lines() {
    std::string buffer;
    std::array<std::uint8_t, 16384> chunk{};
    bool failed = false;
    for (;;) {
      const long n = child_->read_stdout(chunk);
      if (n <= 0) break;
      buffer.append(reinterpret_cast<const char*>(chunk.data()), static_cast<std::size_t>(n));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
      for (std::size_t nl = buffer.find('\n'); nl != std::string::npos; nl = buffer.find('\n')) {
        const std::optional<Json> ev = js::parse(std::string_view(buffer).substr(0, nl));
        buffer.erase(0, nl + 1);
        if (!ev || !ev->is_object()) continue;  // stray output
        const std::string kind = str_or(*ev, "ev");
        if (kind == "hands") on_hands(*ev);
        else if (kind == "ready") on_ready(*ev);
        else if (kind == "error") {
          failed = true;
          publish_state(api::LiveInputState::failed, str_or(*ev, "message"));
        }
      }
    }
    if (!stopping_ && !failed) {
      PREMATION_LOG(warn, "live_child_ended");
      publish_state(api::LiveInputState::failed, "Live input stopped unexpectedly (the camera or the hand model crashed). The editor is fine — start it again.");
    }
  }

  void on_ready(const Json& ev) {
    const std::lock_guard<std::mutex> lock(m_);
    latest_.state = api::LiveInputState::running;
    latest_.message.clear();
    latest_.camera = str_or(ev, "camera");
    latest_.width = static_cast<std::uint32_t>(num_or(ev, "width", 0));
    latest_.height = static_cast<std::uint32_t>(num_or(ev, "height", 0));
    latest_.fps = num_or(ev, "fps", 0);
    changed_ = true;
  }

  void on_hands(const Json& ev) {
    std::vector<api::LiveHand> hands;
    if (ev.at("hands").is_array()) {
      for (const Json& h : ev.at("hands").arr()) {
        api::LiveHand lh;
        if (h.at("lm").is_array()) {
          for (const Json& v : h.at("lm").arr()) lh.landmarks.push_back(v.num());
        }
        lh.handedness = num_or(h, "hd", 0.5);
        lh.presence = num_or(h, "pr", 0);
        lh.pinch = num_or(h, "pi", 0);
        hands.push_back(std::move(lh));
      }
    }
    const std::lock_guard<std::mutex> lock(m_);
    latest_.state = api::LiveInputState::running;
    latest_.seq = static_cast<std::uint64_t>(num_or(ev, "seq", 0));
    latest_.latency_ms = num_or(ev, "latencyMs", 0);
    latest_.hands = std::move(hands);
    changed_ = true;
  }

  std::string exe_;
  std::unique_ptr<exporter::ChildProcess> child_;
  std::thread reader_;
  std::filesystem::path file_;
  std::atomic<bool> stopping_{false};
  mutable std::mutex m_;
  api::LiveInputEvent latest_;
  bool changed_ = false;
};

// ── the child ───────────────────────────────────────────────────────────────

std::mutex& out_mutex() {
  static std::mutex m;
  return m;
}

void emit(const std::string& line) {
  const std::lock_guard<std::mutex> lock(out_mutex());
  std::cout << line << '\n' << std::flush;
}

void emit_error(const std::string& message) {
  Json o = Json::object();
  o.set("ev", Json::string("error"));
  o.set("message", Json::string(message));
  emit(js::stringify(o));
}

/// One tracked frame as a line: landmarks normalized to the frame (z by its width), compactly.
std::string hands_line(std::uint64_t seq, double latencyMs, const std::vector<Hand>& hands, const std::vector<std::vector<double>>& smooth, int w,
                       int h) {
  std::string s;
  s.reserve(160 + hands.size() * 1200);
  char buf[64];
  std::snprintf(buf, sizeof buf, "{\"ev\":\"hands\",\"seq\":%llu,\"latencyMs\":%.2f,\"hands\":[", static_cast<unsigned long long>(seq), latencyMs);
  s += buf;
  for (std::size_t i = 0; i < hands.size(); ++i) {
    if (i > 0) s += ',';
    s += "{\"lm\":[";
    const std::vector<double>& xy = smooth[i];
    for (std::size_t k = 0; k < kHandLandmarks; ++k) {
      std::snprintf(buf, sizeof buf, "%s%.5f,%.5f,%.5f", k > 0 ? "," : "", xy[k * 2] / w, xy[k * 2 + 1] / h, hands[i].depth[k] / w);
      s += buf;
    }
    std::snprintf(buf, sizeof buf, "],\"hd\":%.4f,\"pr\":%.4f,\"pi\":%.4f}", hands[i].handedness, hands[i].presence, pinch_ratio(hands[i]));
    s += buf;
  }
  s += "]}";
  return s;
}

}  // namespace

std::string resolve_model_dir(const std::string& requested) {
  if (!requested.empty()) return has_models(requested) ? requested : std::string();
  for (const char* var : {"PREMATION_HAND_USER_DIR", "PREMATION_HAND_DIR"}) {
    const std::string dir = env_utf8(var);
    if (has_models(dir)) return dir;
  }
  return {};
}

std::unique_ptr<LivePort> make_live_host(std::string childExe) { return std::make_unique<LiveHost>(std::move(childExe)); }

int live_main(const std::string& configFile) {
  std::ifstream in(u8path(configFile), std::ios::binary);
  std::stringstream ss;
  ss << in.rdbuf();
  const std::optional<Json> cfg = js::parse(ss.str());
  if (!cfg || !cfg->is_object()) {
    emit_error("Live input: the settings file could not be read.");
    return 64;
  }
  // The engine that started us goes away (crash, kill, quit): our stdin
  // closes, and the camera must not stay on behind its back.
  std::thread([] {
    char c = 0;
    while (std::cin.get(c)) {
    }
    std::_Exit(0);
  }).detach();

  std::string error;
  auto palm = load_model(str_or(*cfg, "palm"), /*cpuOnly=*/true, error);
  if (!palm) {
    emit_error("The hand tracking model could not be loaded: " + error);
    return 0;
  }
  auto hand = load_model(str_or(*cfg, "hand"), /*cpuOnly=*/true, error);
  if (!hand) {
    emit_error("The hand tracking model could not be loaded: " + error);
    return 0;
  }
  CameraRequest req;
  req.id = str_or(*cfg, "camera");
  req.width = static_cast<int>(num_or(*cfg, "width", 640));
  req.fps = num_or(*cfg, "fps", 60);
  auto cam = open_camera(req, error);
  if (!cam) {
    emit_error("The camera could not be opened: " + error);
    return 0;
  }
  {
    Json o = Json::object();
    o.set("ev", Json::string("ready"));
    o.set("camera", Json::string(cam->name()));
    o.set("width", Json::number(cam->width()));
    o.set("height", Json::number(cam->height()));
    o.set("fps", Json::number(cam->fps()));
    emit(js::stringify(o));
  }

  FrameMailbox mailbox;
  std::string captureError;
  std::thread capturer([&] {
    CameraFrame f;
    while (cam->read(f, captureError)) mailbox.put(f);
    mailbox.close();
  });

  TrackerOptions opts;
  opts.maxHands = static_cast<std::size_t>(std::clamp(num_or(*cfg, "maxHands", 2), 1.0, 2.0));
  HandTracker tracker(*palm, *hand, opts);
  // In frame px: still hands settle (1.5 Hz at rest), quick ones follow (the cutoff rises 0.02 Hz per px/s).
  std::vector<OneEuro> filters(2, OneEuro(1.5, 0.02));
  std::vector<std::vector<double>> smooth(2);
  std::size_t lastCount = 0;
  std::int64_t lastNs = 0;
  std::uint64_t seq = 0;
  CameraFrame f;
  for (;;) {
    if (!mailbox.take(f, std::chrono::milliseconds(2000))) {
      if (!captureError.empty()) break;
      continue;
    }
    const TrackerResult r = tracker.process(ImageView{f.bgra.data(), f.width, f.height, f.stride});
    const std::int64_t ready = now_ns();
    // A hand appearing or leaving reorders them: restart the filters rather than blend two hands.
    if (r.hands.size() != lastCount) {
      for (OneEuro& e : filters) e.reset();
      lastCount = r.hands.size();
    }
    const double dt = lastNs != 0 ? static_cast<double>(f.arrivalNs - lastNs) / 1e9 : 0;
    lastNs = f.arrivalNs;
    for (std::size_t i = 0; i < r.hands.size() && i < 2; ++i) {
      smooth[i].resize(kHandLandmarks * 2);
      for (std::size_t k = 0; k < kHandLandmarks; ++k) {
        smooth[i][k * 2] = r.hands[i].landmarks[k].x;
        smooth[i][k * 2 + 1] = r.hands[i].landmarks[k].y;
      }
      filters[i].filter(smooth[i], dt);
    }
    const double latency = f.captureNs != 0 ? static_cast<double>(ready - f.captureNs) / 1e6 : 0;
    emit(hands_line(++seq, latency, r.hands, smooth, f.width, f.height));
  }
  capturer.join();
  emit_error("The camera stopped: " + captureError);
  return 0;
}

}  // namespace premation::live
