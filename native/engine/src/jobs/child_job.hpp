// Crash isolation for jobs that load a model (object matte / SAM through ONNX
// Runtime): the work runs in a CHILD engine process,
//
//   premation-engine --job FILE      FILE = {"work": NAME, "input": {...}}
//
// which prints JSON lines on stdout —
//   {"ev":"progress","fraction":F,"message":S}
//   {"ev":"result","result":{...}}
//   {"ev":"error","code":S,"message":S}
// — and exits 0. A crash, a kill or a non-zero exit fails the job with the
// exit status; the engine that asked keeps running. Cancel kills the child.
//
// Footage a native plugin imports (P7b): the child starts its OWN plugin host
// from the engine's plugin folders (the job file's "plugins"), as the export
// process does, so it reads that footage through the same importer at the same
// source times as the engine. Every plugin the engine does not run at that
// moment (disabled, quarantined, failed, revoked, locked, or with an importer
// that crashed this session) is listed disabled for the child, and the
// revocation list and entitlement token are the engine's files: no plugin code
// runs in the child that would not run in the engine. A plugin crash there
// fails the job, never the engine or the editor.
#pragma once

#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "job_api.hpp"

namespace premation::jobs {

/// Runs IN THE CHILD: the input JSON in, the result JSON out. Throws
/// EngineFail to fail the job with a typed error.
using ChildWork = std::function<std::string(const std::string& inputJson, JobControl& control)>;

/// Make `name` runnable in a child. Called by register_child_works() (job_kinds.cpp), in both processes.
void register_child_work(const std::string& name, ChildWork work);

/// Every kind's child work (job_kinds.cpp).
void register_child_works();

/// The engine executable a child is started from (main.cpp sets argv[0]'s
/// resolved path at startup). Empty = run child work in-process (tests, the
/// headless tools): no isolation, same results.
void set_child_executable(std::string path);
/// The executable set above ('' = none known).
[[nodiscard]] std::string child_executable();

/// The plugin set a child job loads (the job file's "plugins"). Empty `paths` = no plugin host.
struct ChildPlugins {
  /// The engine's plugin folders (--plugins and PREMATION_PLUGIN_PATH, already expanded).
  std::vector<std::string> paths;
  /// Plugin ids the child lists as disabled: every plugin the engine does not run right now.
  std::vector<std::string> disabled;
  /// The engine's --revoked and --entitlement files ("" = none).
  std::string revoked;
  std::string entitlement;
};

/// Parent side: what each child gets, asked at every run_child (the engine process
/// installs it beside its plugin host; unset = no plugins in the child).
void set_child_plugins(std::function<ChildPlugins()> current);

/// Child side: the plugin host a job runs with, alive until the work has answered.
class ChildPluginScope {
 public:
  ChildPluginScope() = default;
  virtual ~ChildPluginScope() = default;
  ChildPluginScope(const ChildPluginScope&) = delete;
  ChildPluginScope& operator=(const ChildPluginScope&) = delete;
  ChildPluginScope(ChildPluginScope&&) = delete;
  ChildPluginScope& operator=(ChildPluginScope&&) = delete;
};
/// Starts that host (engine_process.cpp run_job_child: the jobs library does not link the plugin host).
using ChildPluginStarter = std::function<std::unique_ptr<ChildPluginScope>(const ChildPlugins&)>;

/// Parent side: run `name` on `inputJson` in a child process; progress is
/// relayed to `control`. The result JSON, or nullopt when cancelled. Throws
/// EngineFail: the child's own error, or `internal` when it crashed.
[[nodiscard]] std::optional<std::string> run_child(const std::string& name, const std::string& inputJson, JobControl& control);

/// `premation-engine --job FILE`: the child's main. Returns the exit code. `startPlugins`
/// runs before the work when the job file lists plugin folders.
int child_main(const std::string& jobFile, const ChildPluginStarter& startPlugins = {});

/// Shared with the long-lived worker (job_worker.hpp): the same registry, error
/// names and plugin set the one-shot child uses.
namespace child_detail {
[[nodiscard]] ChildWork find_work(const std::string& name);
[[nodiscard]] std::string code_name(api::ErrorCode c);
[[nodiscard]] api::ErrorCode code_named(const std::string& s);
/// The engine's plugin set right now as the job file's "plugins" JSON (nullopt = none).
[[nodiscard]] std::optional<std::string> current_plugins();
/// Parse that JSON back (an empty set when it is not one).
[[nodiscard]] ChildPlugins plugins_from(const std::string& json);
}  // namespace child_detail

}  // namespace premation::jobs
