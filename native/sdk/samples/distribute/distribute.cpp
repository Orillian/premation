// Sample: Distribute Layers — a COMMAND plugin (SDK 1.2, pr_command.h): AE's
// AEGP menu command. It reads the selected layers' positions through the
// engine API (engine_query) and spaces them evenly between the outermost two
// along X (or Y), writing each through engine_command. All of it is ONE undo
// entry ("Distribute Layers"), and the command log holds the setProperty edits.
//
//   args (runPluginCommand's JSON):  { "axis": "x" | "y", "fault": "<kind>" }
//   fault  "access_violation" | "cpp_exception" | "error" — the samples' fault
//          injection (docs/PLUGIN_SDK.md "Crash isolation"): the host rolls back
//          the edits already made and the editor carries on.
#include <premation_sdk/premation_sdk.h>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

#include "sample_json.hpp"

namespace {

namespace json = prs::json;

void say(PrCommandOut* out, const std::string& msg) {
  std::snprintf(out->return_msg, sizeof(out->return_msg), "%s", msg.c_str());
}

/// engine_query / engine_command, parsed. False with the engine's message in `out`.
bool call(const PrCommandContext* ctx, bool command, const std::string& request, json::Value& result, PrCommandOut* out) {
  const char* reply = nullptr;
  uint32_t len = 0;
  const PrErr e = command ? ctx->engine->engine_command(ctx->host_ref, request.c_str(), &reply, &len)
                          : ctx->engine->engine_query(ctx->host_ref, request.c_str(), &reply, &len);
  json::Value v;
  const bool parsed = reply != nullptr && json::parse(std::string_view(reply, len), v);
  if (e != PR_ERR_NONE) {
    say(out, parsed ? v["message"].str() : std::string("the engine refused the request"));
    return false;
  }
  if (!parsed) {
    say(out, "the engine's answer is not JSON");
    return false;
  }
  result = std::move(v);
  return true;
}

struct Item {
  std::string layer;
  double x = 0, y = 0;
};

PrErr run(const PrCommandContext* ctx, PrCommandOut* out) {
  json::Value args;
  (void)json::parse(ctx->args_json != nullptr ? ctx->args_json : "{}", args);
  const std::string fault = args["fault"].str();
  const bool alongY = args["axis"].str() == "y";

  if (ctx->selected_layer_count < 3) {
    say(out, "select three or more layers to distribute");
    return PR_ERR_INVALID_PARAM;
  }
  // Read every position at the playhead (pre-expression values).
  std::string props;
  for (uint32_t i = 0; i < ctx->selected_layer_count; ++i) {
    props += (i > 0 ? "," : "") + std::string("{\"layer\":") + json::quote(ctx->selected_layers[i]) + ",\"path\":\"transform/position\"}";
  }
  json::Value values;
  if (!call(ctx, false, "{\"type\":\"getPropertyValues\",\"props\":[" + props + "],\"time\":" + json::number(static_cast<double>(ctx->time)) + ",\"evaluated\":false}", values, out)) {
    return PR_ERR_INVALID_PARAM;
  }
  std::vector<Item> items;
  for (const json::Value& pv : values["values"].a) {
    const json::Value& v = pv["value"];
    if (v["kind"].str() != "vec2" && v["kind"].str() != "vec3") continue;
    items.push_back({pv["prop"]["layer"].str(), v["value"]["x"].num(), v["value"]["y"].num()});
  }
  if (items.size() < 3) {
    say(out, "the selected layers have no 2D position to distribute");
    return PR_ERR_INVALID_PARAM;
  }
  std::stable_sort(items.begin(), items.end(), [&](const Item& a, const Item& b) { return alongY ? a.y < b.y : a.x < b.x; });
  const double first = alongY ? items.front().y : items.front().x;
  const double last = alongY ? items.back().y : items.back().x;
  const double step = (last - first) / static_cast<double>(items.size() - 1);
  for (std::size_t i = 1; i + 1 < items.size(); ++i) {
    const bool lastEdit = i + 2 == items.size();  // the faults hit the last edit (after the others, with 4+ layers)
    if (lastEdit && fault == "access_violation") {
      volatile int* bad = nullptr;
      *bad = 42;  // NOLINT(clang-analyzer-core.NullDereference): the fault being injected
    }
    if (lastEdit && fault == "cpp_exception") throw std::runtime_error("injected C++ exception");
    if (lastEdit && fault == "error") {
      say(out, "injected error");
      return PR_ERR_INTERNAL;
    }
    Item& it = items[i];
    (alongY ? it.y : it.x) = first + step * static_cast<double>(i);
    const std::string set = "{\"type\":\"setProperty\",\"prop\":{\"layer\":" + json::quote(it.layer) +
                            ",\"path\":\"transform/position\"},\"value\":{\"kind\":\"vec2\",\"value\":{\"x\":" + json::number(it.x) +
                            ",\"y\":" + json::number(it.y) + "}},\"time\":" + json::number(static_cast<double>(ctx->time)) + "}";
    json::Value ignored;
    if (!call(ctx, true, set, ignored, out)) return PR_ERR_INVALID_PARAM;
  }
  say(out, "distributed " + std::to_string(items.size()) + " layers");
  return PR_ERR_NONE;
}

PrErr PR_CALL distribute_main(PrCommandCmd cmd, const PrCommandContext* ctx, PrCommandOut* out) {
  if (cmd != PR_COMMAND_RUN || ctx == nullptr || out == nullptr) return PR_ERR_UNSUPPORTED;
  if (ctx->struct_size < sizeof(PrCommandContext) || ctx->engine == nullptr) return PR_ERR_BAD_VERSION;
  return run(ctx, out);
}

const PrCommandEntry kCommands[] = {{"distribute", &distribute_main}};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): C ABI table
const PrPluginInfo kInfo = {sizeof(PrPluginInfo), PR_SDK_VERSION, "com.premation.samples.distribute", 0, nullptr, 1, kCommands, 0, nullptr, 0, nullptr};

}  // namespace

extern "C" PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void) { return &kInfo; }
