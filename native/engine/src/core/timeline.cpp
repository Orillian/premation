#include "timeline.hpp"

#include <algorithm>
#include <cmath>
#include <set>
#include <unordered_map>
#include <unordered_set>

#include "anim.hpp"
#include "jsmath.hpp"
#include "readmodel.hpp"
#include "scene.hpp"

namespace premation::doc {
namespace {

double comp_number(const Json* rec, std::string_view key, double fallback) {
  if (rec == nullptr) return fallback;
  const auto v = rec->number_at(key);
  return v ? *v : fallback;
}

/// `seedBarId(timeline, nodeId)`: `clip:<id>`, then `:<n>` for taken ids.
std::string seed_bar_id(const std::unordered_set<std::string>& ids, const std::string& nodeId) {
  const std::string base = "clip:" + nodeId;
  const auto taken = [&ids](const std::string& id) { return ids.contains(id); };
  if (!taken(base)) return base;
  for (int n = 1;; ++n) {
    std::string c = base + ":" + std::to_string(n);
    if (!taken(c)) return c;
  }
}

std::string seed_bar_id(const Timeline& t, const std::string& nodeId) {
  std::unordered_set<std::string> ids;
  for (const Bar& b : t.bars) ids.insert(b.id);
  return seed_bar_id(ids, nodeId);
}

/// The scene nodes a comp's track mirrors: every descendant, not through groups.
bool is_group_node(const Node& n) {
  for (const auto& c : n.components) {
    const Json* k = c.props.find("__kind");
    if (k != nullptr && k->is_string()) return k->str() == "group";
  }
  return false;
}

void collect_nodes(const Document& d, std::string_view parent, std::vector<const Node*>& out,
                   std::unordered_set<std::string_view>& guard) {
  const Node* p = d.node(parent);
  if (p == nullptr) return;
  for (const auto& cid : p->children) {
    const Node* n = d.node(cid);
    if (n == nullptr) continue;
    out.push_back(n);
    if (!n->children.empty() && !is_group_node(*n) && guard.insert(n->id).second) collect_nodes(d, n->id, out, guard);
  }
}

}  // namespace

std::optional<double> media_source_frames(const Document& d, const Node& n, double fps) {
  const std::string kind = n.kind();
  if (kind == "audio") {
    const Component* a = n.comp("Audio");
    const auto sec = a != nullptr ? a->props.number_at("__duration") : std::nullopt;
    if (sec && *sec > 0) return std::max(1.0, motion::js::round(*sec * fps));
    return std::nullopt;
  }
  if (kind == "image" || kind == "svg") return std::nullopt;
  std::optional<double> durationSec;
  double loopCount = 1;
  if (kind == "comp") {
    const auto ref = read_comp_ref(n);
    if (!ref) return std::nullopt;
    const Json* c = d.comp(*ref);
    if (c == nullptr) return std::nullopt;
    const double dur = comp_number(c, "durationSeconds", 0);
    if (dur > 0) durationSec = dur;
  } else if (kind == "video") {
    std::optional<std::string> assetId;
    for (const auto& c : n.components) {
      const Json& a = c.props.at("assetId");
      if (a.is_string() && !a.str().empty()) assetId = a.str();
      const Json& b = c.props.at("__assetId");
      if (b.is_string() && !b.str().empty()) assetId = b.str();
    }
    if (!assetId) return std::nullopt;
    const Json* asset = find_asset(d, *assetId);
    if (asset == nullptr) return std::nullopt;
    const auto dur = asset->at("metadata").number_at("duration");
    if (dur && *dur > 0) durationSec = dur;
    const auto loops = asset->at("interpret").number_at("loopCount");
    loopCount = loops ? *loops : 1;
  } else {
    return std::nullopt;
  }
  if (!durationSec) return std::nullopt;
  if (loopCount == 0) return std::nullopt;
  return std::max(1.0, motion::js::round(*durationSec * loopCount * fps));
}

bool tl_ensure(Document& d, std::string_view comp) {
  if (d.timeline(comp) != nullptr) return true;
  const Json* rec = d.comp(comp);
  if (rec == nullptr) return false;
  Timeline& t = d.timeline_mut(comp);
  const double fps = comp_number(rec, "fps", 30);
  t.fps = fps;
  t.duration = std::max(1.0, motion::js::round(comp_number(rec, "durationSeconds", 10) * fps));
  t.loop = FrameRange{0, t.duration};
  tl_sync_from_scene(d, comp);
  return true;
}

namespace {

/// A comp's track nodes (`collect_nodes`) and their ids.
struct TrackNodes {
  std::vector<const Node*> nodes;
  std::unordered_set<std::string_view> ids;
};

TrackNodes track_nodes(const Document& d, std::string_view comp) {
  TrackNodes t;
  std::unordered_set<std::string_view> guard;
  collect_nodes(d, comp, t.nodes, guard);
  for (const Node* n : t.nodes) t.ids.insert(n->id);
  return t;
}

bool bar_current(const Document& d, const Bar& b, const Node& n, double fps) {
  return b.name == n.name && b.enabled == n.visible && b.locked == n.locked &&
         (b.clip.sourceDuration || !media_source_frames(d, n, fps));
}

void refresh_bar(const Document& d, Bar& b, const Node& n, double fps) {
  b.name = n.name;
  b.enabled = n.visible;
  b.locked = n.locked;
  if (!b.clip.sourceDuration) {
    if (const auto late = media_source_frames(d, n, fps)) b.clip.sourceDuration = late;
  }
}

Bar new_bar(const Document& d, const Node& n, const Timeline& t, const std::unordered_set<std::string>& taken) {
  const auto src = media_source_frames(d, n, t.fps);
  Bar b;
  b.id = seed_bar_id(taken, n.id);
  b.name = n.name;
  b.sourceId = n.id;
  b.enabled = n.visible;
  b.locked = n.locked;
  b.clip.start = 0;
  b.clip.duration = std::max(0.0, src ? std::min(t.duration, *src) : t.duration);
  b.clip.sourceIn = 0;
  b.clip.sourceDuration = src;
  return b;
}

/// Would the full `syncFromScene` change this timeline? (read-only)
bool full_in_sync(const Document& d, std::string_view comp, const TrackNodes& tn) {
  const Timeline& cur = *d.timeline(comp);
  std::unordered_map<std::string_view, const Node*> byId;
  for (const Node* n : tn.nodes) byId.emplace(n->id, n);
  std::unordered_set<std::string_view> covered;
  for (const Bar& b : cur.bars) {
    if (!b.sourceId) continue;
    const auto it = byId.find(*b.sourceId);
    if (it == byId.end() || !bar_current(d, b, *it->second, cur.fps)) return false;
    covered.insert(*b.sourceId);
  }
  return covered.size() == byId.size();
}

/// TimelineController.syncFromScene(comp): the whole track.
void sync_full(Document& d, std::string_view comp) {
  const TrackNodes tn = track_nodes(d, comp);
  if (full_in_sync(d, comp, tn)) return;
  // Edit in place: timeline_mut copies on write once per transaction.
  Timeline& next = d.timeline_mut(comp);
  // Views into next.bars: it is not resized until the scan is over.
  std::unordered_map<std::string_view, std::vector<std::size_t>> bySource;
  for (std::size_t i = 0; i < next.bars.size(); ++i) {
    if (next.bars[i].sourceId) bySource[*next.bars[i].sourceId].push_back(i);
  }
  std::unordered_set<std::string> barIds;
  for (const Bar& x : next.bars) barIds.insert(x.id);
  std::vector<Bar> added;
  for (const Node* n : tn.nodes) {
    const auto hit = bySource.find(n->id);
    if (hit != bySource.end()) {
      for (const std::size_t i : hit->second) refresh_bar(d, next.bars[i], *n, next.fps);
      continue;
    }
    added.push_back(new_bar(d, *n, next, barIds));
    barIds.insert(added.back().id);
  }
  // New bars follow the existing ones, in track order (as TS appends them).
  std::erase_if(next.bars, [&tn](const Bar& b) { return b.sourceId && !tn.ids.contains(*b.sourceId); });
  for (Bar& b : added) next.bars.push_back(std::move(b));
}

/// The comp whose track shows `n` (collect_nodes' membership: every ancestor
/// below the comp root is a non-group), or nullopt.
std::optional<std::string_view> track_comp_of(const Document& d, const Node& n) {
  const Node* cur = &n;
  for (std::size_t guard = 0; cur->parent && guard < 100000; ++guard) {
    const Node* p = d.node(*cur->parent);
    if (p == nullptr) return std::nullopt;
    if (!p->parent) return std::string_view(p->id);
    if (is_group_node(*p)) return std::nullopt;
    cur = p;
  }
  return std::nullopt;
}

void subtree(const Document& d, const Node& n, std::vector<const Node*>& out, std::unordered_set<std::string_view>& seen) {
  if (!seen.insert(n.id).second) return;
  out.push_back(&n);
  for (const auto& c : n.children) {
    if (const Node* k = d.node(c)) subtree(d, *k, out, seen);
  }
}

}  // namespace

bool tl_in_sync(const Document& d, std::string_view comp) {
  if (d.timeline(comp) == nullptr) return true;
  return full_in_sync(d, comp, track_nodes(d, comp));
}

void tl_sync_from_scene(Document& d, std::string_view comp) {
  const Timeline* t = d.timeline(comp);
  if (t == nullptr) return;
  if (d.tl_all_dirty() || t->bars.empty()) {
    sync_full(d, comp);
    return;
  }
  // Only nodes written since the last reconcile (and what hangs under them)
  // can have stale bars; the result equals the full sync (checked by
  // tests/invariants.hpp `timelines_in_sync` after every stress/fuzz step).
  std::vector<const Node*> touched;
  std::unordered_set<std::string_view> seen;
  std::unordered_set<std::string_view> gone;  // ids no longer on this track
  for (const auto& id : d.tl_touched()) {
    const Node* n = d.node(id);
    if (n == nullptr) {
      gone.insert(id);
      continue;
    }
    if (!n->parent) continue;  // a comp root: child ORDER does not move bars
    subtree(d, *n, touched, seen);
  }
  std::vector<const Node*> members;
  for (const Node* n : touched) {
    const auto c = track_comp_of(d, *n);
    if (c && *c == comp) members.push_back(n);
    else gone.insert(n->id);
  }
  // Read-only first: what would change?
  std::unordered_map<std::string_view, std::vector<std::size_t>> bySource;
  for (std::size_t i = 0; i < t->bars.size(); ++i) {
    if (t->bars[i].sourceId) bySource[*t->bars[i].sourceId].push_back(i);
  }
  bool dirty = false;
  std::size_t fresh = 0;
  for (const Node* n : members) {
    const auto hit = bySource.find(n->id);
    if (hit == bySource.end()) {
      ++fresh;
      dirty = true;
      continue;
    }
    for (const std::size_t i : hit->second) {
      if (!bar_current(d, t->bars[i], *n, t->fps)) dirty = true;
    }
  }
  for (const auto& id : gone) {
    if (bySource.contains(id)) dirty = true;
  }
  if (!dirty) return;
  // Several new bars: their order is the track order — the full sync knows it.
  if (fresh > 1) {
    sync_full(d, comp);
    return;
  }
  Timeline& next = d.timeline_mut(comp);
  std::optional<Bar> added;
  for (const Node* n : members) {
    bool any = false;
    for (Bar& b : next.bars) {
      if (!b.sourceId || *b.sourceId != n->id) continue;
      any = true;
      refresh_bar(d, b, *n, next.fps);
    }
    if (!any) {
      std::unordered_set<std::string> barIds;
      for (const Bar& x : next.bars) barIds.insert(x.id);
      added = new_bar(d, *n, next, barIds);
    }
  }
  std::erase_if(next.bars, [&gone](const Bar& b) { return b.sourceId && gone.contains(*b.sourceId); });
  if (added) next.bars.push_back(std::move(*added));
}

void tl_sync_all(Document& d) {
  if (!d.tl_all_dirty() && d.tl_touched().empty()) return;
  for (const auto& id : d.timelines().keys()) tl_sync_from_scene(d, id);
  d.tl_mark_clean();
}

std::string tl_owner_comp(const Document& d, const EditorView& v, std::string_view node) {
  const Node* n = d.node(node);
  if (n != nullptr && n->parent && d.timeline(*n->parent) != nullptr) return *n->parent;
  // A layer parented to another layer is on its comp's track too (collect_nodes, write_geoms). The tab is no
  // stand-in for that comp: the live session never moves view.tabComp off the tab open at load.
  if (const auto comp = enclosing_comp_root_of(d, node); comp && d.timeline(*comp) != nullptr) return *comp;
  return v.tabComp;
}

namespace {

/// TlReadScope's state: the depth, and per timeline VERSION (entities are
/// immutable while a read scope is open) its bars grouped by source id.
struct BarIndex {
  int depth = 0;
  std::unordered_map<const Timeline*, std::unordered_map<std::string, std::vector<const Bar*>>> byTimeline;
};
thread_local BarIndex g_barIndex;

const std::unordered_map<std::string, std::vector<const Bar*>>& bar_index_of(const Timeline& t) {
  auto [it, fresh] = g_barIndex.byTimeline.try_emplace(&t);
  if (fresh) {
    for (const Bar& b : t.bars) {
      if (b.sourceId) it->second[*b.sourceId].push_back(&b);
    }
    for (auto& [id, list] : it->second) {
      std::stable_sort(list.begin(), list.end(), [](const Bar* a, const Bar* b) { return a->clip.start < b->clip.start; });
    }
  }
  return it->second;
}

}  // namespace

TlReadScope::TlReadScope() { ++g_barIndex.depth; }
TlReadScope::~TlReadScope() {
  if (--g_barIndex.depth == 0) g_barIndex.byTimeline.clear();
}

std::vector<const Bar*> tl_bars_for_node(const Document& d, const EditorView& v, std::string_view node) {
  std::vector<const Bar*> out;
  const Timeline* t = d.timeline(tl_owner_comp(d, v, node));
  if (t == nullptr) return out;
  if (g_barIndex.depth > 0) {
    const auto& idx = bar_index_of(*t);
    const auto it = idx.find(std::string(node));
    if (it != idx.end()) out = it->second;
    return out;
  }
  for (const Bar& b : t->bars) {
    if (b.sourceId && *b.sourceId == node) out.push_back(&b);
  }
  std::stable_sort(out.begin(), out.end(), [](const Bar* a, const Bar* b) { return a->clip.start < b->clip.start; });
  return out;
}

double tl_fps_for_node(const Document& d, const EditorView& v, std::string_view node) {
  const Timeline* t = d.timeline(tl_owner_comp(d, v, node));
  return t != nullptr ? t->fps : 30;
}

double tl_duration_for_node(const Document& d, const EditorView& v, std::string_view node) {
  const Timeline* t = d.timeline(tl_owner_comp(d, v, node));
  return t != nullptr ? t->duration : 300;
}

std::vector<const Bar*> bars_of(const Document& d, std::string_view layer, std::string_view comp) {
  std::vector<const Bar*> out;
  const Timeline* t = d.timeline(comp);
  if (t == nullptr) return out;
  for (const Bar& b : t->bars) {
    if (b.sourceId && *b.sourceId == layer) out.push_back(&b);
  }
  std::stable_sort(out.begin(), out.end(), [](const Bar* a, const Bar* b) { return a->clip.start < b->clip.start; });
  return out;
}

std::vector<Geo> geoms_of(const Document& d, std::string_view layer, std::string_view comp) {
  std::vector<Geo> out;
  for (const Bar* b : bars_of(d, layer, comp)) out.push_back(b->clip);
  return out;
}

void write_geoms(Document& d, std::string_view comp, std::string_view layer, const std::vector<Geo>& want) {
  tl_sync_all(d);
  if (!tl_ensure(d, comp)) return;
  const Timeline& cur = *d.timeline(comp);
  Timeline next = cur;
  std::vector<std::size_t> have;
  for (std::size_t i = 0; i < next.bars.size(); ++i) {
    if (next.bars[i].sourceId && *next.bars[i].sourceId == layer) have.push_back(i);
  }
  std::stable_sort(have.begin(), have.end(),
                   [&next](std::size_t a, std::size_t b) { return next.bars[a].clip.start < next.bars[b].clip.start; });
  const std::size_t shared = std::min(have.size(), want.size());
  for (std::size_t i = 0; i < shared; ++i) {
    Clip g = want[i];
    g.duration = std::max(0.0, g.duration);
    next.bars[have[i]].clip = g;
  }
  if (want.size() < have.size()) {
    std::set<std::size_t> drop(have.begin() + static_cast<std::ptrdiff_t>(want.size()), have.end());
    std::vector<Bar> kept;
    for (std::size_t i = 0; i < next.bars.size(); ++i) {
      if (!drop.contains(i)) kept.push_back(std::move(next.bars[i]));
    }
    next.bars = std::move(kept);
  } else if (want.size() > have.size()) {
    const Node* n = d.node(layer);
    if (n != nullptr) {
      for (std::size_t i = have.size(); i < want.size(); ++i) {
        Bar b;
        b.id = seed_bar_id(next, std::string(layer));
        b.name = n->name;
        b.sourceId = std::string(layer);
        b.enabled = n->visible;
        b.locked = n->locked;
        b.clip = want[i];
        b.clip.duration = std::max(0.0, b.clip.duration);
        next.bars.push_back(std::move(b));
      }
    }
  }
  if (!(next == cur)) {
    d.timeline_mut(comp) = std::move(next);
    // TS syncTimelines runs after every command; here only touched nodes are
    // reconciled, so a bar written for a node that has none (a group member)
    // must be looked at again — else it outlives the command (d1 / crossEngine:
    // pasteLayers into a group reported compositionChanged).
    d.tl_touch(layer);
  }
}

// ── layerTime.ts ─────────────────────────────────────────────────────────

LayerTime normalize_layer_time(const Json& v) {
  LayerTime t;
  const auto stretch = v.number_at("stretch");
  t.stretch = stretch && std::isfinite(*stretch) ? std::max(1.0, std::min(1000.0, *stretch)) : 100;
  t.reverse = v.bool_at("reverse").value_or(false);
  t.freeze = v.bool_at("freeze").value_or(false);
  const auto ft = v.number_at("freezeTime");
  t.freezeTime = ft && std::isfinite(*ft) ? *ft : 0;
  const auto fb = v.string_at("frameBlend");
  t.frameBlend = fb && (*fb == "mix" || *fb == "pixelMotion") ? *fb : "none";
  return t;
}

bool is_identity_time(const LayerTime& t) noexcept { return !t.freeze && !t.reverse && t.stretch == 100; }

std::optional<LayerTime> read_node_layer_time(const Node& n) {
  const Component* fx = n.comp("fx");
  if (fx == nullptr || fx->props.at("time").is_undefined()) return std::nullopt;
  const LayerTime cfg = normalize_layer_time(fx->props.at("time"));
  if (is_identity_time(cfg) && cfg.frameBlend == "none") return std::nullopt;
  return cfg;
}

LayerTime get_node_layer_time(const Node& n) {
  const Component* fx = n.comp("fx");
  if (fx != nullptr && !fx->props.at("time").is_undefined()) return normalize_layer_time(fx->props.at("time"));
  return LayerTime{};
}

Json layer_time_json(const LayerTime& t) {
  Json o = Json::object();
  o.set("stretch", Json::number(t.stretch));
  o.set("reverse", Json::boolean(t.reverse));
  o.set("freeze", Json::boolean(t.freeze));
  o.set("freezeTime", Json::number(t.freezeTime));
  o.set("frameBlend", Json::string(t.frameBlend));
  return o;
}

double remap_time(double t, const LayerTime& cfg, double spanStart, double spanEnd) {
  if (cfg.freeze) return cfg.freezeTime;
  const double stretch = cfg.stretch > 0 ? cfg.stretch : 100;
  double s = spanStart + (t - spanStart) * (100 / stretch);
  if (cfg.reverse) s = spanStart + spanEnd - s;
  return s;
}

// ── the keyframe axis ────────────────────────────────────────────────────

namespace {
thread_local int g_subFrame = 0;  // NOLINT(cppcoreguidelines-avoid-non-const-global-variables): TlSubFrameScope depth
}  // namespace

TlSubFrameScope::TlSubFrameScope() { ++g_subFrame; }
TlSubFrameScope::~TlSubFrameScope() { --g_subFrame; }

// ── responsive time (AE Responsive Design – Time) ──────────────────────

namespace {

/// A composition's protected regions against its authored length, when its
/// duration has since changed (template/responsiveTime.ts, the editor's twin):
/// regions sorted, clamped and merged; nullopt = nothing to remap.
struct ResponsiveMap {
  double authored = 0;
  double target = 0;
  std::vector<std::pair<double, double>> regions;
  double scale = 1;  ///< how the unprotected time stretches
};

/// Whether any composition carries Responsive Time — the hot path's gate:
/// keys are sampled through comp_to_keyframe_time per property per frame, and
/// almost no document has a responsive composition. Cached per thread on the
/// compositions' root nodes: a write is copy-on-write, so an edited root is a
/// new pointer and the cache sees it; the check is then one pointer compare
/// per composition.
bool any_responsive(const Document& d) {
  struct Cache {
    const Document* doc = nullptr;
    std::vector<const Node*> roots;
    bool any = false;
  };
  thread_local Cache cache;
  const auto& comps = d.comps();
  bool same = cache.doc == &d && cache.roots.size() == comps.size();
  if (same) {
    std::size_t i = 0;
    for (const auto& entry : comps) {
      if (cache.roots[i++] != d.node(entry.first)) {
        same = false;
        break;
      }
    }
  }
  if (same) return cache.any;
  cache.doc = &d;
  cache.roots.clear();
  cache.any = false;
  for (const auto& entry : comps) {
    const Node* root = d.node(entry.first);
    cache.roots.push_back(root);
    if (root == nullptr) continue;
    for (const Component& c : root->components) cache.any = cache.any || c.props.at("__responsiveTime").is_object();
  }
  return cache.any;
}

std::optional<ResponsiveMap> responsive_map_of(const Document& d, std::string_view node) {
  if (!any_responsive(d)) return std::nullopt;
  const auto comp = comp_of_layer(d, node);
  if (!comp) return std::nullopt;
  const Node* root = d.node(*comp);
  if (root == nullptr) return std::nullopt;
  const Json* cfg = nullptr;
  for (const Component& c : root->components) {
    const Json& v = c.props.at("__responsiveTime");
    if (v.is_object()) {
      cfg = &v;
      break;
    }
  }
  if (cfg == nullptr || !cfg->at("authoredDurationSec").is_number() || !cfg->at("protectedRegions").is_array()) return std::nullopt;
  const double fps = std::max(1.0, comp_fps(d, *comp));
  ResponsiveMap m;
  m.authored = cfg->at("authoredDurationSec").num();
  m.target = comp_duration_frames(d, *comp) / fps;
  if (!(m.authored > 0) || !(m.target > 0) || std::fabs(m.authored - m.target) < 1e-6) return std::nullopt;
  for (const Json& r : cfg->at("protectedRegions").arr()) {
    const double a = r.at("startSec").num();
    const double b = r.at("endSec").num();
    const double lo = std::clamp(std::min(a, b), 0.0, m.authored);
    const double hi = std::clamp(std::max(a, b), 0.0, m.authored);
    if (hi - lo > 1e-9) m.regions.emplace_back(lo, hi);
  }
  std::ranges::sort(m.regions);
  std::vector<std::pair<double, double>> merged;
  for (const auto& r : m.regions) {
    if (!merged.empty() && r.first <= merged.back().second + 1e-9) merged.back().second = std::max(merged.back().second, r.second);
    else merged.push_back(r);
  }
  m.regions = std::move(merged);
  double prot = 0;
  for (const auto& r : m.regions) prot += r.second - r.first;
  const double flexAuthored = std::max(0.0, m.authored - prot);
  if (flexAuthored <= 1e-9) return std::nullopt;  // all protected: the comp simply is its authored length
  m.scale = std::max(0.0, m.target - prot) / flexAuthored;
  return m;
}

/// The segments of the authored timeline and where each lands when stretched:
/// (authoredStart, authoredLength, stretchedStart, protected).
template <typename Fn>
void responsive_segments(const ResponsiveMap& m, Fn&& fn) {
  double a = 0;
  double s = 0;
  for (const auto& [lo, hi] : m.regions) {
    if (lo - a > 1e-9) {
      if (fn(a, lo - a, s, false)) return;
      s += (lo - a) * m.scale;
      a = lo;
    }
    if (fn(a, hi - lo, s, true)) return;
    s += hi - lo;
    a = hi;
  }
  if (m.authored - a > 1e-9) (void)fn(a, m.authored - a, s, false);
}

/// Stretched (the composition's current) time → authored time: protected spans 1:1, the rest scaled.
double stretched_to_authored(const ResponsiveMap& m, double t) {
  double out = t;
  bool found = false;
  double endA = 0;
  double endS = 0;
  responsive_segments(m, [&](double a, double len, double s, bool prot) {
    const double slen = prot ? len : len * m.scale;
    endA = a + len;
    endS = s + slen;
    if (t < s + slen) {
      out = prot ? a + (t - s) : a + (m.scale > 1e-9 ? (t - s) / m.scale : 0);
      found = true;
      return true;
    }
    return false;
  });
  // Past the end: on at authored speed, never frozen on the last frame.
  return found ? out : endA + (t - endS);
}

/// Authored time → stretched time (where a key authored at `t` now plays).
double authored_to_stretched(const ResponsiveMap& m, double t) {
  double out = t;
  bool found = false;
  double endA = 0;
  double endS = 0;
  responsive_segments(m, [&](double a, double len, double s, bool prot) {
    endA = a + len;
    endS = s + (prot ? len : len * m.scale);
    if (t < a + len) {
      out = s + (prot ? t - a : (t - a) * m.scale);
      found = true;
      return true;
    }
    return false;
  });
  return found ? out : endS + (t - endA);
}

}  // namespace

double comp_to_keyframe_time(const Document& d, const EditorView& v, std::string_view node, double compTime,
                             std::string_view prop) {
  // Responsive time first (AE Responsive Design – Time): a composition whose
  // duration moved off its authored length samples its keys on the authored
  // axis, protected regions at authored speed. Animated precomp-ancestor
  // remaps do not exist here (precomp COMPOSITIONS are separate roots).
  const double fps = tl_fps_for_node(d, v, node);
  double time = compTime;
  if (prop == "timeRemap" || prop == "precompTime") return time;
  if (const auto rmap = responsive_map_of(d, node)) time = stretched_to_authored(*rmap, time);
  const double frame = motion::js::round(time * fps);
  // Governing clips: the node's own, else an enclosing plain GROUP's.
  std::vector<const Bar*> clips = tl_bars_for_node(d, v, node);
  if (clips.empty()) {
    const Node* n = d.node(node);
    for (int depth = 0; depth < 32 && n != nullptr; ++depth) {
      if (!n->parent) break;
      const Node* parent = d.node(*n->parent);
      if (parent == nullptr) break;
      if (is_precomp(*parent) || parent->kind() != "group") break;
      clips = tl_bars_for_node(d, v, parent->id);
      if (!clips.empty()) break;
      n = parent;
    }
  }
  // A time outside every clip maps through the NEAREST clip's axis (a layer's
  // time runs on past its in / out points, as in AE): keyframe_to_comp_time
  // reports a key outside the clips through that same clip, so a key read and
  // written back (move, scale, reverse, paste) lands where it was.
  const Bar* governing = nullptr;
  double bestDist = std::numeric_limits<double>::infinity();
  for (const Bar* b : clips) {
    if (b->active_at(frame)) {
      governing = b;
      break;
    }
    const double clamped = std::max(b->clip.start, std::min(b->clip.end() - 1, frame));
    const double dist = std::fabs(frame - clamped);
    if (dist < bestDist) {
      bestDist = dist;
      governing = b;
    }
  }
  if (governing != nullptr) time = governing->clip.source_frame_at(g_subFrame > 0 ? time * fps : frame) / fps;
  const Node* n = d.node(node);
  if (n != nullptr) {
    if (const auto cfg = read_node_layer_time(*n)) {
      const auto span = anim_time_span(d, node);
      time = remap_time(time, *cfg, span ? span->start : 0, span ? span->end : 1);
    }
  }
  return time;
}

double keyframe_to_comp_time(const Document& d, const EditorView& v, std::string_view node, double keyTime,
                             std::string_view prop) {
  const double fps = tl_fps_for_node(d, v, node);
  if (prop == "timeRemap" || prop == "precompTime") return keyTime;
  double t = keyTime;
  const Node* n = d.node(node);
  if (n != nullptr) {
    const auto cfg = read_node_layer_time(*n);
    if (cfg && !cfg->freeze) {
      const auto sp = anim_time_span(d, node);
      const double start = sp ? sp->start : 0;
      const double end = sp ? sp->end : 1;
      const double stretch = cfg->stretch > 0 ? cfg->stretch : 100;
      double s = t;
      if (cfg->reverse) s = start + end - s;
      t = start + (s - start) * (stretch / 100);
    }
  }
  std::vector<const Bar*> clips = tl_bars_for_node(d, v, node);
  if (clips.empty() && n != nullptr) {
    const Node* cur = n;
    for (int depth = 0; depth < 32 && cur != nullptr; ++depth) {
      if (!cur->parent) break;
      const Node* parent = d.node(*cur->parent);
      if (parent == nullptr) break;
      if (is_precomp(*parent) || parent->kind() != "group") break;
      clips = tl_bars_for_node(d, v, parent->id);
      if (!clips.empty()) break;
      cur = parent;
    }
  }
  if (!clips.empty()) {
    const double sourceFrame = motion::js::round(t * fps);
    std::optional<double> best;
    double bestDist = std::numeric_limits<double>::infinity();
    for (const Bar* l : clips) {
      const double compFrame = l->clip.start + (sourceFrame - l->clip.sourceIn);
      if (l->active_at(compFrame)) {
        best = compFrame;
        break;
      }
      // A key outside every clip maps through the NEAREST clip but keeps its
      // own time: clamping it to the clip's edge reported a key at 2.8 s as
      // 3.4 s on a layer whose in point is 3.4 (it evaluates at 2.8).
      const double clamped = std::max(l->clip.start, std::min(l->clip.end() - 1, compFrame));
      const double dist = std::fabs(compFrame - clamped);
      if (dist < bestDist) {
        bestDist = dist;
        best = compFrame;
      }
    }
    if (best) t = *best / fps;
  }
  // Where the key plays once responsive time stretches the composition.
  if (const auto rmap = responsive_map_of(d, node)) t = authored_to_stretched(*rmap, t);
  return t;
}

// ── markers / timeline ops ───────────────────────────────────────────────

void markers_insert(std::vector<TMarker>& list, TMarker m) {
  const auto it = std::lower_bound(list.begin(), list.end(), m.frame,
                                   [](const TMarker& x, double f) { return x.frame < f; });
  list.insert(it, std::move(m));
}

void markers_reindex(std::vector<TMarker>& list) {
  std::stable_sort(list.begin(), list.end(), [](const TMarker& a, const TMarker& b) { return a.frame < b.frame; });
}

void tl_set_frame_rate(Timeline& t, double fps) {
  if (fps == t.fps) return;
  const double from = t.fps;
  const auto conv = [from, fps](double f) { return (f / from) * fps; };
  for (Bar& b : t.bars) {
    b.clip.start = conv(b.clip.start);
    b.clip.duration = conv(b.clip.duration);
    b.clip.sourceIn = conv(b.clip.sourceIn);
    if (b.clip.sourceDuration) b.clip.sourceDuration = conv(*b.clip.sourceDuration);
    for (TMarker& m : b.markers) m.frame = conv(m.frame);
    markers_reindex(b.markers);
  }
  for (TMarker& m : t.markers) m.frame = conv(m.frame);
  markers_reindex(t.markers);
  t.duration = motion::js::round(conv(t.duration));
  if (t.loop) t.loop = FrameRange{conv(t.loop->start), conv(t.loop->duration)};
  if (t.workArea) t.workArea = FrameRange{conv(t.workArea->start), conv(t.workArea->duration)};
  t.fps = fps;
}

void tl_set_duration(Timeline& t, double frames) {
  const double next = std::max(0.0, motion::js::round(frames));
  t.duration = next;
}

std::string tl_comp_id_for_node(const Document& d, const EditorView& v, std::string_view node) {
  return tl_owner_comp(d, v, node);
}

void tl_transfer_node_clips(Document& d, const std::vector<std::string>& nodeIds, std::string_view from,
                            std::string_view to) {
  const Timeline* src = d.timeline(from);
  if (src == nullptr) return;
  if (d.timeline(to) == nullptr && !tl_ensure(d, to)) return;
  const std::set<std::string, std::less<>> wanted(nodeIds.begin(), nodeIds.end());
  std::vector<Bar> moving;
  for (const Bar& b : src->bars) {
    if (b.sourceId && wanted.contains(*b.sourceId)) moving.push_back(b);
  }
  if (moving.empty()) return;
  {
    Timeline& dst = d.timeline_mut(to);
    std::erase_if(dst.bars, [&](const Bar& b) { return b.sourceId && wanted.contains(*b.sourceId); });
    for (Bar b : moving) {
      b.id = seed_bar_id(dst, *b.sourceId);
      for (TMarker& m : b.markers) m.ownerId = b.id;
      dst.bars.push_back(std::move(b));
    }
  }
  Timeline& s = d.timeline_mut(from);
  std::erase_if(s.bars, [&](const Bar& b) { return b.sourceId && wanted.contains(*b.sourceId); });
}

}  // namespace premation::doc
