#include "presets.hpp"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <optional>
#include <sstream>

#include "fxstate.hpp"
#include "values.hpp"

namespace fs = std::filesystem;

namespace premation::plugins {
namespace {

constexpr std::size_t kMaxPresets = 512;
constexpr std::uintmax_t kMaxPresetFile = std::uintmax_t{1} << 20U;

void take(const js::Json& entry, const std::vector<std::string>& effects, const std::string& where, std::vector<PresetSpec>& out,
          std::vector<std::string>& problems) {
  if (!entry.is_object()) {
    problems.push_back(where + ": a preset must be an object");
    return;
  }
  PresetSpec p;
  p.name = entry.at("name").is_string() ? entry.at("name").str() : std::string();
  p.effect = entry.at("effect").is_string() ? entry.at("effect").str() : (effects.empty() ? std::string() : effects.front());
  p.category = entry.at("category").is_string() ? entry.at("category").str() : std::string();
  p.values = entry.at("values").is_object() ? entry.at("values") : js::Json::object();
  if (p.name.empty() || p.name.size() > 200) {
    problems.push_back(where + ": a preset needs a \"name\" (1-200 characters)");
    return;
  }
  if (std::ranges::find(effects, p.effect) == effects.end()) {
    problems.push_back(where + ": preset '" + p.name + "' names effect '" + p.effect + "', which the manifest does not list");
    return;
  }
  if (out.size() >= kMaxPresets) {
    problems.push_back(where + ": more than 512 presets; the rest are ignored");
    return;
  }
  out.push_back(std::move(p));
}

void take_all(const js::Json& j, const std::vector<std::string>& effects, const std::string& where, std::vector<PresetSpec>& out,
              std::vector<std::string>& problems) {
  if (j.is_array()) {
    for (const js::Json& e : j.arr()) take(e, effects, where, out, problems);
  } else if (j.is_object() && j.at("presets").is_array()) {
    for (const js::Json& e : j.at("presets").arr()) take(e, effects, where, out, problems);
  } else if (j.is_object()) {
    take(j, effects, where, out, problems);
  } else {
    problems.push_back(where + ": not a preset");
  }
}

std::optional<double> number_of(const js::Json& v) {
  if (v.is_number() && std::isfinite(v.num())) return v.num();
  if (v.is_bool()) return v.b() ? 1.0 : 0.0;
  return std::nullopt;
}

}  // namespace

std::vector<PresetSpec> read_presets(const fs::path& bundle, std::string_view manifestText, const std::vector<std::string>& effects,
                                     std::vector<std::string>& problems) {
  std::vector<PresetSpec> out;
  if (const auto man = js::parse(manifestText); man && man->is_object()) {
    const js::Json& list = man->at("presets");
    if (list.is_array()) {
      for (const js::Json& e : list.arr()) take(e, effects, "premation-plugin.json", out, problems);
    } else if (!list.is_undefined()) {
      problems.push_back("premation-plugin.json: \"presets\" must be an array");
    }
  }
  std::error_code ec;
  const fs::path dir = bundle / "presets";
  if (!fs::is_directory(dir, ec)) return out;
  std::vector<fs::path> files;
  for (const auto& entry : fs::directory_iterator(dir, ec)) {
    if (entry.is_regular_file(ec) && entry.path().extension() == ".json" && !entry.is_symlink(ec)) files.push_back(entry.path());
  }
  std::ranges::sort(files);  // deterministic order
  for (const fs::path& f : files) {
    const std::string where = "presets/" + f.filename().string();
    if (fs::file_size(f, ec) > kMaxPresetFile || ec) {
      problems.push_back(where + ": larger than 1 MiB");
      continue;
    }
    std::ifstream in(f, std::ios::binary);
    std::stringstream ss;
    ss << in.rdbuf();
    const auto j = js::parse(ss.str());
    if (!j) {
      problems.push_back(where + ": not JSON");
      continue;
    }
    take_all(*j, effects, where, out, problems);
  }
  return out;
}

std::vector<api::PropertyInit> preset_values(const PresetSpec& preset, const EffectSpec& spec) {
  std::vector<api::PropertyInit> out;
  if (!preset.values.is_object()) return out;
  const auto add = [&out](std::string path, api::Value v) {
    for (auto& p : out) {
      if (p.path == path) {
        p.value = std::move(v);
        return;
      }
    }
    out.push_back(api::PropertyInit{std::move(path), std::move(v)});
  };
  for (const js::Json::Member& m : preset.values.obj()) {
    const std::string& key = m.key;
    const js::Json& v = m.value;
    for (const ParamSpec& s : spec.params) {
      const bool point = s.type == PR_PARAM_POINT || s.type == PR_PARAM_POINT_3D;
      if (key == s.key) {
        switch (s.type) {
          case PR_PARAM_SLIDER:
          case PR_PARAM_FLOAT_SLIDER:
          case PR_PARAM_ANGLE:
            if (const auto n = number_of(v)) add(s.key, doc::v_scalar(s.validMax > s.validMin ? std::clamp(*n, s.validMin, s.validMax) : *n));
            break;
          case PR_PARAM_CHECKBOX:
            if (const auto n = number_of(v)) add(s.key, doc::v_bool(*n != 0));
            break;
          case PR_PARAM_POPUP:
            if (v.is_string() && std::ranges::find(s.choices, v.str()) != s.choices.end()) {
              add(s.key, doc::v_choice(v.str()));
            } else if (const auto n = number_of(v); n && !s.choices.empty()) {
              const auto i = static_cast<std::size_t>(std::clamp(std::round(*n), 1.0, static_cast<double>(s.choices.size())));
              add(s.key, doc::v_choice(s.choices[i - 1]));
            }
            break;
          case PR_PARAM_COLOR:
            if (v.is_string()) {
              const auto c = doc::parse_color_channels(v.str());
              add(s.key, doc::v_color(c[0], c[1], c[2], c[3]));
            } else if (v.is_array() && v.arr().size() >= 3) {
              const auto& a = v.arr();
              const auto ch = [&](std::size_t i, double def) { return i < a.size() ? number_of(a[i]).value_or(def) : def; };
              add(s.key, doc::v_color(ch(0, 0), ch(1, 0), ch(2, 0), ch(3, 1)));
            }
            break;
          case PR_PARAM_POINT:
          case PR_PARAM_POINT_3D:
            if (v.is_array()) {
              const char* axes = s.type == PR_PARAM_POINT_3D ? "XYZ" : "XY";
              for (std::size_t i = 0; axes[i] != '\0' && i < v.arr().size(); ++i) {  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
                if (const auto n = number_of(v.arr()[i])) add(s.key + axes[i], doc::v_scalar(*n));  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
              }
            }
            break;
          case PR_PARAM_STRING:
            if (v.is_string()) add(s.key, doc::v_string(v.str()));
            break;
          case PR_PARAM_CURVE:
          case PR_PARAM_GRADIENT:
            if (v.is_array()) add(s.key, doc::v_json(js::stringify(v)));
            break;
          default: break;  // LAYER / FILE / PATH / ARBITRARY_DATA / buttons / groups: not a preset's
        }
      } else if (point && key.size() == s.key.size() + 1 && key.starts_with(s.key) &&
                 (key.back() == 'X' || key.back() == 'Y' || (key.back() == 'Z' && s.type == PR_PARAM_POINT_3D))) {
        if (const auto n = number_of(v)) add(key, doc::v_scalar(*n));
      }
    }
  }
  return out;
}

}  // namespace premation::plugins
