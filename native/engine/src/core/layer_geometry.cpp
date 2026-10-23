#include "layer_geometry.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <limits>
#include <numbers>
#include <string>
#include <utility>
#include <vector>

#include "anim.hpp"
#include "fail.hpp"
#include "fxstate.hpp"
#include "scene.hpp"
#include "scene/session_hooks.hpp"
#include "timeline.hpp"

namespace premation::doc {
namespace {

using api::ErrorCode;
using Values = std::vector<std::pair<std::string, double>>;

/// geometry.ts `isDrawableKind`, plus `adjustment` (B1, docs/PROGRAM_3D_PERF_UX.md):
/// an adjustment layer's quad is its box (frame_build.cpp adjustment_to_renderable:
/// width × height centred on its position, the comp's size when it has none),
/// so getLayerBounds answers that box instead of nothing.
bool is_drawable_kind(const std::string& kind) {
  if (kind.find('.') != std::string::npos) return true;
  return kind == "shape" || kind == "text" || kind == "image" || kind == "video" || kind == "svg" || kind == "light" ||
         kind == "camera" || kind == "particle" || kind == "comp" || kind == "null" || kind == "group" ||
         kind == "adjustment";
}

std::optional<double> value_of(const Values& av, std::string_view k) {
  for (const auto& [prop, v] : av) {
    if (prop == k) return v;
  }
  return std::nullopt;
}

/// geometry.ts `animatedPropsOf` at `seconds` (the node's keyframe axis).
Values animated_at(const SpaceCtx& c, std::string_view node, double seconds) {
  const NodeAnim* a = c.d.anim(node);
  if (a == nullptr || a->empty()) return {};
  return anim_evaluate_node(c.d, c.expr, c.cache, node, comp_to_keyframe_time(c.d, c.view, node, seconds));
}

/// The layer's composition size (geometry.ts reads the active comp; the layer's own is the one it is drawn in).
std::pair<double, double> comp_size_of(const Document& d, std::string_view node) {
  if (const auto comp = comp_of_layer(d, node)) {
    if (const Json* rec = d.comp(*comp)) {
      const double w = rec->at("width").is_number() && rec->at("width").num() != 0 ? rec->at("width").num() : 1920;
      const double h = rec->at("height").is_number() && rec->at("height").num() != 0 ? rec->at("height").num() : 1080;
      return {w, h};
    }
  }
  return {1920, 1080};
}

/// buildSnapshot.ts SIZE, keyed by RENDER kind (an svg renders as an image).
std::pair<double, double> kind_size(const std::string& kind, double compW, double compH) {
  if (kind == "light" || kind == "camera") return {48, 48};
  if (kind == "particle") return {140, 140};
  if (kind == "null") return {60, 60};
  if (kind == "group") return {280, 280};
  if (kind == "comp" || kind == "adjustment") return {compW, compH};  // B1: a size-less adjustment layer is comp-sized
  if (kind == "svg" || kind == "image") return {280, 180};
  if (kind == "shape") return {220, 220};
  if (kind == "text") return {320, 80};
  if (kind == "video") return {480, 270};
  return {100, 100};
}

bool name_is_round(const std::string& name) {
  std::string lower = name;
  for (char& ch : lower) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
  return lower.find("circle") != std::string::npos || lower.find("ellip") != std::string::npos ||
         lower.find("dot") != std::string::npos || lower.find("orb") != std::string::npos;
}

std::optional<LayerGeometry> geometry(const SpaceCtx& c, TextQueries* text, const Node& n, double seconds, int depth);

/// geometry.ts `groupContentBounds(node, depth, live = true)` at `seconds`.
struct Box {
  double minX, minY, maxX, maxY;
};

/// A running min/max over points, for a path's exact extent.
struct Extent {
  double minX = std::numeric_limits<double>::infinity();
  double minY = std::numeric_limits<double>::infinity();
  double maxX = -std::numeric_limits<double>::infinity();
  double maxY = -std::numeric_limits<double>::infinity();
  void add(double x, double y) {
    if (!std::isfinite(x) || !std::isfinite(y)) return;
    minX = std::min(minX, x);
    minY = std::min(minY, y);
    maxX = std::max(maxX, x);
    maxY = std::max(maxY, y);
  }
  [[nodiscard]] bool ok() const { return std::isfinite(minX) && std::isfinite(maxX) && std::isfinite(minY) && std::isfinite(maxY); }
};

/// One axis of a cubic Bézier: the parameters in (0, 1) where it turns (its
/// derivative's roots), so the extent covers the curve, not its control hull.
void cubic_turns(double p0, double p1, double p2, double p3, std::vector<double>& ts) {
  const double a = -p0 + 3 * p1 - 3 * p2 + p3;
  const double b = 2 * (p0 - 2 * p1 + p2);
  const double c = p1 - p0;
  const auto keep = [&ts](double t) {
    if (t > 0 && t < 1) ts.push_back(t);
  };
  if (std::abs(a) < 1e-12) {
    if (std::abs(b) > 1e-12) keep(-c / b);
    return;
  }
  const double disc = b * b - 4 * a * c;
  if (disc < 0) return;
  const double s = std::sqrt(disc);
  keep((-b + s) / (2 * a));
  keep((-b - s) / (2 * a));
}

/// The exact extent of a path run (BezierPoint[]: x, y and optional in/out
/// handles, which default to the vertex): what the shape draws, which is the
/// box After Effects puts around a shape layer — not the width × height the
/// shape was made in (a star inscribed in its ellipse sat in a box wider and
/// taller than its points).
void add_path(Extent& e, const Json& pts, bool open) {
  if (!pts.is_array() || pts.arr().empty()) return;
  struct P {
    double x, y, inX, inY, outX, outY;
  };
  std::vector<P> ps;
  ps.reserve(pts.arr().size());
  for (const Json& p : pts.arr()) {
    if (!p.at("x").is_number() || !p.at("y").is_number()) continue;
    const double x = p.at("x").num();
    const double y = p.at("y").num();
    const auto handle = [&p](const char* k, double fallback) { return p.at(k).is_number() ? p.at(k).num() : fallback; };
    ps.push_back({x, y, handle("inX", x), handle("inY", y), handle("outX", x), handle("outY", y)});
  }
  if (ps.empty()) return;
  for (const P& p : ps) e.add(p.x, p.y);
  const std::size_t segs = open ? ps.size() - 1 : ps.size();
  std::vector<double> ts;
  for (std::size_t i = 0; i < segs; ++i) {
    const P& a = ps[i];
    const P& b = ps[(i + 1) % ps.size()];
    ts.clear();
    cubic_turns(a.x, a.outX, b.inX, b.x, ts);
    cubic_turns(a.y, a.outY, b.inY, b.y, ts);
    for (const double t : ts) {
      const double u = 1 - t;
      const double w0 = u * u * u;
      const double w1 = 3 * u * u * t;
      const double w2 = 3 * u * t * t;
      const double w3 = t * t * t;
      e.add(w0 * a.x + w1 * a.outX + w2 * b.inX + w3 * b.x, w0 * a.y + w1 * a.outY + w2 * b.inY + w3 * b.y);
    }
  }
}

/// A parametric polystar's outline at the time (path_ops.cpp `apply_polystar`, the same vertices and handles).
void add_polystar(Extent& e, const Json& cfg, const Values& av) {
  const auto v = [&](const char* param) {
    std::string path = "polystar.";
    path += param;
    if (const auto animated = value_of(av, path)) return *animated;
    return cfg.at(param).is_number() ? cfg.at(param).num() : 0.0;
  };
  constexpr double kPi = std::numbers::pi;
  const bool star = cfg.at("starType").is_string() && cfg.at("starType").str() == "star";
  const double cnt = std::max(3.0, std::round(v("points")));
  const double total = star ? cnt * 2 : cnt;
  const double step = (kPi * 2) / total;
  const double start = (v("rotation") - 90) * kPi / 180;
  const double outerRadius = std::max(0.0, v("outerRadius"));
  const double innerRadius = std::max(0.0, v("innerRadius"));
  Json pts = Json::array();
  for (double i = 0; i < total; ++i) {
    const bool outer = !star || std::fmod(i, 2.0) == 0;
    const double r = outer ? outerRadius : innerRadius;
    const double pct = (outer ? v("outerRoundness") : v("innerRoundness")) / 100;
    const double ang = start + i * step;
    const double x = std::cos(ang) * r;
    const double y = std::sin(ang) * r;
    const double tx = -std::sin(ang);
    const double ty = std::cos(ang);
    const double hl = (kPi * r * pct) / (2 * cnt);
    Json p = Json::object();
    p.set("x", Json::number(x));
    p.set("y", Json::number(y));
    p.set("inX", Json::number(x - tx * hl));
    p.set("inY", Json::number(y - ty * hl));
    p.set("outX", Json::number(x + tx * hl));
    p.set("outY", Json::number(y + ty * hl));
    pts.arr_mut().push_back(std::move(p));
  }
  add_path(e, pts, false);
}

/// A shape layer's drawn outline extent at `seconds`, in layer space: the
/// parametric polystar, else the animated path, else the stored Geometry
/// (one path or its subpaths). nullopt = the shape has no path (rect, ellipse).
std::optional<Box> shape_path_extent(const SpaceCtx& c, const Node& n, const Values& av, double seconds) {
  Extent e;
  if (const auto cfg = read_node_polystar(n)) {
    add_polystar(e, *cfg, av);
  } else {
    bool live = false;
    if (const DataTrack* tr = anim_data_track(c.d, n.id, "path.points")) {
      if (const auto pts = sample_data_track(*tr, comp_to_keyframe_time(c.d, c.view, n.id, seconds));
          pts && pts->is_array() && pts->arr().size() > 1) {
        const Component* geom = n.comp("Geometry");
        add_path(e, *pts, geom != nullptr && geom->props.at("open").is_bool() && geom->props.at("open").b());
        live = e.ok();
      }
    }
    if (!live) {
      for (const Component& comp : n.components) {
        const Json& pts = comp.props.at("points");
        const bool open = comp.props.at("open").is_bool() && comp.props.at("open").b();
        if (pts.is_array() && !pts.arr().empty()) add_path(e, pts, open);
        if (comp.type != "Geometry" || !comp.props.at("subpaths").is_array()) continue;
        for (const Json& sp : comp.props.at("subpaths").arr()) {
          add_path(e, sp.at("points"), sp.at("open").is_bool() && sp.at("open").b());
        }
      }
    }
  }
  if (!e.ok()) return std::nullopt;
  return Box{e.minX, e.minY, e.maxX, e.maxY};
}
std::optional<Box> group_union(const SpaceCtx& c, TextQueries* text, const Node& n, double seconds, int depth) {
  if (depth > 16) return std::nullopt;  // cycle guard
  if (n.children.empty()) return std::nullopt;
  constexpr double kInf = std::numeric_limits<double>::infinity();
  Box b{kInf, kInf, -kInf, -kInf};
  for (const std::string& id : n.children) {
    const Node* child = c.d.node(id);
    if (child == nullptr) continue;
    const auto g = geometry(c, text, *child, seconds, depth + 1);
    if (!g) continue;
    const double halfW = std::abs(g->width * g->scaleX) / 2;
    const double halfH = std::abs(g->height * g->scaleY) / 2;
    const double cx = g->x + g->offsetX * g->scaleX;
    const double cy = g->y + g->offsetY * g->scaleY;
    b.minX = std::min(b.minX, cx - halfW);
    b.minY = std::min(b.minY, cy - halfH);
    b.maxX = std::max(b.maxX, cx + halfW);
    b.maxY = std::max(b.maxY, cy + halfH);
  }
  if (!std::isfinite(b.minX) || !std::isfinite(b.minY) || !std::isfinite(b.maxX) || !std::isfinite(b.maxY)) return std::nullopt;
  return b;
}

std::optional<LayerGeometry> geometry(const SpaceCtx& c, TextQueries* text, const Node& n, double seconds, int depth) {
  const std::string kind = n.kind();
  if (!is_drawable_kind(kind)) return std::nullopt;
  const Values av = animated_at(c, n.id, seconds);

  std::optional<double> x, y, rotation, scaleX, scaleY, scale, width, height, radius;
  std::optional<std::string> shapeType;
  for (const Component& comp : n.components) {
    const Json& p = comp.props;
    if (p.at("x").is_number()) x = p.at("x").num();
    if (p.at("y").is_number()) y = p.at("y").num();
    if (p.at("rotation").is_number()) rotation = p.at("rotation").num();
    if (p.at("scaleX").is_number()) scaleX = p.at("scaleX").num();
    if (p.at("scaleY").is_number()) scaleY = p.at("scaleY").num();
    if (p.at("scale").is_number()) scale = p.at("scale").num();
    if (p.at("width").is_number()) width = p.at("width").num();
    if (p.at("height").is_number()) height = p.at("height").num();
    if (p.at("shapeType").is_string()) shapeType = p.at("shapeType").str();
    if (p.at("radius").is_number()) radius = p.at("radius").num();
    else if (p.at("outerRadius").is_number()) radius = p.at("outerRadius").num();
    else if (p.at("r").is_number()) radius = p.at("r").num();
  }
  // The evaluated values at the time win.
  for (const char* k : {"x", "y", "rotation", "scaleX", "scaleY", "scale", "width", "height"}) {
    const auto v = value_of(av, k);
    if (!v) continue;
    const std::string_view key = k;
    if (key == "x") x = v;
    else if (key == "y") y = v;
    else if (key == "rotation") rotation = v;
    else if (key == "scaleX") scaleX = v;
    else if (key == "scaleY") scaleY = v;
    else if (key == "scale") scale = v;
    else if (key == "width") width = v;
    else height = v;
  }

  // A shape's drawn outline (exact, at the time). It is the box: the
  // width × height a path shape was made in is only where its points started.
  std::optional<Box> pathBox;
  std::optional<std::pair<double, double>> pointsBounds;
  if (kind == "shape") {
    pathBox = shape_path_extent(c, n, av, seconds);
    if (pathBox) pointsBounds = std::pair<double, double>{std::max(1.0, pathBox->maxX - pathBox->minX), std::max(1.0, pathBox->maxY - pathBox->minY)};
  }

  // Text sizes to its MEASURED box (the text port: fixed paragraph box, else the font box).
  std::optional<TextGeometry> measured;
  if (kind == "text") {
    if (text == nullptr) fail(ErrorCode::unsupported, "text is measured with fonts, which this engine has none of (headless)", {.layer = n.id});
    measured = text->text_geometry(n, av);
    if (!measured) fail(ErrorCode::unsupported, "this text style is outside the engine's text port", {.layer = n.id});
  }

  const auto [compW, compH] = comp_size_of(c.d, n.id);
  std::pair<double, double> size;
  if (measured) size = {measured->width, measured->height};
  else if (pointsBounds) size = *pointsBounds;
  else if (kind == "light" || kind == "camera") size = {48, 48};
  else if (radius && *radius > 0) size = {*radius * 2, *radius * 2};
  else size = kind_size(kind, compW, compH);

  const bool hasAuthoredDim = width && height && *width > 0 && *height > 0;
  double finalW = measured ? measured->width : pointsBounds ? pointsBounds->first : hasAuthoredDim ? *width : size.first;
  double finalH = measured ? measured->height : pointsBounds ? pointsBounds->second : hasAuthoredDim ? *height : size.second;
  double offsetX = pathBox ? (pathBox->minX + pathBox->maxX) / 2 : 0;
  double offsetY = measured ? measured->dy : pathBox ? (pathBox->minY + pathBox->maxY) / 2 : 0;

  // Full-frame solids: an unseeded solid fills the composition.
  bool isSolid = false;
  if (kind == "shape") {
    for (const Component& comp : n.components) {
      if (comp.type == "fx" && comp.props.at("solid").is_bool() && comp.props.at("solid").b()) isSolid = true;
    }
  }
  const ViewTransform vt = view_transform(n);
  double finalX = x.value_or(vt.x);
  double finalY = y.value_or(vt.y);
  if (isSolid && (!hasAuthoredDim || (*width == 100 && *height == 100))) {
    finalW = compW;
    finalH = compH;
    finalX = compW / 2;
    finalY = compH / 2;
  }

  // A group wraps its content at the time.
  if (kind == "group") {
    if (const auto b = group_union(c, text, n, seconds, depth)) {
      finalW = std::max(1.0, b->maxX - b->minX);
      finalH = std::max(1.0, b->maxY - b->minY);
      offsetX = (b->minX + b->maxX) / 2;
      offsetY = (b->minY + b->maxY) / 2;
    }
  }

  LayerGeometry g;
  g.x = finalX;
  g.y = finalY;
  g.rotationDeg = rotation.value_or(vt.rotation);
  g.width = finalW;
  g.height = finalH;
  g.scaleX = scaleX ? *scaleX : scale.value_or(1);
  g.scaleY = scaleY ? *scaleY : scale.value_or(1);
  g.ellipse = shapeType ? *shapeType == "ellipse" : name_is_round(n.name);
  g.offsetX = offsetX;
  g.offsetY = offsetY;
  return g;
}

}  // namespace

std::optional<LayerGeometry> layer_geometry_at(const SpaceCtx& c, TextQueries* text, std::string_view node, double seconds) {
  const Node* n = c.d.node(node);
  if (n == nullptr) return std::nullopt;
  return geometry(c, text, *n, seconds, 0);
}

}  // namespace premation::doc
