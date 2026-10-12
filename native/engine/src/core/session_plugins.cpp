// Session: native plugin commands (P7a, docs/PLUGIN_SDK.md "Commands") —
// runPluginCommand inside the request's journal. The plugin runs on this (the
// core) thread through the host (native_contrib.hpp); every edit it makes
// through engine_command is an ordinary edit command in the SAME journal, so
// the invocation is ONE history entry, and a failure or a crash rolls all of
// it back (run_edits). The log keeps the edits, not the runPluginCommand: a
// crash replay never runs the plugin again (handle_request_body, jobLog_).
#include <exception>
#include <functional>
#include <optional>
#include <string>
#include <utility>
#include <variant>
#include <vector>

#include "fail.hpp"
#include "native_contrib.hpp"
#include "readmodel.hpp"
#include "scene.hpp"
#include "session.hpp"
#include "variant_util.hpp"

namespace premation {

namespace {

class SessionCommandBridge final : public doc::PluginCommandBridge {
 public:
  using Query = std::function<api::QueryResult(const api::Query&)>;
  using Edit = std::function<api::CommandResult(const api::Command&)>;
  SessionCommandBridge(Query q, Edit e) : query_(std::move(q)), edit_(std::move(e)) {}
  api::QueryResult query(const api::Query& q) override { return query_(q); }
  api::CommandResult command(const api::Command& c) override {
    // No savepoint inside a journal: a failed edit may have written part of
    // itself, so it fails the whole invocation (rolled back after RUN).
    std::optional<api::EngineError> failed;
    try {
      api::CommandResult r = edit_(c);
      edits.push_back(c);
      return r;
    } catch (const doc::EngineFail& f) {
      failed = f.error;
    } catch (const std::exception& e) {
      api::EngineError err;
      err.code = api::ErrorCode::internal;
      err.message = e.what();
      failed = std::move(err);
    }
    if (!firstError) firstError = *failed;
    throw doc::EngineFail{std::move(*failed)};  // outside the catch funclet (clang-cl ASan)
  }
  std::optional<api::EngineError> firstError;
  std::vector<api::Command> edits;

 private:
  Query query_;
  Edit edit_;
};

}  // namespace

api::CommandResult Session::run_plugin_command_in_journal(const api::RunPluginCommand& c, api::Origin /*origin*/, std::string& label) {
  doc::PluginCommandRequest req;
  req.plugin = c.plugin;
  req.command = c.command;
  const std::optional<std::string> active = active_comp();
  req.comp = c.comp.value_or(active.value_or(std::string()));
  req.layers = c.layers;
  req.time = c.time.value_or(apiTime_);
  if (!req.comp.empty() && doc::is_comp_item(doc_, req.comp)) req.fps = doc::comp_fps(doc_, req.comp);
  req.args = c.args.value_or("{}");

  SessionCommandBridge bridge(
      [this](const api::Query& q) { return run_query(q); },
      [this](const api::Command& cmd) {
        if (cmd.kind() == api::Command::Kind::run_plugin_command) {
          doc::fail(api::ErrorCode::invalid_argument, "a plugin command cannot run another plugin command");
        }
        if (cmd.kind() == api::Command::Kind::apply_job_result || cmd.kind() == api::Command::Kind::auto_trace) {
          doc::fail(api::ErrorCode::invalid_argument, "applyJobResult / autoTrace are not available to plugin commands");
        }
        catalogCache_.clear();
        // Edits a plugin makes carry origin `plugin` (handler context, proxies).
        api::CommandResult r = run_in_journal(cmd, api::Origin::plugin, nullptr);
        catalogCache_.clear();
        return r;
      });
  auto outcome = doc::NativeCommands::run(req, bridge);
  if (auto* e = std::get_if<api::EngineError>(&outcome)) throw doc::EngineFail{std::move(*e)};
  if (bridge.firstError) {
    api::EngineError e = std::move(*bridge.firstError);
    e.message = "plugin command '" + c.plugin + "/" + c.command + "': an edit failed, nothing was changed: " + e.message;
    throw doc::EngineFail{std::move(e)};
  }
  doc::PluginCommandOutcome& done = std::get<doc::PluginCommandOutcome>(outcome);
  label = done.label;
  api::PluginCommandResult out;
  out.message = std::move(done.message);
  out.edits = static_cast<std::uint32_t>(bridge.edits.size());
  // handle_request_body logs these edits in place of the runPluginCommand (schema LogRecord.job).
  jobLog_ = JobLog{"plugin:" + c.plugin + "/" + c.command, label, std::move(bridge.edits)};
  return result_for<api::RunPluginCommand>(std::move(out));
}

}  // namespace premation
