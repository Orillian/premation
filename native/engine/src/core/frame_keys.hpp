// The document side of cached playback without a build (render/coverage_ledger.hpp
// consumes what this derives): a key per frame of the active composition,
// computed from the INPUTS the frame builder reads — the document parts
// reachable from the comp, the keyframes that decide each frame, the layer
// clocks — in microseconds, where the build itself (scene/engine_frames.cpp)
// is hundreds of milliseconds on a heavy comp. A frame whose key the render
// thread has seen built before is presented from the cache tiers without
// building it; an edit invalidates the frames it can reach, not the bar.
//
// The key is a CONTENT key over the document, never a revision: undo, a
// slider released where it started, a layer toggled off and on give the same
// keys back. It may be conservative (two frames of the same picture may get
// different keys) and never the reverse — equal keys must build equal frames.
// What makes that hold:
//
//  * STATIC inputs are hashed whole, and any change to them changes every
//    frame's key: every node reachable from the comp (its name — expressions
//    resolve layers by it — parent, children order, visibility and solo, every
//    component's props: transform, content, effects, masks, timing), the comp
//    records and timelines (bars are the layer clocks), the assets, project
//    settings, motion blur, colour management, materials, swatches, guides,
//    transitions, and the media base. Label colour, lock and shy are left out:
//    no frame reads them.
//  * KEYFRAME tracks are hashed per frame through the keys that decide the
//    value at that frame: the segment the frame's layer time falls in, one key
//    either side (the tangents motion_eval reads from the neighbours), and the
//    same around the layer time three frames before and after (motion-blur
//    samples: a 720° shutter and its phase reach two frames; the sub-frame
//    clock of a blur sample is within a frame of an integer frame's). A track
//    with a roving key (its times are solved over the whole path) hashes all
//    its keys. So a key edit changes the frames between its neighbours and a
//    few around them — not the comp.
//  * Layers INSIDE a precomp node or an instanced composition run on the
//    parent's remapped clock: their whole animation goes into the static hash.
//    An edit there reaches every frame — correct, just not fine.
//  * EXPRESSIONS: a source that reads only the current time (value, time,
//    wiggle, other layers' properties — all part of this frame's key already)
//    is LOCAL and is hashed with its layer. One that can read other times or
//    other comps (valueAtTime, loopOut, key(), comp(), sampleImage, a wiggle
//    with its own time, …) makes the comp hash every key of every track.
//  * Effects that read their layer at other times (echo, timewarp, the time
//    effects) make their layer and what it holds hash every key; a simulation
//    (fluid, particles: state over previous frames of other layers too), a
//    cloner (clones run behind in time), a native plugin and an effect type
//    the engine does not know do that for the comp.
//  * An audio-waveform layer reads decoded audio that arrives later than the
//    document: the comp is VOLATILE — the keys still drive the bars, but no
//    frame is presented without a build (Session reads `volatile_inputs`).
//
// Core thread only: it reads the document between edits, as a query would.
// Memory: one 64-bit word per (layer at the comp's level, frame); past
// kMaxCells the comp is not indexed (keys are 0; the bars fall back to
// all-or-nothing and every frame builds, as before).
#pragma once

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "anim.hpp"
#include "catalog_data.hpp"
#include "fxstate.hpp"
#include "jsmath.hpp"
#include "model.hpp"
#include "native_effects.hpp"
#include "premation/protocol/wire.hpp"
#include "readmodel.hpp"
#include "scene.hpp"
#include "timeline.hpp"

namespace premation::doc {

namespace frame_keys {

/// A 64-bit mixer (the frame content hash's recipe, scene/engine_frames.cpp).
class Mix {
 public:
  void u64(std::uint64_t v) noexcept {
    h_ ^= v * 0x9e3779b97f4a7c15ULL;
    h_ = std::rotl(h_, 27) * 0xc2b2ae3d27d4eb4fULL + 0x165667b19e3779f9ULL;
  }
  void f64(double v) noexcept { u64(std::bit_cast<std::uint64_t>(v == 0 ? 0.0 : v)); }  // -0 and 0 are one value
  void flag(bool b) noexcept { u64(b ? 0x51U : 0x1fU); }
  void str(std::string_view s) noexcept {
    u64(s.size());
    std::size_t i = 0;
    for (; i + 8 <= s.size(); i += 8) {
      std::uint64_t w = 0;
      std::memcpy(&w, s.data() + i, 8);
      u64(w);
    }
    std::uint64_t tail = 0;
    for (std::size_t k = 0; i + k < s.size(); ++k) tail |= std::uint64_t{static_cast<unsigned char>(s[i + k])} << (8U * k);
    u64(tail);
  }
  template <class T>
  void opt(const std::optional<T>& v) noexcept {
    flag(v.has_value());
    if constexpr (std::is_same_v<T, double>) {
      if (v) f64(*v);
    } else if constexpr (std::is_same_v<T, bool>) {
      if (v) flag(*v);
    } else {
      if (v) u64(static_cast<std::uint64_t>(*v));
    }
  }
  [[nodiscard]] std::uint64_t value() const noexcept {
    std::uint64_t x = h_;
    x ^= x >> 33U;
    x *= 0xff51afd7ed558ccdULL;
    x ^= x >> 33U;
    return x;
  }

 private:
  std::uint64_t h_ = 0x243f6a8885a308d3ULL;
};

[[nodiscard]] inline std::uint64_t hash_json(const Json& j) {
  Mix m;
  m.str(js::stringify(j));
  return m.value();
}

/// Effects that read their own layer at other times: the layer (and what it holds) hashes every key.
[[nodiscard]] inline bool temporal_effect(std::string_view t) noexcept {
  constexpr auto kTemporal = std::to_array<std::string_view>(
      {"echo", "posterize-time", "wide-time", "force-motion-blur", "timewarp", "pixel-motion-blur", "time-displacement",
       "time-difference", "time-blend", "light-trails", "datamosh", "temporal-denoise", "warp-stabilizer", "color-stabilizer",
       "camera-shake-deblur", "match-grain"});
  return std::ranges::find(kTemporal, t) != kTemporal.end();
}

/// Simulations: state carried over previous frames, of other layers too (a layer map, an emitter): the comp hashes every key.
[[nodiscard]] inline bool simulation_effect(std::string_view t) noexcept {
  constexpr auto kSimulation = std::to_array<std::string_view>({"fluid-ink", "reaction-diffusion", "crystal-growth", "mr-mercury",
                                                                 "foam", "hair", "rain-on-glass", "particle-world", "particle-systems"});
  return std::ranges::find(kSimulation, t) != kSimulation.end();
}

/// Whether an expression source can only read the current time. Any
/// identifier of the non-local set anywhere in the source (a string, a
/// comment) counts: conservative, never wrong.
[[nodiscard]] inline bool expression_is_local(std::string_view src) noexcept {
  constexpr auto kNonLocal = std::to_array<std::string_view>(
      {"valueAtTime", "velocityAtTime", "speedAtTime", "loopIn", "loopOut", "loopInDuration", "loopOutDuration", "key",
       "nearestKey", "numKeys", "sourceRectAtTime", "posterizeTime", "smooth", "temporalWiggle", "sampleImage", "comp",
       "footage", "source", "eval", "Function"});
  const auto identStart = [](char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || c == '$'; };
  const auto identChar = [&identStart](char c) { return identStart(c) || (c >= '0' && c <= '9'); };
  const std::size_t n = src.size();
  std::size_t i = 0;
  while (i < n) {
    if (!identStart(src[i])) {
      ++i;
      continue;
    }
    std::size_t j = i;
    while (j < n && identChar(src[j])) ++j;
    const std::string_view word = src.substr(i, j - i);
    if (std::ranges::find(kNonLocal, word) != kNonLocal.end()) return false;
    if (word == "wiggle") {
      // wiggle(freq, amp, octaves, ampMult, t): a fifth argument is another time.
      std::size_t k = j;
      while (k < n && (src[k] == ' ' || src[k] == '\t' || src[k] == '\r' || src[k] == '\n')) ++k;
      if (k < n && src[k] == '(') {
        int depth = 0;
        int commas = 0;
        for (std::size_t m = k; m < n; ++m) {
          const char ch = src[m];
          if (ch == '(') {
            ++depth;
          } else if (ch == ')') {
            if (--depth == 0) break;
          } else if (ch == ',' && depth == 1) {
            ++commas;
          }
        }
        if (commas >= 4) return false;
      }
    }
    i = j;
  }
  return true;
}

}  // namespace frame_keys

class FrameKeyIndex {
 public:
  /// What an update found: every frame changed (or unknown), or these frames (sorted, unique).
  struct Delta {
    bool all = true;
    std::vector<std::int64_t> frames;
  };
  static constexpr std::int64_t kMaxFrames = 200'000;
  /// (layers at the comp's level) × frames words kept; past it the comp is not indexed.
  static constexpr std::size_t kMaxCells = std::size_t{4} << 20U;  // 32 MB
  /// Motion-blur reach, frames either side (a 720° shutter and its phase).
  static constexpr std::int64_t kBlurFrames = 3;

  void reset() {
    comp_.clear();
    mediaBase_.clear();
    indexed_ = false;
    volatile_ = false;
    global_ = false;
    frames_ = 0;
    fps_ = 30;
    static_ = 0;
    layers_.clear();
    layerIndex_.clear();
    compList_.clear();
    nodeHash_.clear();
    total_.clear();
  }

  /// Index `comp` of `d` from scratch. False = not indexable (no such comp,
  /// too large): `key` answers 0 until the next rebuild. `comp()` names the
  /// comp either way, so a caller does not retry every frame.
  bool rebuild(const Document& d, const EditorView& v, std::string_view comp, std::string_view mediaBase) {
    reset();
    comp_ = std::string(comp);
    mediaBase_ = std::string(mediaBase);
    const Node* root = d.node(comp);
    if (root == nullptr || d.comp(comp) == nullptr) return false;
    fps_ = comp_fps(d, comp);
    if (!(fps_ > 0)) fps_ = 30;
    const double frames = std::floor(comp_duration_frames(d, comp));
    if (!(frames >= 1) || frames > static_cast<double>(kMaxFrames)) return false;
    frames_ = static_cast<std::int64_t>(frames);
    std::unordered_set<std::string> seen;
    seen.insert(comp_);
    compList_.push_back(comp_);
    collect(d, *root, false, false, 0, seen);
    std::size_t rows = 0;
    for (const Layer& l : layers_) rows += l.nested ? 0 : 1;
    if (rows * static_cast<std::size_t>(frames_) > kMaxCells) {
      const std::string keep = comp_;
      reset();
      comp_ = keep;
      return false;
    }
    std::ranges::sort(compList_);
    total_.assign(static_cast<std::size_t>(frames_), 0);
    for (Layer& l : layers_) {
      if (l.nested) {
        l.constant = anim_hash(d, l.id);
        continue;
      }
      l.clock = clock_of(d, v, l.id);
      l.row = row_of(d, l);
      for (std::size_t f = 0; f < l.row.size(); ++f) total_[f] += l.row[f];
    }
    static_ = static_of(d);
    indexed_ = true;
    return true;
  }

  /// After a commit of `changes`: the frames whose key changed. The structure
  /// (layers added, removed, moved, retimed; a comp setting; an expression)
  /// rebuilds the index and answers every frame.
  Delta update(const Document& d, const EditorView& v, const ChangeSet& changes, std::string_view mediaBase) {
    Delta all;
    if (!indexed_) return all;
    if (mediaBase != mediaBase_) {
      (void)rebuild(d, v, comp_, mediaBase);
      return all;
    }
    const Parts& after = changes.after;
    const Parts& before = changes.before;
    bool structural = false;
    bool staticChanged = false;
    std::vector<std::string> rows;
    for (const auto& [id, node] : after.nodes) {
      const bool reachable = layerIndex_.contains(id);
      if (node == nullptr) {  // removed
        if (reachable || compList_end(id)) structural = true;
        continue;
      }
      if (!reachable) {
        // Added under a reachable node (or a reachable comp's root changed).
        if (compList_end(id) || (node->parent && (compList_end(*node->parent) || layerIndex_.contains(*node->parent)))) structural = true;
        continue;
      }
      const auto old = before.nodes.find(id);
      const Node* prev = old != before.nodes.end() ? old->second.get() : nullptr;
      if (prev == nullptr || prev->children != node->children || prev->parent != node->parent || is_precomp(*prev) != is_precomp(*node) ||
          read_comp_ref(*prev) != read_comp_ref(*node) || node_flags(*prev) != node_flags(*node)) {
        structural = true;
        continue;
      }
      nodeHash_.erase(id);
      staticChanged = true;
      rows.push_back(id);  // its clock (fx.time) may have changed
    }
    for (const auto& [id, anim] : after.anims) {
      if (!layerIndex_.contains(id)) continue;
      const auto old = before.anims.find(id);
      const NodeAnim* prev = old != before.anims.end() ? old->second.get() : nullptr;
      // An expression edit may change what is local: rare, and a rebuild is cheap next to it.
      if ((anim != nullptr && !anim->exprs.empty()) || (prev != nullptr && !prev->exprs.empty())) structural = true;
      rows.push_back(id);
    }
    for (const auto& [id, rec] : after.comps) {
      if (!compList_end(id)) continue;
      staticChanged = true;
      if (id == comp_ && (rec == nullptr || std::floor(comp_duration_frames(d, comp_)) != static_cast<double>(frames_) || comp_fps(d, comp_) != fps_)) {
        structural = true;
      }
    }
    for (const auto& [id, tl] : after.timelines) {
      if (compList_end(id)) structural = true;  // the bars are the layer clocks
    }
    if (after.items || after.project || after.mb || after.cm || after.tx || after.guides || after.swatches || after.materials) staticChanged = true;
    if (structural) {
      (void)rebuild(d, v, comp_, mediaBase);
      return all;
    }
    std::vector<std::int64_t> changed;
    for (const std::string& id : rows) {
      Layer& l = layers_[layerIndex_.at(id)];
      if (l.nested) {
        l.constant = anim_hash(d, l.id);
        staticChanged = true;
        continue;
      }
      l.clock = clock_of(d, v, l.id);
      const std::vector<std::uint64_t> old = std::move(l.row);
      l.row = row_of(d, l);
      for (std::size_t f = 0; f < l.row.size(); ++f) {
        if (old[f] == l.row[f]) continue;
        total_[f] += l.row[f] - old[f];
        changed.push_back(static_cast<std::int64_t>(f));
      }
    }
    if (staticChanged) {
      static_ = static_of(d);
      return all;
    }
    std::ranges::sort(changed);
    changed.erase(std::unique(changed.begin(), changed.end()), changed.end());
    if (changed.size() >= static_cast<std::size_t>(frames_)) return all;
    Delta some;
    some.all = false;
    some.frames = std::move(changed);
    return some;
  }

  /// The document's key for `frame` (0 = not indexed, or outside the comp).
  [[nodiscard]] std::uint64_t key(std::int64_t frame) const noexcept {
    if (!indexed_ || frame < 0 || frame >= frames_) return 0;
    frame_keys::Mix m;
    m.u64(static_);
    m.u64(total_[static_cast<std::size_t>(frame)]);
    m.u64(static_cast<std::uint64_t>(frame));
    const std::uint64_t v = m.value();
    return v == 0 ? 1 : v;
  }
  [[nodiscard]] bool indexed() const noexcept { return indexed_; }
  /// An input arrives later than the document (decoded audio): never present a frame without a build.
  [[nodiscard]] bool volatile_inputs() const noexcept { return volatile_; }
  [[nodiscard]] const std::string& comp() const noexcept { return comp_; }
  [[nodiscard]] std::int64_t frames() const noexcept { return frames_; }
  /// Every track of every layer hashed whole (an expression, a simulation, a plugin).
  [[nodiscard]] bool whole_comp() const noexcept { return global_; }
  /// Tests: the layer clock the index evaluates frame `frame` of `layer` at
  /// (comp_to_keyframe_time's answer for a plain property); nullopt = no such
  /// layer at the comp's level.
  [[nodiscard]] std::optional<double> layer_time(std::string_view layer, std::int64_t frame) const {
    const auto it = layerIndex_.find(std::string(layer));
    if (it == layerIndex_.end() || layers_[it->second].nested) return std::nullopt;
    return clock_time(layers_[it->second].clock, static_cast<double>(frame) / fps_);
  }

 private:
  struct ClipSpan {
    double start = 0;
    double duration = 0;
    double sourceIn = 0;
    bool enabled = true;
  };
  /// A layer's clock: comp seconds → keyframe seconds (timeline.cpp comp_to_keyframe_time).
  struct Clock {
    double fps = 30;
    std::vector<ClipSpan> clips;
    std::optional<LayerTime> cfg;
    double spanStart = 0;
    double spanEnd = 1;
  };
  struct Layer {
    std::string id;
    bool nested = false;  ///< inside a precomp / an instanced comp: on the parent's clock, hashed whole
    bool whole = false;   ///< every key of every track (a temporal effect on it or above it)
    std::uint64_t constant = 0;      ///< nested: the animation's hash
    std::vector<std::uint64_t> row;  ///< not nested: per frame
    Clock clock;
  };

  [[nodiscard]] bool compList_end(std::string_view id) const { return std::ranges::find(compList_, id) != compList_.end(); }

  /// What of a node decides the index's structure beyond its tree position.
  [[nodiscard]] static std::uint64_t node_flags(const Node& n) {
    std::uint64_t f = 0;
    for (const Json& e : read_node_effects(n)) {
      if (!e.at("type").is_string()) continue;
      const std::string& t = e.at("type").str();
      if (frame_keys::simulation_effect(t) || NativeEffects::find(t) != nullptr || registry().effect(t) == nullptr) f |= 1U;
      if (frame_keys::temporal_effect(t)) f |= 2U;
    }
    for (const Component& c : n.components) {
      if (c.props.at("__cloner").is_object()) f |= 4U;
    }
    if (n.fx().at("audioWaveform").is_object()) f |= 8U;
    return f;
  }

  void collect(const Document& d, const Node& root, bool nested, bool whole, int depth, std::unordered_set<std::string>& seenComps) {
    for (const std::string& childId : root.children) {
      const Node* n = d.node(childId);
      if (n == nullptr || layerIndex_.contains(childId)) continue;
      const std::uint64_t flags = node_flags(*n);
      if ((flags & 1U) != 0 || (flags & 4U) != 0) global_ = true;
      if ((flags & 8U) != 0) volatile_ = true;
      const bool own = whole || (flags & 2U) != 0 || (flags & 8U) != 0;
      if (const NodeAnim* a = d.anim(childId)) {
        for (const auto& [prop, st] : a->exprs) {
          if (st.enabled && !frame_keys::expression_is_local(st.src)) global_ = true;
        }
      }
      Layer l;
      l.id = childId;
      l.nested = nested;
      l.whole = own;
      layerIndex_.emplace(childId, layers_.size());
      layers_.push_back(std::move(l));
      collect(d, *n, nested || is_precomp(*n), own, depth, seenComps);
      if (const std::optional<std::string> ref = read_comp_ref(*n); ref && depth < 8 && seenComps.insert(*ref).second) {
        if (const Node* other = d.node(*ref); other != nullptr && d.comp(*ref) != nullptr) {
          compList_.push_back(*ref);
          collect(d, *other, true, own, depth + 1, seenComps);
        }
      }
    }
  }

  [[nodiscard]] std::uint64_t node_hash(const Document& d, const std::string& id) {
    if (const auto it = nodeHash_.find(id); it != nodeHash_.end()) return it->second;
    frame_keys::Mix m;
    if (const Node* n = d.node(id)) {
      m.str(n->id);
      m.str(n->name);
      m.str(n->parent.value_or(""));
      for (const std::string& c : n->children) m.str(c);
      m.flag(n->visible);
      m.flag(n->solo);
      for (const Component& c : n->components) {
        m.str(c.id);
        m.str(c.type);
        m.str(js::stringify(c.props));
      }
    }
    const std::uint64_t h = m.value();
    nodeHash_.emplace(id, h);
    return h;
  }

  static void mix_key(frame_keys::Mix& m, const Key& k) {
    m.f64(k.t);
    m.f64(k.value);
    m.opt(k.easing);
    m.flag(k.bezier.has_value());
    if (k.bezier) {
      for (const double b : *k.bezier) m.f64(b);
    }
    m.opt(k.continuous);
    m.opt(k.roving);
    m.opt(k.si);
    m.opt(k.so);
    m.opt(k.spatial);
  }
  static void mix_data_key(frame_keys::Mix& m, const DataKey& k) {
    m.f64(k.t);
    m.str(js::stringify(k.value));
    m.opt(k.easing);
    m.flag(k.bezier.has_value());
    if (k.bezier) {
      for (const double b : *k.bezier) m.f64(b);
    }
    m.flag(k.so.has_value());
    if (k.so) m.str(js::stringify(*k.so));
    m.flag(k.si.has_value());
    if (k.si) m.str(js::stringify(*k.si));
  }

  /// A nested layer's animation, whole.
  [[nodiscard]] static std::uint64_t anim_hash(const Document& d, const std::string& id) {
    frame_keys::Mix m;
    const NodeAnim* a = d.anim(id);
    if (a == nullptr) return m.value();
    for (const auto& [prop, keys] : a->tracks) {
      m.str(prop);
      m.u64(keys.size());
      for (const Key& k : keys) mix_key(m, k);
    }
    for (const auto& [prop, track] : a->data) {
      m.str(prop);
      m.str(track.kind);
      m.u64(track.keys.size());
      for (const DataKey& k : track.keys) mix_data_key(m, k);
    }
    for (const auto& [prop, st] : a->exprs) {
      m.str(prop);
      m.str(st.src);
      m.flag(st.enabled);
    }
    return m.value();
  }

  [[nodiscard]] static Clock clock_of(const Document& d, const EditorView& v, const std::string& id) {
    Clock c;
    c.fps = tl_fps_for_node(d, v, id);
    if (!(c.fps > 0)) c.fps = 30;
    // Governing clips: the node's own, else an enclosing plain group's (comp_to_keyframe_time).
    std::vector<const Bar*> clips = tl_bars_for_node(d, v, id);
    if (clips.empty()) {
      const Node* n = d.node(id);
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
    c.clips.reserve(clips.size());
    for (const Bar* b : clips) c.clips.push_back(ClipSpan{b->clip.start, b->clip.duration, b->clip.sourceIn, b->enabled});
    if (const Node* n = d.node(id)) c.cfg = read_node_layer_time(*n);
    if (const auto span = anim_time_span(d, id)) {
      c.spanStart = span->start;
      c.spanEnd = span->end;
    }
    return c;
  }

  [[nodiscard]] static double clock_time(const Clock& c, double compTime) noexcept {
    double time = compTime;
    const double frame = motion::js::round(time * c.fps);
    for (const ClipSpan& k : c.clips) {
      if (k.enabled && frame >= k.start && frame < k.start + k.duration) {
        time = (k.sourceIn + (frame - k.start)) / c.fps;
        break;
      }
    }
    if (c.cfg) time = remap_time(time, *c.cfg, c.spanStart, c.spanEnd);
    return time;
  }

  /// The index of the key segment `t` falls in (-1 = before the first key).
  template <class K>
  [[nodiscard]] static std::ptrdiff_t segment(const std::vector<K>& keys, double t) noexcept {
    const auto it = std::upper_bound(keys.begin(), keys.end(), t, [](double x, const K& k) { return x < k.t; });
    return (it - keys.begin()) - 1;
  }

  [[nodiscard]] std::vector<std::uint64_t> row_of(const Document& d, const Layer& l) const {
    std::vector<std::uint64_t> row(static_cast<std::size_t>(frames_));
    const NodeAnim* a = d.anim(l.id);
    // Per track: its keys' hashes (once), and whether it hashes whole.
    struct Track {
      const std::string* prop = nullptr;
      const std::vector<Key>* keys = nullptr;
      const DataTrack* data = nullptr;
      std::vector<std::uint64_t> keyHash;
      bool whole = false;
      bool raw = false;  // timeRemap / precompTime: on the comp clock
    };
    std::vector<Track> tracks;
    std::uint64_t exprs = 0;
    if (a != nullptr) {
      tracks.reserve(a->tracks.size() + a->data.size());
      for (const auto& [prop, keys] : a->tracks) {
        Track t;
        t.prop = &prop;
        t.keys = &keys;
        t.raw = prop == "timeRemap" || prop == "precompTime";
        t.whole = l.whole || global_;
        t.keyHash.reserve(keys.size());
        for (std::size_t i = 0; i < keys.size(); ++i) {
          const Key& k = keys[i];
          if (k.roving.value_or(false) || (i > 0 && k.t < keys[i - 1].t)) t.whole = true;  // roving solves times over the path; unsorted: all
          frame_keys::Mix m;
          mix_key(m, k);
          t.keyHash.push_back(m.value());
        }
        tracks.push_back(std::move(t));
      }
      for (const auto& [prop, data] : a->data) {
        Track t;
        t.prop = &prop;
        t.data = &data;
        t.raw = prop == "timeRemap" || prop == "precompTime";
        t.whole = l.whole || global_;
        t.keyHash.reserve(data.keys.size());
        for (std::size_t i = 0; i < data.keys.size(); ++i) {
          const DataKey& k = data.keys[i];
          if (i > 0 && k.t < data.keys[i - 1].t) t.whole = true;
          frame_keys::Mix m;
          m.str(data.kind);
          mix_data_key(m, k);
          t.keyHash.push_back(m.value());
        }
        tracks.push_back(std::move(t));
      }
      frame_keys::Mix e;
      for (const auto& [prop, st] : a->exprs) {
        e.str(prop);
        e.str(st.src);
        e.flag(st.enabled);
      }
      exprs = e.value();
    }
    // Reach in keyframe seconds around each sampled clock: a frame of the
    // comp, stretched as the layer's time is (remap_time's 100 / stretch).
    double reach = 1.0 / fps_;
    if (l.clock.cfg && l.clock.cfg->stretch > 0) reach *= std::max(1.0, 100.0 / l.clock.cfg->stretch);
    constexpr std::size_t kSamples = static_cast<std::size_t>(2 * kBlurFrames + 1);
    std::array<double, kSamples> clocks{};
    std::array<double, kSamples> comps{};
    for (std::int64_t f = 0; f < frames_; ++f) {
      for (std::size_t s = 0; s < kSamples; ++s) {
        const double compTime = static_cast<double>(f - kBlurFrames + static_cast<std::int64_t>(s)) / fps_;
        comps[s] = compTime;
        clocks[s] = clock_time(l.clock, compTime);
      }
      frame_keys::Mix m;
      m.f64(clocks[static_cast<std::size_t>(kBlurFrames)]);
      m.u64(exprs);
      for (const Track& t : tracks) {
        m.str(*t.prop);
        const std::size_t n = t.keyHash.size();
        if (n == 0) continue;
        std::ptrdiff_t lo = 0;
        std::ptrdiff_t hi = static_cast<std::ptrdiff_t>(n) - 1;
        if (!t.whole) {
          lo = hi;
          hi = 0;
          const std::array<double, kSamples>& times = t.raw ? comps : clocks;
          for (const double x : times) {
            const std::ptrdiff_t a0 = t.keys != nullptr ? segment(*t.keys, x - reach) : segment(t.data->keys, x - reach);
            const std::ptrdiff_t a1 = t.keys != nullptr ? segment(*t.keys, x + reach) : segment(t.data->keys, x + reach);
            lo = std::min(lo, a0 - 1);
            hi = std::max(hi, a1 + 2);
          }
          lo = std::clamp<std::ptrdiff_t>(lo, 0, static_cast<std::ptrdiff_t>(n) - 1);
          hi = std::clamp<std::ptrdiff_t>(hi, 0, static_cast<std::ptrdiff_t>(n) - 1);
        }
        for (std::ptrdiff_t i = lo; i <= hi; ++i) m.u64(t.keyHash[static_cast<std::size_t>(i)]);
      }
      row[static_cast<std::size_t>(f)] = m.value();
    }
    return row;
  }

  [[nodiscard]] std::uint64_t static_of(const Document& d) {
    frame_keys::Mix m;
    m.str(mediaBase_);
    m.str(comp_);
    m.flag(global_);
    for (const Layer& l : layers_) {
      m.u64(node_hash(d, l.id));
      m.flag(l.nested);
      m.flag(l.whole);
      if (l.nested) m.u64(l.constant);
    }
    for (const std::string& c : compList_) {
      m.str(c);
      if (const Json* rec = d.comp(c)) m.u64(frame_keys::hash_json(*rec));
      m.u64(node_hash(d, c));  // the root: its children order is the paint order
      if (const Timeline* t = d.timeline(c)) {
        m.f64(t->fps);
        m.f64(t->duration);
        m.flag(t->workArea.has_value());
        if (t->workArea) {
          m.f64(t->workArea->start);
          m.f64(t->workArea->duration);
        }
        for (const TMarker& k : t->markers) {
          m.str(k.id);
          m.f64(k.frame);
          m.f64(k.duration);
          m.str(k.name);
          m.str(k.comment);
        }
        for (const Bar& b : t->bars) {
          m.str(b.id);
          m.f64(b.clip.start);
          m.f64(b.clip.duration);
          m.f64(b.clip.sourceIn);
          m.opt(b.clip.sourceDuration);
          m.flag(b.enabled);
          m.str(b.sourceId.value_or(""));
          for (const TMarker& k : b.markers) {
            m.str(k.id);
            m.f64(k.frame);
            m.f64(k.duration);
            m.str(k.name);
            m.str(k.comment);
          }
        }
      }
      m.u64(frame_keys::hash_json(d.transitions().at(c)));
    }
    for (const Json& asset : d.items().assets) m.u64(frame_keys::hash_json(asset));
    {
      wire::Writer w;
      api::encode(w, d.project());
      const auto bytes = w.bytes();
      m.str(std::string_view(reinterpret_cast<const char*>(bytes.data()), bytes.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): bytes → chars
    }
    const MotionBlur& mb = d.motion_blur();
    m.flag(mb.enabled);
    m.f64(mb.shutterAngle);
    m.f64(mb.shutterPhase);
    m.f64(mb.samples);
    m.f64(mb.adaptiveSampleLimit);
    const ColorMgmt& cm = d.color();
    m.str(cm.workingSpace);
    m.str(cm.displayTransform);
    m.f64(cm.bitDepth);
    m.u64(frame_keys::hash_json(d.materials()));
    m.u64(frame_keys::hash_json(d.swatches()));
    m.u64(frame_keys::hash_json(d.guides()));
    return m.value();
  }

  std::string comp_;
  std::string mediaBase_;
  bool indexed_ = false;
  bool volatile_ = false;
  bool global_ = false;
  std::int64_t frames_ = 0;
  double fps_ = 30;
  std::uint64_t static_ = 0;
  std::vector<Layer> layers_;
  std::unordered_map<std::string, std::size_t> layerIndex_;
  std::vector<std::string> compList_;  ///< the comp and every instanced comp reached, sorted
  std::unordered_map<std::string, std::uint64_t> nodeHash_;
  std::vector<std::uint64_t> total_;  ///< per frame: the sum of the rows
};

}  // namespace premation::doc
