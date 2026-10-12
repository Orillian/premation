// Plugin SDK: the comp camera, lights and layer matrices off the document (scene_eval.hpp).
#include "scene_eval.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <functional>

#include "anim.hpp"
#include "host.hpp"
#include "fail.hpp"
#include "jsmath.hpp"
#include "layer_geometry.hpp"
#include "lights3d.hpp"
#include "readers.hpp"
#include "scene.hpp"
#include "timeline.hpp"

namespace premation::plugins {
namespace {

std::int64_t flicks(double seconds) { return static_cast<std::int64_t>(std::llround(seconds * PR_TIME_SCALE)); }

}  // namespace

SceneEval::SceneEval(const doc::SpaceCtx& sc, std::string comp, double compW, double compH)
    : sc_(sc), comp_(std::move(comp)), compW_(compW > 0 ? compW : 1920), compH_(compH > 0 ? compH : 1080) {}

const std::vector<const doc::Node*>& SceneEval::nodes() {
  if (!nodes_) {
    nodes_.emplace();
    std::set<std::string> seen;
    std::function<void(const doc::Node&)> walk = [&](const doc::Node& n) {
      if (!seen.insert(n.id).second) return;
      nodes_->push_back(&n);
      for (const auto& ch : n.children) {
        if (const doc::Node* child = sc_.d.node(ch)) walk(*child);
      }
    };
    if (const doc::Node* root = sc_.d.node(comp_)) walk(*root);
  }
  return *nodes_;
}

bool SceneEval::live_at(const doc::Node& n, double seconds) {
  std::vector<const doc::Bar*> clips = doc::tl_bars_for_node(sc_.d, sc_.view, n.id);
  if (clips.empty()) {
    const doc::Node* cur = &n;
    for (int depth = 0; depth < 32 && cur != nullptr && cur->parent; ++depth) {
      const doc::Node* parent = sc_.d.node(*cur->parent);
      if (parent == nullptr || doc::is_precomp(*parent) || parent->kind() != "group") break;
      clips = doc::tl_bars_for_node(sc_.d, sc_.view, parent->id);
      if (!clips.empty()) break;
      cur = parent;
    }
  }
  if (clips.empty()) return true;
  const double frame = motion::js::round(seconds * doc::tl_fps_for_node(sc_.d, sc_.view, n.id));
  return std::ranges::any_of(clips, [frame](const doc::Bar* b) { return b->active_at(frame); });
}

std::optional<api::RenderCamera3D> SceneEval::camera(double seconds) {
  const std::int64_t k = flicks(seconds);
  if (const auto it = cameras_.find(k); it != cameras_.end()) return it->second;
  const std::vector<const doc::Node*>& ns = nodes();
  const doc::Node* cam = nullptr;
  for (std::size_t i = ns.size(); i-- > 0;) {
    if (ns[i]->kind() == "camera" && ns[i]->visible && live_at(*ns[i], seconds)) {
      cam = ns[i];
      break;
    }
  }
  std::optional<api::RenderCamera3D> out;
  if (cam != nullptr) {
    const motion::xf::Camera xc = doc::camera_at(sc_, *cam, compW_, compH_, seconds);
    api::RenderCamera3D c;
    const motion::xf::Mat4 v = motion::xf::camera_view_matrix(xc);
    const motion::xf::Mat4 p = motion::xf::camera_projection_matrix(xc);
    c.view.assign(v.begin(), v.end());
    c.projection.assign(p.begin(), p.end());
    c.eye = {xc.position.x, xc.position.y, xc.position.z};
    out = std::move(c);
  }
  cameras_.emplace(k, out);
  return out;
}

std::vector<api::RenderLight3D> SceneEval::lights(double seconds) {
  const std::int64_t k = flicks(seconds);
  if (const auto it = lights_.find(k); it != lights_.end()) return it->second;
  std::vector<scene::SceneLight> list;
  doc::PCtx pc{const_cast<doc::Document&>(sc_.d), sc_.view, sc_.expr, sc_.cache};  // NOLINT(cppcoreguidelines-pro-type-const-cast): world_2d_at only reads
  for (const doc::Node* n : nodes()) {
    if (n->kind() != "light" || !n->visible || !live_at(*n, seconds)) continue;
    const scene::LightProps lt = scene::read_node_light(*n);
    if (lt.type == "environment") continue;  // the probe lights through its SH, not light slots
    const double keyTime = doc::comp_to_keyframe_time(sc_.d, sc_.view, n->id, seconds);
    const scene::Values av(doc::anim_evaluate_node(sc_.d, sc_.expr, sc_.cache, n->id, keyTime));
    scene::SceneLight r = scene::scene_light_of(lt);
    r.shadowMap = lt.shadows && lt.type != "ambient";
    r.intensity = av.get("intensity").value_or(lt.intensity);
    r.radius = av.get("radius").value_or(lt.radius);
    r.angle = av.get("lightAngle").value_or(lt.angle) +
              motion::xf::decompose(doc::world_2d_at(pc, n->id, seconds)).rotation * (180 / 3.14159265358979323846);
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
  return lights_.emplace(k, scene::to_shader_lights(list)).first->second;
}

std::optional<motion::xf::Mat4> SceneEval::world(const std::string& id, double seconds) {
  const auto key = std::make_pair(id, flicks(seconds));
  if (const auto it = worlds_.find(key); it != worlds_.end()) return it->second;
  std::optional<motion::xf::Mat4> m;
  if (const doc::Node* n = sc_.d.node(id); n != nullptr && doc::is_3d_enabled(*n)) {
    m = doc::world_3d_at(sc_, id, seconds, compW_, compH_);
  } else if (const auto space = doc::layer_space_at(sc_, id, seconds, compW_, compH_)) {
    if (const auto* flat = std::get_if<motion::xf::LayerSpace2D>(&*space)) m = motion::xf::from_mat2d(flat->world);
  }
  worlds_.emplace(key, m);
  return m;
}

std::optional<motion::xf::Mat4> SceneEval::layer_world(const std::string& id, double seconds) {
  const std::optional<motion::xf::Mat4> w = world(id, seconds);
  if (!w) return std::nullopt;
  std::optional<doc::LayerGeometry> g;
  try {
    g = doc::layer_geometry_at(sc_, nullptr, id, seconds);
  } catch (const doc::EngineFail&) {
    return std::nullopt;  // a text layer with no measurer here: the caller keeps its fallback
  }
  if (!g) return std::nullopt;
  // Layer px p → the document's local space: the box's top-left is (offset − size / 2). A 2D layer's
  // world (world_2d_at) has no anchor term — its content is drawn at world · T(−anchor) — while a 3D
  // layer's (world_3d_at) composes T(−anchor) itself.
  double ax = 0;
  double ay = 0;
  if (const doc::Node* n = sc_.d.node(id); n != nullptr && !doc::is_3d_enabled(*n)) {
    if (const auto local = doc::local_3d_at(sc_, *n, seconds)) {
      ax = local->anchor_x;
      ay = local->anchor_y;
    }
  }
  const motion::xf::Mat4 toLocal{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, g->offsetX - g->width / 2 - ax, g->offsetY - g->height / 2 - ay, 0, 1};
  return motion::xf::multiply(*w, toLocal);
}

void overlay_scene(const doc::SpaceCtx& sc, const EffectSpec& spec, doc::NativeActionRequest& req) {
  const bool cam = spec.has(PR_OUT_FLAG_USES_CAMERA);
  const bool lit = spec.has(PR_OUT_FLAG_USES_LIGHTS);
  const bool xfs = spec.has(PR_OUT_FLAG_USES_LAYER_TRANSFORMS);
  const std::optional<std::string> comp = doc::comp_of_layer(sc.d, req.layer);
  double w = 1920;
  double h = 1080;
  if (comp) {
    if (const js::Json* rec = sc.d.comp(*comp); rec != nullptr) {
      if (rec->at("width").is_number() && rec->at("width").num() > 0) w = rec->at("width").num();
      if (rec->at("height").is_number() && rec->at("height").num() > 0) h = rec->at("height").num();
    }
  }
  doc::NativeScene s;
  s.compW = w;
  s.compH = h;
  if (comp && (cam || lit || xfs)) {
    SceneEval ev(sc, *comp, w, h);
    const double t = req.timeSeconds;
    if (cam) s.camera = ev.camera(t);
    if (lit) s.lights = ev.lights(t);
    if (xfs) {
      for (const ParamSpec& p : spec.params) {
        if (p.type != PR_PARAM_LAYER) continue;
        const js::Json& v = req.params.at(p.key);
        if (!v.is_string() || v.str().empty()) continue;
        if (auto m = ev.layer_world(v.str(), t)) s.matrices.emplace_back(p.key, std::vector<double>(m->begin(), m->end()));
      }
    }
  }
  req.scene = std::move(s);
}

}  // namespace premation::plugins
