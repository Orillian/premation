// The edit-command halves of native SDK plugin effects (G1, native_effects.hpp):
// what addEffect and invokeEffectAction do when the effect is a plugin's.
#pragma once

#include <string>
#include <string_view>

#include "engine_ctx.hpp"
#include "native_effects.hpp"
#include "timeline.hpp"

namespace premation::doc {

/// addEffect validation: a native type whose plugin is disabled / failed cannot be added (notFound).
void native_check_addable(std::string_view type);

/// addEffect of a native type: store the instance's initial flat sequence data
/// (SEQUENCE_SETUP → FLATTEN, through the host) in the layer's fx.pluginData,
/// inside the same history entry.
void native_effect_added(Document& d, std::string_view layer, std::string_view effectId, std::string_view type);

/// invokeEffectAction on a native effect: USER_CHANGED_PARAM through the host;
/// the plugin's param writes, sequence data and arbitrary data become ONE
/// history entry. Fails (EngineFail) when `group` is not a native effect.
void native_invoke_action(HCtx& x, const api::PropRef& group, const std::string& action, const std::string& payload = {});
/// dragEffectOverlay (plugin SDK 1.1): OVERLAY_DRAG on the effect, its writes applied like an action's.
void native_overlay_drag(HCtx& x, const api::DragEffectOverlay& c);
/// Write what a plugin changed (params — keyed at the playhead when animated —, sequence, arbitrary data).
void apply_native_edit(HCtx& x, const api::PropRef& group, const std::string& effectId, const NativeEdit& edit);
/// The host request for one document effect instance (static params, flat sequence, arbitrary data) at `time`.
[[nodiscard]] NativeActionRequest native_request(const Document& d, const Node& node, const std::string& layer, const std::string& effectId,
                                                 const Json& e, const NativeEffect& ne, api::Time time);

/// getEffectUi: a native effect's params through UPDATE_PARAMS_UI, its plugin,
/// panel and plugin data (SDK 1.1 panels); a builtin effect's params all enabled
/// and visible. notFound for no such effect.
[[nodiscard]] api::EffectUi native_effect_ui(const Document& d, const std::string& layer, const std::string& path, api::Time time);

/// SDK 1.1 FILE param: the project item `item` as a file — its path on disk (the
/// item's `src` / `path` resolved like footage), its name, and whether it is
/// missing. An empty `item` is "none chosen" (not missing).
[[nodiscard]] NativeActionRequest::File native_file_of(const Document& d, std::string_view key, std::string_view item);

/// Is `item` the value of a FILE param of a native effect on `node`? (removeUnusedItems, collect).
[[nodiscard]] bool native_effects_use_item(const Node& node, std::string_view item);

/// SDK 1.2 (plugin layer time): a layer's own clock — the mapping its keyframes are
/// evaluated on (comp_to_keyframe_time: the clip's source offset, Time Stretch,
/// reverse, freeze), but sub-frame exact both ways, so checkout_time's layer
/// times map back to comp times. Read at comp `seconds` (the active clip there).
struct NativeLayerClock {
  double fps = 30;
  bool hasClip = false;
  double clipStart = 0, sourceIn = 0;  ///< frames
  std::optional<LayerTime> cfg;
  double spanStart = 0, spanEnd = 1;
  double atComp = 0, atLayer = 0;  ///< the reading point (a frozen layer maps around it)
  /// Comp seconds → layer seconds.
  [[nodiscard]] double layer_time(double compSeconds) const;
  /// Layer seconds → comp seconds (a frozen layer: the same offset from the reading point).
  [[nodiscard]] double comp_time(double layerSeconds) const;
};
[[nodiscard]] NativeLayerClock native_layer_clock(const Document& d, const EditorView& v, std::string_view layer, double compSeconds);

/// Write one entry of fx.pluginData (setPluginData's storage; empty bytes = delete).
void native_write_plugin_data(Document& d, std::string_view layer, std::string_view group, std::string_view key,
                              const std::vector<std::uint8_t>& bytes);
/// Read one entry (nullopt = absent / not base64).
[[nodiscard]] std::optional<std::vector<std::uint8_t>> native_read_plugin_data(const Node& n, std::string_view group,
                                                                              std::string_view key);

}  // namespace premation::doc
