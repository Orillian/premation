// SDK 1.2 presets (docs/PLUGIN_SDK.md "Presets", AE's .ffx): a bundle ships
// named starting points for its effects, in the manifest
//
//   "presets": [ { "name": "Warm Burst", "effect": "<match name>", "category": "Bursts",
//                  "values": { "p2": 400, "p8": "#ffaa33", "p5": 2, "p1": [0, -100] } } ]
//
// and / or as `presets/*.json` in the bundle (one such object, or
// `{ "presets": [ … ] }`). The editor lists them under the plugin in Effects &
// Presets; applying one is `addEffect` with the values as its params — one undo
// entry, no plugin code beyond what addEffect runs.
#pragma once

#include <filesystem>
#include <string>
#include <string_view>
#include <vector>

#include "engine_api.hpp"
#include "host.hpp"
#include "json.hpp"

namespace premation::plugins {

struct PresetSpec {
  std::string name;
  std::string effect;  ///< match name ("" in the file = the plugin's first effect)
  std::string category;
  js::Json values;  ///< object: param key → value
};

/// The bundle's presets: the manifest's `presets` (`manifestText` is premation-plugin.json), then
/// every `presets/*.json` by file name. An entry without a name or naming an effect the bundle
/// does not list is skipped and named in `problems` — a bad preset never fails the plugin.
[[nodiscard]] std::vector<PresetSpec> read_presets(const std::filesystem::path& bundle, std::string_view manifestText,
                                                   const std::vector<std::string>& effects, std::vector<std::string>& problems);

/// A preset's values as addEffect params for `spec`: numbers, angles, sliders (a number), popups
/// (a 1-based number or a choice's label), checkboxes (a bool or number), colours ("#rrggbb[aa]" or
/// [r, g, b(, a)] in 0..1), points (`p<id>` as [x, y(, z)] or `p<id>X` …: offsets from the layer
/// centre, layer px, as the document stores them), strings, curves and gradients (their JSON).
/// Keys the effect does not have, LAYER / FILE / PATH params and values of the wrong kind are dropped.
[[nodiscard]] std::vector<api::PropertyInit> preset_values(const PresetSpec& preset, const EffectSpec& spec);

}  // namespace premation::plugins
