#include "child_job.hpp"

#include <array>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <mutex>
#include <sstream>
#include <thread>

#include "child_process.hpp"
#include "fail.hpp"
#include "json.hpp"
#include "log.hpp"

namespace premation::jobs {

using api::ErrorCode;
using doc::fail;
using js::Json;

namespace {

struct Registry {
  std::mutex mu;
  std::map<std::string, ChildWork, std::less<>> works;
  std::string exe;
  std::function<ChildPlugins()> plugins;
};

Registry& registry() {
  static Registry r;  // process-wide: the kinds register once at startup
  return r;
}

ChildWork find_work(const std::string& name) {
  Registry& r = registry();
  const std::lock_guard<std::mutex> lock(r.mu);
  const auto it = r.works.find(name);
  return it != r.works.end() ? it->second : ChildWork{};
}

std::string exe_path() {
  Registry& r = registry();
  const std::lock_guard<std::mutex> lock(r.mu);
  return r.exe;
}

ErrorCode code_named(const std::string& s) {
  if (s == "notFound") return ErrorCode::not_found;
  if (s == "invalidArgument") return ErrorCode::invalid_argument;
  if (s == "unsupported") return ErrorCode::unsupported;
  if (s == "io") return ErrorCode::io;
  if (s == "decode") return ErrorCode::decode;  // footage the child cannot read
  if (s == "outOfRange") return ErrorCode::out_of_range;
  return ErrorCode::internal;
}

std::string code_name(ErrorCode c) {
  switch (c) {
    case ErrorCode::not_found: return "notFound";
    case ErrorCode::invalid_argument: return "invalidArgument";
    case ErrorCode::unsupported: return "unsupported";
    case ErrorCode::io: return "io";
    case ErrorCode::decode: return "decode";
    case ErrorCode::out_of_range: return "outOfRange";
    default: return "internal";
  }
}

/// The child's control: progress becomes a stdout line; it is never cancelled from inside (the parent kills it).
class ChildControl final : public JobControl {
 public:
  [[nodiscard]] bool cancelled() const noexcept override { return false; }
  void progress(double fraction, std::string message) override {
    Json o = Json::object();
    o.set("ev", Json::string("progress"));
    o.set("fraction", Json::number(fraction));
    o.set("message", Json::string(std::move(message)));
    std::cout << js::stringify(o) << '\n' << std::flush;
  }
};

/// In-process fallback (no executable known: tests, tools): the same work, no isolation.
class ForwardControl final : public JobControl {
 public:
  explicit ForwardControl(JobControl& parent) : parent_(parent) {}
  [[nodiscard]] bool cancelled() const noexcept override { return parent_.cancelled(); }
  void progress(double fraction, std::string message) override { parent_.progress(fraction, std::move(message)); }

 private:
  JobControl& parent_;
};

std::filesystem::path temp_job_file(const std::string& name) {
  static std::atomic<std::uint64_t> seq{0};
  const auto dir = std::filesystem::temp_directory_path() / "premation-jobs";
  std::error_code ec;
  std::filesystem::create_directories(dir, ec);
  const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
  return dir / (name + "-" + std::to_string(stamp) + "-" + std::to_string(++seq) + ".json");
}

}  // namespace

void register_child_work(const std::string& name, ChildWork work) {
  Registry& r = registry();
  const std::lock_guard<std::mutex> lock(r.mu);
  r.works.insert_or_assign(name, std::move(work));
}

void set_child_executable(std::string path) {
  Registry& r = registry();
  const std::lock_guard<std::mutex> lock(r.mu);
  r.exe = std::move(path);
}

std::string child_executable() { return exe_path(); }

void set_child_plugins(std::function<ChildPlugins()> current) {
  Registry& r = registry();
  const std::lock_guard<std::mutex> lock(r.mu);
  r.plugins = std::move(current);
}

namespace {

Json strings_json(const std::vector<std::string>& v) {
  Json a = Json::array();
  for (const std::string& s : v) a.arr_mut().push_back(Json::string(s));
  return a;
}

std::vector<std::string> json_strings(const Json& a) {
  std::vector<std::string> out;
  if (!a.is_array()) return out;
  for (const Json& s : a.arr()) {
    if (s.is_string()) out.push_back(s.str());
  }
  return out;
}

/// The job file's "plugins": the engine's plugin set right now (undefined = none).
std::optional<Json> current_plugins_json() {
  std::function<ChildPlugins()> fn;
  {
    Registry& r = registry();
    const std::lock_guard<std::mutex> lock(r.mu);
    fn = r.plugins;
  }
  if (!fn) return std::nullopt;
  const ChildPlugins cp = fn();
  if (cp.paths.empty()) return std::nullopt;
  Json o = Json::object();
  o.set("paths", strings_json(cp.paths));
  o.set("disabled", strings_json(cp.disabled));
  o.set("revoked", Json::string(cp.revoked));
  o.set("entitlement", Json::string(cp.entitlement));
  return o;
}

}  // namespace

std::optional<std::string> run_child(const std::string& name, const std::string& inputJson, JobControl& control) {
  const std::string exe = exe_path();
  if (exe.empty()) {
    const ChildWork work = find_work(name);
    if (!work) fail(ErrorCode::internal, "no child work '" + name + "'");
    ForwardControl fwd(control);
    std::string out = work(inputJson, fwd);
    if (control.cancelled()) return std::nullopt;
    return out;
  }
  const std::optional<Json> input = js::parse(inputJson);
  if (!input) fail(ErrorCode::internal, "the child job input is not JSON");
  const std::filesystem::path file = temp_job_file(name);
  {
    Json job = Json::object();
    job.set("work", Json::string(name));
    job.set("input", *input);
    if (std::optional<Json> plugins = current_plugins_json()) job.set("plugins", std::move(*plugins));
    std::ofstream f(file, std::ios::binary | std::ios::trunc);
    f << js::stringify(job);
    if (!f) fail(ErrorCode::io, "could not write the job file '" + file.string() + "'");
  }
  struct Cleanup {
    std::filesystem::path p;
    ~Cleanup() {
      std::error_code ec;
      std::filesystem::remove(p, ec);
    }
  } cleanup{file};
  std::string error;
  const std::string logPath = file.string() + ".log";
  std::unique_ptr<exporter::ChildProcess> child =
      exporter::ChildProcess::spawn(exe, {"--job", file.string()}, logPath, error, /*captureStdout=*/true);
  if (!child) fail(ErrorCode::internal, "could not start the job process: " + error);

  // The watcher kills the child when the job is cancelled; reading then ends.
  std::atomic<bool> done{false};
  std::atomic<bool> killed{false};
  std::thread watcher([&] {
    while (!done.load()) {
      if (control.cancelled()) {
        killed = true;
        child->kill();
        return;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
  });
  std::optional<std::string> result;
  std::optional<api::EngineError> childError;
  std::string buffer;
  std::array<std::uint8_t, 8192> chunk{};
  for (;;) {
    const long n = child->read_stdout(chunk);
    if (n <= 0) break;
    buffer.append(reinterpret_cast<const char*>(chunk.data()), static_cast<std::size_t>(n));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
    for (std::size_t nl = buffer.find('\n'); nl != std::string::npos; nl = buffer.find('\n')) {
      const std::string line = buffer.substr(0, nl);
      buffer.erase(0, nl + 1);
      const std::optional<Json> ev = js::parse(line);
      if (!ev || !ev->is_object() || !ev->at("ev").is_string()) continue;  // stray output
      const std::string kind = ev->at("ev").str();
      if (kind == "progress") {
        const double f = ev->at("fraction").is_number() ? ev->at("fraction").num() : 0;
        control.progress(f, ev->at("message").is_string() ? ev->at("message").str() : std::string());
      } else if (kind == "result") {
        result = js::stringify(ev->at("result"));
      } else if (kind == "error") {
        api::EngineError e;
        e.code = code_named(ev->at("code").is_string() ? ev->at("code").str() : "");
        e.message = ev->at("message").is_string() ? ev->at("message").str() : "the job failed";
        childError = std::move(e);
      }
    }
  }
  done = true;
  watcher.join();
  const int code = child->finish();
  if (killed.load() || control.cancelled()) return std::nullopt;
  if (childError) throw doc::EngineFail{std::move(*childError)};
  if (code != 0 || !result) {
    PREMATION_LOG(warn, "job_child_failed").kv("work", name).kv("exit", static_cast<std::int64_t>(code)).kv("log", logPath);
    fail(ErrorCode::internal, "the " + name + " job process ended without a result (exit " + std::to_string(code) +
                                  "; the engine kept running — log: " + logPath + ")");
  }
  std::error_code ec;
  std::filesystem::remove(logPath, ec);
  return result;
}

int child_main(const std::string& jobFile, const ChildPluginStarter& startPlugins) {
  register_child_works();
  auto emit_error = [](ErrorCode code, const std::string& message) {
    Json o = Json::object();
    o.set("ev", Json::string("error"));
    o.set("code", Json::string(code_name(code)));
    o.set("message", Json::string(message));
    std::cout << js::stringify(o) << '\n' << std::flush;
  };
  std::ifstream in(jobFile, std::ios::binary);
  std::stringstream ss;
  ss << in.rdbuf();
  const std::optional<Json> job = js::parse(ss.str());
  if (!job || !job->is_object() || !job->at("work").is_string()) {
    emit_error(ErrorCode::invalid_argument, "not a job file: " + jobFile);
    return 64;
  }
  const ChildWork work = find_work(job->at("work").str());
  if (!work) {
    emit_error(ErrorCode::unsupported, "no job work '" + job->at("work").str() + "' in this engine build");
    return 64;
  }
  // P7b: the plugin host the work reads plugin footage with (the engine's set, child_job.hpp).
  // Declared before the work's state, so it outlives every reader of its importers.
  std::unique_ptr<ChildPluginScope> plugins;
  if (const Json& pj = job->at("plugins"); startPlugins && pj.is_object()) {
    ChildPlugins cp;
    cp.paths = json_strings(pj.at("paths"));
    cp.disabled = json_strings(pj.at("disabled"));
    cp.revoked = pj.at("revoked").is_string() ? pj.at("revoked").str() : std::string();
    cp.entitlement = pj.at("entitlement").is_string() ? pj.at("entitlement").str() : std::string();
    if (!cp.paths.empty()) plugins = startPlugins(cp);
  }
  ChildControl control;
  // Failures are answered as an error line and exit 0: only a crash is a crash.
  std::optional<api::EngineError> failed;
  std::string result;
  try {
    result = work(js::stringify(job->at("input")), control);
  } catch (const doc::EngineFail& f) {
    failed = f.error;
  } catch (const std::exception& e) {
    api::EngineError err;
    err.code = ErrorCode::internal;
    err.message = e.what();
    failed = std::move(err);
  }
  if (failed) {
    emit_error(failed->code, failed->message);
    return 0;
  }
  const std::optional<Json> parsed = js::parse(result);
  Json o = Json::object();
  o.set("ev", Json::string("result"));
  o.set("result", parsed ? *parsed : Json::object());
  std::cout << js::stringify(o) << '\n' << std::flush;
  return 0;
}

namespace child_detail {

ChildWork find_work(const std::string& name) { return jobs::find_work(name); }
std::string code_name(ErrorCode c) { return jobs::code_name(c); }
ErrorCode code_named(const std::string& s) { return jobs::code_named(s); }

std::optional<std::string> current_plugins() {
  std::optional<Json> j = current_plugins_json();
  if (!j) return std::nullopt;
  return js::stringify(*j);
}

ChildPlugins plugins_from(const std::string& json) {
  ChildPlugins cp;
  const std::optional<Json> pj = js::parse(json);
  if (!pj || !pj->is_object()) return cp;
  cp.paths = json_strings(pj->at("paths"));
  cp.disabled = json_strings(pj->at("disabled"));
  cp.revoked = pj->at("revoked").is_string() ? pj->at("revoked").str() : std::string();
  cp.entitlement = pj->at("entitlement").is_string() ? pj->at("entitlement").str() : std::string();
  return cp;
}

}  // namespace child_detail

}  // namespace premation::jobs
