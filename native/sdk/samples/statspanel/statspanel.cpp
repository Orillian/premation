// Sample: Layer Stats — a PANEL plugin (SDK 1.2, manifest `panels`): a
// dockable panel that is not tied to an effect (ui/stats.html; the page reads
// and edits the document through the editor's message API, see ui/stats.js).
// Its binary adds one command the panel's button runs: Number Layers renames
// the selected layers "<prefix> 1", "<prefix> 2", … as ONE undo entry.
//
//   args: { "prefix": "Shot" }
#include <premation_sdk/premation_sdk.h>

#include <cstdio>
#include <string>

#include "sample_json.hpp"

namespace {

namespace json = prs::json;

PrErr PR_CALL number_main(PrCommandCmd cmd, const PrCommandContext* ctx, PrCommandOut* out) {
  if (cmd != PR_COMMAND_RUN || ctx == nullptr || out == nullptr || ctx->engine == nullptr) return PR_ERR_UNSUPPORTED;
  json::Value args;
  (void)json::parse(ctx->args_json != nullptr ? ctx->args_json : "{}", args);
  const std::string prefix = args["prefix"].str().empty() ? std::string("Layer") : args["prefix"].str();
  if (ctx->selected_layer_count == 0) {
    std::snprintf(out->return_msg, sizeof(out->return_msg), "select layers to number");
    return PR_ERR_INVALID_PARAM;
  }
  for (uint32_t i = 0; i < ctx->selected_layer_count; ++i) {
    const std::string req = "{\"type\":\"renameLayer\",\"layer\":" + json::quote(ctx->selected_layers[i]) +
                            ",\"name\":" + json::quote(prefix + " " + std::to_string(i + 1)) + "}";
    const char* reply = nullptr;
    uint32_t len = 0;
    if (ctx->engine->engine_command(ctx->host_ref, req.c_str(), &reply, &len) != PR_ERR_NONE) {
      json::Value e;
      (void)json::parse(reply != nullptr ? std::string_view(reply, len) : std::string_view("{}"), e);
      std::snprintf(out->return_msg, sizeof(out->return_msg), "%s", e["message"].str().c_str());
      return PR_ERR_INVALID_PARAM;
    }
  }
  std::snprintf(out->return_msg, sizeof(out->return_msg), "numbered %u layers", ctx->selected_layer_count);
  return PR_ERR_NONE;
}

const PrCommandEntry kCommands[] = {{"number", &number_main}};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): C ABI table
const PrPluginInfo kInfo = {sizeof(PrPluginInfo), PR_SDK_VERSION, "com.premation.samples.statspanel", 0, nullptr, 1, kCommands, 0, nullptr, 0, nullptr};

}  // namespace

extern "C" PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void) { return &kInfo; }
