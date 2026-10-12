#include "scene_finish.hpp"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <functional>
#include <map>
#include <mutex>
#include <set>
#include <span>
#include <variant>

#include "asset_image.hpp"
#include "effects_port.hpp"
#include "exr_read.hpp"
#include "fx_wire.hpp"
#include "fxstate.hpp"
#include "handlers_native.hpp"
#include "host.hpp"
#include "image_decode.hpp"
#include "jsmath.hpp"
#include "lights3d.hpp"
#include "native_effects.hpp"
#include "readers.hpp"
#include "scene.hpp"
#include "scene_native_fx.hpp"
#include "snapshot_build.hpp"
#include "timeline.hpp"
#include "worldxf.hpp"

namespace premation::plugins {
namespace {

constexpr double kFlicks = PR_TIME_SCALE;
/// The largest reach a plugin's result_rect may add to its layer (the engine's texture limit).
constexpr double kMaxReachPx = 16384;

api::RenderEffectParam& param(api::RenderEffect& e, std::string_view name, api::RenderParamKind kind) {
  for (auto& p : e.params) {
    if (p.name == name) {
      p.kind = kind;
      return p;
    }
  }
  api::RenderEffectParam p;
  p.name = std::string(name);
  p.kind = kind;
  e.params.push_back(std::move(p));
  return e.params.back();
}

void set_num(api::RenderEffect& e, std::string_view name, double v) { param(e, name, api::RenderParamKind::number).number = v; }
void set_flag(api::RenderEffect& e, std::string_view name, bool v) { param(e, name, api::RenderParamKind::flag).number = v ? 1 : 0; }
void set_text(api::RenderEffect& e, std::string_view name, std::string v) {
  param(e, name, api::RenderParamKind::text).text = std::move(v);
}

std::string text_of(const api::RenderEffect& e, std::string_view name) {
  for (const auto& p : e.params) {
    if (p.name == name) return p.text;
  }
  return {};
}

double num_of(const api::RenderEffect& e, std::string_view name, double def) {
  for (const auto& p : e.params) {
    if (p.name == name) return p.number;
  }
  return def;
}

std::int64_t flicks(double seconds) { return static_cast<std::int64_t>(std::llround(seconds * kFlicks)); }

using List = std::vector<api::Renderable>;

void visit(List& list, const std::function<void(api::Renderable&, List&)>& fn) {
  for (std::size_t i = 0; i < list.size(); ++i) {
    fn(list[i], list);
    visit(list[i].precomp_children, fn);
  }
}

void rename_keys(api::Renderable& r, const std::string& suffix, std::map<std::string, std::string>& renamed) {
  const auto rename = [&](std::optional<std::string>& k) {
    if (!k || k->empty()) return;
    const std::string next = *k + suffix;
    renamed.emplace(*k, next);
    k = next;
  };
  rename(r.texture_key);
  rename(r.mask_texture_key);
  rename(r.lut_texture_key);
  if (r.adjustment) rename(r.adjustment->lut_texture_key);
  if (r.generator) rename(r.generator->texture_key);
  for (auto& c : r.precomp_children) rename_keys(c, suffix, renamed);
}

struct Want {
  std::string layer;
  std::int64_t time = 0;      ///< the checkout's layer time (the renderable's id)
  std::int64_t compTime = 0;  ///< where the composition is built for it
  const List* list = nullptr;
};

/// Post-order: a nested list gets its additions before its parent list can reallocate.
void apply_additions(List& list, std::map<const List*, List>& additions) {
  for (auto& r : list) apply_additions(r.precomp_children, additions);
  const auto it = additions.find(&list);
  if (it == additions.end()) return;
  for (auto& r : it->second) list.push_back(std::move(r));
  additions.erase(it);
}

// ── SDK 1.2 assets: the engine's own decoders behind get_asset_image ─────────

bool engine_decode(const std::filesystem::path& file, DecodedAsset& out, std::string& why) {
  std::string ext = file.extension().string();
  std::ranges::transform(ext, ext.begin(), [](char c) { return static_cast<char>(c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c); });
  if (ext == ".exr") {
    std::ifstream f(file, std::ios::binary);
    const std::vector<std::uint8_t> bytes((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    if (bytes.empty()) {
      why = "cannot read the file";
      return false;
    }
    std::string err;
    const std::optional<scene::exr::Image> img = scene::exr::decode(bytes, scene::exr::zlib_inflate(), err);
    if (!img) {
      why = "EXR: " + err;
      return false;
    }
    std::optional<scene::exr::FloatRgba> rgba = scene::exr::to_float_rgba(*img);
    if (!rgba) {
      why = "EXR: no colour channels";
      return false;
    }
    out.image.width = rgba->width;
    out.image.height = rgba->height;
    out.image.rgba = std::move(rgba->rgba);
    out.linear = true;
    out.premultiplied = true;  // OpenEXR's convention
    return true;
  }
  if (!scene::is_still_image_path(file)) {
    out.unsupported = true;
    why = "not an image the engine reads";
    return false;
  }
  scene::DecodedImage img;
  if (!scene::decode_image_file(file, img, why)) return false;
  out.image.width = static_cast<std::int32_t>(img.width);
  out.image.height = static_cast<std::int32_t>(img.height);
  out.image.rgba.resize(img.rgba.size());
  for (std::size_t i = 0; i < img.rgba.size(); ++i) out.image.rgba[i] = static_cast<float>(img.rgba[i]) / 255.0F;
  out.linear = false;         // 8-bit footage is sRGB-encoded
  out.premultiplied = false;  // straight alpha
  return true;
}

// ── SDK 1.2: what an effect checked out at other times (checkout_time) ──────
//
// A light evaluator: the effect's params, the comp camera, the comp lights and
// the LAYER params' world matrices at a time — read straight off the document
// (keyframes, expressions, parenting) the way the frame's own 3D setup reads
// them (threed_port.cpp Scene3D), never a whole frame per time. Within one
// frame every evaluation is kept, so a hundred effects asking for the same
// shutter samples pay once. Comp times between frames map to source times
// between frames (TlSubFrameScope), as the snapshot's motion-blur samples do.
//
// The frame's own time stays the frame's: when the frame shows the comp
// through another camera than its scene camera (a viewer's custom or axis
// view, which never moves) the samples keep the frame's camera too, and when
// the frame's lights are not the scene's (Draft 3D, the form rig) the samples
// keep the frame's lights — so a sample at the frame time equals the frame.
class Sampler {
 public:
  Sampler(const scene::BuildContext& c, std::string_view comp, double t, const api::RenderFrameScene& scene)
      : c_(c), comp_(comp), t_(t), scene_(scene), sc_{c.d, c.view, c.expr, c.cache} {}

  SampleWire sample(const EffectSpec& spec, const api::RenderEffect& e, const std::string& layerId, const std::string& effectId,
                    const doc::NativeLayerClock& clock, const TimeRequest& q) {
    const doc::TlSubFrameScope subFrame;
    SampleWire w;
    w.time = q.time;
    w.what = q.what;
    const double layerSeconds = static_cast<double>(q.time) / kFlicks;
    const double compSeconds = clock.comp_time(layerSeconds);
    if ((q.what & PR_SAMPLE_PARAMS) != 0) w.params = params_at(layerId, effectId, layerSeconds, e);
    if ((q.what & PR_SAMPLE_CAMERA) != 0 && spec.has(PR_OUT_FLAG_USES_CAMERA)) w.camera = camera_at(compSeconds);
    if ((q.what & PR_SAMPLE_LIGHTS) != 0 && spec.has(PR_OUT_FLAG_USES_LIGHTS)) w.lights = lights_at(compSeconds);
    if ((q.what & PR_SAMPLE_LAYER_TRANSFORMS) != 0 && spec.has(PR_OUT_FLAG_USES_LAYER_TRANSFORMS)) {
      for (const ParamSpec& s : spec.params) {
        if (s.type != PR_PARAM_LAYER) continue;
        const std::string id = text_of(e, "p." + s.key);
        if (id.empty()) continue;
        if (auto m = matrix_at(id, compSeconds)) w.matrices.emplace_back(s.key, std::move(*m));
      }
    }
    return w;
  }

  /// SDK 1.1 values a frame with no 3D layer does not carry (it has no camera3d / lights3d):
  /// the scene's own at the frame time. nullopt when the frame carries its own.
  std::optional<std::optional<api::RenderCamera3D>> frame_camera_if_missing() {
    if (frame3d()) return std::nullopt;
    const doc::TlSubFrameScope subFrame;
    return camera_at(t_);
  }
  std::optional<std::vector<api::RenderLight3D>> frame_lights_if_missing() {
    if (frame3d()) return std::nullopt;
    const doc::TlSubFrameScope subFrame;
    return lights_at(t_);
  }

 private:
  [[nodiscard]] bool frame3d() const { return scene_.camera3d && scene_.camera3d->view.size() == 16; }
  [[nodiscard]] double comp_w() const { return scene_.width > 0 ? scene_.width : 1920; }
  [[nodiscard]] double comp_h() const { return scene_.height > 0 ? scene_.height : 1080; }

  const std::vector<const doc::Node*>& nodes() {
    if (!nodes_) {
      nodes_.emplace();
      std::set<std::string> seen;
      std::function<void(const doc::Node&)> walk = [&](const doc::Node& n) {
        if (!seen.insert(n.id).second) return;
        nodes_->push_back(&n);
        for (const auto& ch : n.children) {
          if (const doc::Node* child = c_.d.node(ch)) walk(*child);
        }
      };
      if (const doc::Node* root = c_.d.node(comp_)) walk(*root);
    }
    return *nodes_;
  }

  /// Inside its in/out bar at comp `seconds` (the renderer's isLiveAt: own bars, else a plain group's).
  bool live_at(const doc::Node& n, double seconds) {
    std::vector<const doc::Bar*> clips = doc::tl_bars_for_node(c_.d, c_.view, n.id);
    if (clips.empty()) {
      const doc::Node* cur = &n;
      for (int depth = 0; depth < 32 && cur != nullptr && cur->parent; ++depth) {
        const doc::Node* parent = c_.d.node(*cur->parent);
        if (parent == nullptr || doc::is_precomp(*parent) || parent->kind() != "group") break;
        clips = doc::tl_bars_for_node(c_.d, c_.view, parent->id);
        if (!clips.empty()) break;
        cur = parent;
      }
    }
    if (clips.empty()) return true;
    const double frame = motion::js::round(seconds * doc::tl_fps_for_node(c_.d, c_.view, n.id));
    return std::ranges::any_of(clips, [frame](const doc::Bar* b) { return b->active_at(frame); });
  }

  /// The effect's `p.<key>` chain entries at layer time `layerSeconds` (animatable kinds only).
  std::vector<api::RenderEffectParam> params_at(const std::string& layerId, const std::string& effectId, double layerSeconds,
                                                const api::RenderEffect& frameEntry) {
    std::vector<api::RenderEffectParam> out;
    const doc::Node* n = c_.d.node(layerId);
    if (n == nullptr) return out;
    const js::Json* effect = nullptr;
    const std::vector<js::Json> effects = doc::read_node_effects(*n);
    for (const js::Json& e : effects) {
      if (e.at("id").is_string() && e.at("id").str() == effectId) effect = &e;
    }
    if (effect == nullptr) return out;
    const auto key = std::make_pair(layerId, flicks(layerSeconds));
    auto it = values_.find(key);
    if (it == values_.end()) {
      it = values_.emplace(key, scene::Values(doc::anim_evaluate_node(c_.d, c_.expr, c_.cache, layerId, layerSeconds))).first;
    }
    const std::vector<js::Json> resolved = scene::resolve_effect_params({*effect}, it->second, layerSeconds);
    if (resolved.empty()) return out;
    scene::RLayer l;
    l.id = layerId;
    l.width = num_of(frameEntry, "layerW", 0);
    l.height = num_of(frameEntry, "layerH", 0);
    std::optional<api::RenderEffect> entry = scene::native_effect_entry(resolved[0], doc::params_of(resolved[0]), l);
    if (!entry) return out;
    for (api::RenderEffectParam& p : entry->params) {
      const bool animatable = p.kind == api::RenderParamKind::number || p.kind == api::RenderParamKind::flag ||
                              p.kind == api::RenderParamKind::color;
      if (p.name.starts_with("p.") && animatable && !p.name.ends_with(".closed")) out.push_back(std::move(p));
    }
    return out;
  }

  std::optional<api::RenderCamera3D> eval_camera(double seconds) {
    const std::vector<const doc::Node*>& ns = nodes();
    const doc::Node* cam = nullptr;
    for (std::size_t i = ns.size(); i-- > 0;) {
      if (ns[i]->kind() == "camera" && ns[i]->visible && live_at(*ns[i], seconds)) {
        cam = ns[i];
        break;
      }
    }
    if (cam == nullptr) return std::nullopt;
    const motion::xf::Camera xc = doc::camera_at(sc_, *cam, comp_w(), comp_h(), seconds);
    api::RenderCamera3D out;
    const motion::xf::Mat4 v = motion::xf::camera_view_matrix(xc);
    const motion::xf::Mat4 p = motion::xf::camera_projection_matrix(xc);
    out.view.assign(v.begin(), v.end());
    out.projection.assign(p.begin(), p.end());
    out.eye = {xc.position.x, xc.position.y, xc.position.z};
    if (scene_.camera3d && scene_.camera3d->dof) out.dof = scene_.camera3d->dof;  // the lens settings of the frame
    return out;
  }

  static bool same_matrix(const std::vector<double>& a, const std::vector<double>& b) {
    if (a.size() != b.size()) return false;
    for (std::size_t i = 0; i < a.size(); ++i) {
      if (std::abs(a[i] - b[i]) > 1e-6 * std::max(1.0, std::abs(a[i]))) return false;
    }
    return true;
  }

  std::optional<api::RenderCamera3D> camera_at(double seconds) {
    if (cameraFollowsFrame_ < 0) {
      // A frame with no 3D layer carries no camera: the scene's own is evaluated (AE gives a
      // plugin on a 2D solid the comp camera). One that shows another view keeps it.
      const bool frameHas = frame3d();
      const auto atFrame = frameHas ? eval_camera(t_) : std::nullopt;
      cameraFollowsFrame_ = frameHas && (!atFrame || !(same_matrix(scene_.camera3d->view, atFrame->view) &&
                                                       same_matrix(scene_.camera3d->projection, atFrame->projection)))
                                ? 1
                                : 0;
    }
    if (cameraFollowsFrame_ == 1) return scene_.camera3d;
    const std::int64_t k = flicks(seconds);
    auto it = cameras_.find(k);
    if (it == cameras_.end()) it = cameras_.emplace(k, eval_camera(seconds)).first;
    return it->second;
  }

  std::vector<api::RenderLight3D> eval_lights(double seconds) {
    std::vector<scene::SceneLight> list;
    doc::PCtx pc{const_cast<doc::Document&>(c_.d), c_.view, c_.expr, c_.cache};  // NOLINT(cppcoreguidelines-pro-type-const-cast): world_2d_at only reads
    for (const doc::Node* n : nodes()) {
      if (n->kind() != "light" || !n->visible || !live_at(*n, seconds)) continue;
      const scene::LightProps lt = scene::read_node_light(*n);
      if (lt.type == "environment") continue;  // the probe lights through its SH, not light slots
      const double keyTime = doc::comp_to_keyframe_time(c_.d, c_.view, n->id, seconds);
      const scene::Values av(doc::anim_evaluate_node(c_.d, c_.expr, c_.cache, n->id, keyTime));
      scene::SceneLight r = scene::scene_light_of(lt);
      r.shadowMap = lt.shadows && lt.type != "ambient";
      r.intensity = av.get("intensity").value_or(lt.intensity);
      r.radius = av.get("radius").value_or(lt.radius);
      r.angle = av.get("lightAngle").value_or(lt.angle) + motion::xf::decompose(doc::world_2d_at(pc, n->id, seconds)).rotation * (180 / 3.14159265358979323846);
      r.cone = av.get("lightCone").value_or(lt.cone);
      r.coneFeather = av.get("lightConeFeather").value_or(lt.coneFeather);
      r.falloffDistance = av.get("falloffDistance").value_or(lt.falloffDistance);
      r.shadowDarkness = av.get("shadowDarkness").value_or(lt.shadowDarkness);
      r.shadowDiffusion = av.get("shadowDiffusion").value_or(lt.shadowDiffusion);
      const auto g = doc::read_geometry_local(*n);
      double z = 0;
      if (const doc::Component* t = n->comp("Transform"); t != nullptr && t->props.at("z").is_number()) z = t->props.at("z").num();
      const motion::xf::Vec3 wp = doc::world_point_at(
          sc_, n->id, seconds, {av.get("x").value_or(g ? g->x : 0), av.get("y").value_or(g ? g->y : 0), av.get("z").value_or(z)});
      r.x = wp.x;
      r.y = wp.y;
      r.z = wp.z;
      const std::optional<double> px = av.get("poiX") ? av.get("poiX") : lt.poi ? std::optional<double>((*lt.poi)[0]) : std::nullopt;
      const std::optional<double> py = av.get("poiY") ? av.get("poiY") : lt.poi ? std::optional<double>((*lt.poi)[1]) : std::nullopt;
      const std::optional<double> pz = av.get("poiZ") ? av.get("poiZ") : lt.poi ? std::optional<double>((*lt.poi)[2]) : std::nullopt;
      if (px || py || pz) {
        const motion::xf::Vec3 w = doc::world_point_at(sc_, n->id, seconds, {px.value_or(0), py.value_or(0), pz.value_or(0)});
        r.poi = std::array<double, 3>{w.x, w.y, w.z};
      } else {
        r.poi = std::nullopt;
      }
      list.push_back(std::move(r));
    }
    return scene::to_shader_lights(list);
  }

  std::vector<api::RenderLight3D> lights_at(double seconds) {
    if (lightsFollowFrame_ < 0) lightsFollowFrame_ = frame3d() && eval_lights(t_).size() != scene_.lights3d.size() ? 1 : 0;
    if (lightsFollowFrame_ == 1) return scene_.lights3d;
    const std::int64_t k = flicks(seconds);
    auto it = lights_.find(k);
    if (it == lights_.end()) it = lights_.emplace(k, eval_lights(seconds)).first;
    return it->second;
  }

  /// A layer's own layer → world 4×4 off the document (2D: its affine at z = 0).
  std::optional<motion::xf::Mat4> world_of(const std::string& id, double seconds) {
    const auto key = std::make_pair(id, flicks(seconds));
    if (const auto it = worlds_.find(key); it != worlds_.end()) return it->second;
    std::optional<motion::xf::Mat4> m;
    if (const doc::Node* n = c_.d.node(id); n != nullptr && doc::is_3d_enabled(*n)) {
      m = doc::world_3d_at(sc_, id, seconds, comp_w(), comp_h());
    } else if (const auto space = doc::layer_space_at(sc_, id, seconds, comp_w(), comp_h())) {
      if (const auto* flat = std::get_if<motion::xf::LayerSpace2D>(&*space)) m = motion::xf::from_mat2d(flat->world);
    }
    worlds_.emplace(key, m);
    return m;
  }

  /// A LAYER param's matrix at comp `seconds`, in the frame's convention: the frame's renderable
  /// matrix moved by how the layer moved since the frame (W(t) · W(frame)⁻¹ · R(frame)).
  std::optional<std::vector<double>> matrix_at(const std::string& id, double seconds) {
    const api::Renderable* r = find_renderable_in(scene_.renderables, id);
    if (r == nullptr) return std::nullopt;
    const std::optional<std::vector<double>> frameM = renderable_world_matrix(*r);
    const std::optional<motion::xf::Mat4> wf = world_of(id, t_);
    const std::optional<motion::xf::Mat4> wt = world_of(id, seconds);
    if (!frameM || !wf || !wt) return std::nullopt;
    const std::optional<motion::xf::Mat4> inv = motion::xf::invert(*wf);
    if (!inv) return std::nullopt;
    motion::xf::Mat4 rf{};
    std::copy_n(frameM->begin(), 16, rf.begin());
    const motion::xf::Mat4 out = motion::xf::multiply(*wt, motion::xf::multiply(*inv, rf));
    return std::vector<double>(out.begin(), out.end());
  }

  const scene::BuildContext& c_;
  std::string comp_;
  double t_;
  const api::RenderFrameScene& scene_;
  doc::SpaceCtx sc_;
  std::optional<std::vector<const doc::Node*>> nodes_;
  int cameraFollowsFrame_ = -1;
  int lightsFollowFrame_ = -1;
  std::map<std::int64_t, std::optional<api::RenderCamera3D>> cameras_;
  std::map<std::int64_t, std::vector<api::RenderLight3D>> lights_;
  std::map<std::pair<std::string, std::int64_t>, std::optional<motion::xf::Mat4>> worlds_;
  std::map<std::pair<std::string, std::int64_t>, scene::Values> values_;
};

}  // namespace

void finish_native_frame(const scene::BuildContext& c, std::string_view comp, double t, const scene::ViewSpec& view,
                         bool motionBlur, scene::NativeFrame& frame, PluginHost* host) {
  static std::once_flag decoders;
  std::call_once(decoders, [] { set_asset_image_decoder(&engine_decode); });
  const std::int64_t tf = flicks(t);
  const scene::MotionBlurCfg mb = scene::motion_blur_of(c.d, comp);
  double fps = mb.fps;
  if (!(fps > 0)) fps = 30;
  const auto step = static_cast<std::int64_t>(std::llround(kFlicks / fps));
  const double compW = frame.file.scene.width;
  const double compH = frame.file.scene.height;
  std::vector<Want> wants;
  std::set<std::string> reported;
  Sampler sampler(c, comp, t, frame.file.scene);

  visit(frame.file.scene.renderables, [&](api::Renderable& r, List& list) {
    bool blursItself = false;
    for (api::RenderEffect& e : r.effects) {
      if (e.type != kNativeFxType) continue;
      const std::string layerId = text_of(e, "layerId");
      const std::string instance = text_of(e, "instance");
      const std::string matchName = text_of(e, "matchName");
      const std::size_t slash = instance.rfind('/');
      const std::string effectId = slash == std::string::npos ? std::string() : instance.substr(slash + 1);
      const doc::Node* node = c.d.node(layerId);
      // SDK 1.2 (S3): the layer's own time — start offset, Time Stretch, reverse, freeze — the
      // mapping its keyframes use; checkouts at other times are layer times too.
      const doc::NativeLayerClock clock = doc::native_layer_clock(c.d, c.view, layerId, t);
      const std::int64_t lt = node != nullptr ? flicks(clock.layer_time(t)) : tf;
      set_num(e, "compTime", static_cast<double>(tf));
      set_num(e, "layerTime", static_cast<double>(lt));
      set_num(e, "layerStart", static_cast<double>(node != nullptr ? flicks(clock.comp_time(0)) : 0));
      set_num(e, "timeStep", static_cast<double>(step));
      set_num(e, "fps", fps);
      set_num(e, "compW", compW);
      set_num(e, "compH", compH);
      set_flag(e, "layer3d", r.three_d.has_value());
      // SDK 1.2 (S2): the comp's shutter; on when the render, the comp and the layer all blur.
      const bool blurOn = motionBlur && mb.enabled && node != nullptr && scene::read_node_motion_blur(*node);
      set_flag(e, "mb", blurOn);
      set_num(e, "shutterAngle", mb.shutterAngle);
      set_num(e, "shutterPhase", mb.shutterPhase);
      set_num(e, "mbSamples", mb.samples);
      // The instance's state, from the document (fx.pluginData, base64 as stored).
      if (node != nullptr) {
        const js::Json& group = node->fx().at("pluginData").at(doc::native_data_group(effectId));
        const js::Json& seq = group.at(doc::kNativeSequenceKey);
        if (seq.is_string()) set_text(e, "sequence", seq.str());
        if (const doc::NativeEffect* ne = doc::NativeEffects::find(matchName)) {
          for (const std::string& key : ne->arbitrary) {
            const js::Json& a = group.at(doc::native_arb_key(key));
            if (a.is_string()) set_text(e, "a." + key, a.str());
          }
          // SDK 1.1 FILE params: the project item as a file; a missing one is the layer's error, not a crash.
          for (const auto& [key, types] : ne->files) {
            const doc::NativeActionRequest::File f = doc::native_file_of(c.d, key, text_of(e, "p." + key));
            encode_native_file(e, f);
            if (f.missing && reported.insert(instance + "#" + key).second) {
              frame.errors.push_back(scene::LayerError{layerId, "", "plugin",
                                                       "file '" + (f.name.empty() ? f.item : f.name) + "' is missing (" + matchName + ")"});
            }
          }
        }
      }
      if (host == nullptr) continue;
      if (std::string why; host->instance_disabled(instance, &why)) {
        if (reported.insert(instance).second) frame.errors.push_back(scene::LayerError{layerId, "", "plugin", why});
        continue;
      }
      const EffectSpec* spec = host->effect(matchName);
      if (spec == nullptr) {
        if (reported.insert(instance).second) {
          frame.errors.push_back(scene::LayerError{layerId, "", "plugin", "no loaded plugin provides '" + matchName + "'"});
        }
        continue;
      }
      // SDK 1.1: the camera / lights / layer matrices the effect declared it reads, at this frame
      // (SDK 1.2: a frame with no 3D layer still gives the comp's camera and lights).
      {
        std::optional<std::optional<api::RenderCamera3D>> cam;
        std::optional<std::vector<api::RenderLight3D>> lights;
        if (spec->has(PR_OUT_FLAG_USES_CAMERA)) cam = sampler.frame_camera_if_missing();
        if (spec->has(PR_OUT_FLAG_USES_LIGHTS)) lights = sampler.frame_lights_if_missing();
        encode_native_scene(e, *spec, frame.file.scene, cam && *cam ? &**cam : nullptr, lights ? &*lights : nullptr);
      }
      if (blurOn && spec->has(PR_OUT_FLAG_USES_SHUTTER)) blursItself = true;
      if (!spec->has(PR_OUT_FLAG_SMART_RENDER)) continue;
      // SMART_PRE_RENDER in the layer's own pixels: the checkouts at other times (WIDE_TIME_INPUT),
      // the times it samples (SDK 1.2 SAMPLES_TIME) and how far its result reaches past the layer.
      RenderInputs in;
      decode_native_fx(e, *spec, in);
      in.worldW = std::max(1, in.layerW);
      in.worldH = std::max(1, in.layerH);
      std::vector<CheckoutRequest> reqs;
      PreRenderInfo info;
      const CallResult pr = host->pre_render(in, reqs, &info);
      if (!pr.ok) {
        if (!pr.skipped && reported.insert(instance).second) frame.errors.push_back(scene::LayerError{layerId, "", "plugin", pr.message});
        continue;
      }
      // SDK 1.2 (S4): a result past the layer grows its effect buffer (fx_wire.hpp reachPx).
      double reach = spec->has(PR_OUT_FLAG_COMP_SPACE) ? std::hypot(compW, compH) : 0;
      reach = std::max({reach, static_cast<double>(-info.result.left), static_cast<double>(-info.result.top),
                        static_cast<double>(info.result.right - in.worldW), static_cast<double>(info.result.bottom - in.worldH)});
      if (reach > 0) set_num(e, "reachPx", std::min(reach, kMaxReachPx));
      // SDK 1.2 (S1): evaluate what it asked for at other times; the values travel with the frame.
      if (spec->has(PR_OUT_FLAG_SAMPLES_TIME) && !info.times.empty()) {
        std::vector<SampleWire> wires;
        wires.reserve(info.times.size());
        for (const TimeRequest& q : info.times) {
          if (q.time == lt) continue;  // the frame's own time: the entry already is that
          wires.push_back(sampler.sample(*spec, e, layerId, effectId, clock, q));
        }
        if (!wires.empty()) encode_native_samples(e, *spec, std::move(wires));
      }
      if (!spec->has(PR_OUT_FLAG_WIDE_TIME_INPUT)) continue;
      for (const CheckoutRequest& q : reqs) {
        if (q.time == lt) continue;  // "now" is the chain's own input / a live layer
        std::string layer = q.paramIndex == 0 ? layerId : q.paramIndex - 1 < in.values.size() ? in.values[q.paramIndex - 1].layer : "";
        if (layer.empty()) continue;
        // A checkout's time is the effect layer's time: the composition is built at its comp time.
        const std::int64_t at = node != nullptr ? flicks(clock.comp_time(static_cast<double>(q.time) / kFlicks)) : q.time;
        wants.push_back({std::move(layer), q.time, at, &list});
      }
    }
    // SDK 1.2 (S2): an effect that renders its own motion blur — the layer is not supersampled through it.
    if (blursItself) r.motion_samples.clear();
  });

  if (wants.empty()) return;
  std::map<std::int64_t, scene::NativeFrame> atTime;
  std::map<const List*, List> additions;
  std::set<std::pair<const List*, std::string>> added;
  for (const Want& w : wants) {
    const std::string id = checkout_renderable_id(w.layer, w.time);
    if (!added.insert({w.list, id}).second || find_renderable_in(*w.list, id) != nullptr) continue;
    auto it = atTime.find(w.compTime);
    if (it == atTime.end()) {
      scene::NativeFrame other = scene::build_native_frame(c, comp, static_cast<double>(w.compTime) / kFlicks, view, motionBlur);
      it = atTime.emplace(w.compTime, std::move(other)).first;
    }
    const scene::NativeFrame& other = it->second;
    const api::Renderable* src = find_renderable_in(other.file.scene.renderables, w.layer);
    if (src == nullptr) continue;  // the layer does not exist / is not drawn at that time: an empty checkout
    api::Renderable copy = *src;
    copy.id = id;
    copy.matte_source = true;  // never drawn by the composition; checked out by id
    copy.effects.clear();      // a checkout is the layer's source pixels (see PLUGIN_SDK.md)
    copy.matte.reset();
    copy.adjustment.reset();
    std::map<std::string, std::string> renamed;
    rename_keys(copy, "@" + std::to_string(w.time), renamed);
    for (const scene::TextureRequest& req : other.textures) {
      const auto k = renamed.find(req.key);
      if (k == renamed.end()) continue;
      scene::TextureRequest moved = req;
      moved.key = k->second;
      frame.textures.push_back(std::move(moved));
    }
    additions[w.list].push_back(std::move(copy));
  }
  apply_additions(frame.file.scene.renderables, additions);
}

}  // namespace premation::plugins
