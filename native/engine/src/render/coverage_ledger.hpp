// Cached playback without a build, and the cache bars that stay right across
// an edit — the two render-side pieces of the pre-build key (core/frame_keys.hpp
// derives the key; this header consumes it):
//
//  * PrebuildMap: pre-build key → the keys a build of that frame produced
//    (content key, disk key). The core thread asks before it builds a frame
//    (Session::submit_frame_to); the render thread learns an entry whenever it
//    stores or serves a frame that carried a pre-build key, and forgets one
//    when no tier holds the frame after all. The map is an ACCELERATOR over
//    the content key, which stays the source of truth for what a tier holds:
//    it may miss (the frame builds, as before), it never names a frame of
//    other content, because the pre-build key covers every input the build
//    reads (frame_keys.hpp says how). Bounded; cleared when it grows past
//    kMaxEntries (every entry is re-learned by the next build).
//
//  * CoverageLedger: per viewport, the frames cached under the cache scope it
//    shows now (RenderJob::cacheScope: comp, view state and document revision),
//    frame index → keys. A document revision used to start the bar over, or
//    carry the whole previous bar when the one frame being drawn had not
//    changed — green over frames the edit DID change. Now the session says,
//    per revision step, which frames the edit could have changed
//    (FrameRevision): unchanged frames keep their keys, a changed frame drops
//    out unless the map already knows its new pre-build key and a tier still
//    holds that frame (an undo: the bar comes back at once).
//
// Both are used by the render thread (render_thread.cpp) and by the simulated
// sink (core/simulated_sink.hpp): the same bars and the same build-skipping
// decisions with or without a GPU, so the session tests cover them.
#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <unordered_map>
#include <utility>
#include <vector>

#include "frame_scene.hpp"

namespace premation::render {

/// The pre-build key of a frame for one viewport: the view the frame is drawn
/// for (the high word of Session::cache_scope — the comp and the viewport's
/// view state, which the slot size and the camera are part of) mixed with the
/// document's key for the frame (doc::FrameKeyIndex::key). Never 0.
[[nodiscard]] inline std::uint64_t prebuild_key(std::uint64_t cacheScope, std::uint64_t docFrameKey) noexcept {
  std::uint64_t x = (cacheScope >> 32U) * 0x9e3779b97f4a7c15ULL;
  x ^= docFrameKey + 0x632be59bd9b4e019ULL + (x << 6U) + (x >> 2U);
  x ^= x >> 30U;
  x *= 0xbf58476d1ce4e5b9ULL;
  x ^= x >> 27U;
  x *= 0x94d049bb133111ebULL;
  x ^= x >> 31U;
  return x == 0 ? 1 : x;
}

/// Pre-build key → the keys a build of that frame produced. Any thread.
class PrebuildMap {
 public:
  /// 2^18 entries × ~40 bytes ≈ 10 MB: a long comp at every view state the
  /// user scrubbed through. Past it the map starts over (self-healing: a
  /// forgotten entry costs one build).
  static constexpr std::size_t kMaxEntries = std::size_t{1} << 18U;

  [[nodiscard]] std::optional<CachedKeys> find(std::uint64_t key) const {
    const std::lock_guard<std::mutex> lock(m_);
    const auto it = map_.find(key);
    if (it == map_.end()) return std::nullopt;
    return it->second;
  }
  void learn(std::uint64_t key, CachedKeys keys) {
    const std::lock_guard<std::mutex> lock(m_);
    if (map_.size() >= kMaxEntries) map_.clear();
    // One small allocation per frame LEARNED (a map node), on purpose: a frame
    // is learned once per view state, then presented from the map for as long
    // as a tier holds it.
    map_[key] = keys;
  }
  void forget(std::uint64_t key) {
    const std::lock_guard<std::mutex> lock(m_);
    map_.erase(key);
  }
  void clear() {
    const std::lock_guard<std::mutex> lock(m_);
    map_.clear();
  }
  [[nodiscard]] std::size_t size() const {
    const std::lock_guard<std::mutex> lock(m_);
    return map_.size();
  }

 private:
  mutable std::mutex m_;
  std::unordered_map<std::uint64_t, CachedKeys> map_;
};

/// The bars. Owner-thread only (the render thread's, the simulated sink's under its lock).
class CoverageLedger {
 public:
  /// One cache scope's frames: frame index → keys. A frame counts while a tier still holds it (the owner prunes).
  struct ScopeCover {
    std::uint64_t scope = 0;
    std::unordered_map<std::int64_t, CachedKeys> frames;
  };
  using Scopes = std::deque<ScopeCover>;
  /// Whether a tier still holds the frame with these keys.
  using Held = std::function<bool(const CachedKeys&)>;
  /// Per viewport: its current scope first, a few recent ones kept so
  /// switching back — a comp, a zoom, a pane — shows what is still cached.
  static constexpr std::size_t kScopesKept = 8;
  /// Revision steps kept for the carry-over chain (a bar that fell this far
  /// behind the document starts over).
  static constexpr std::size_t kRevisionsKept = 256;

  void note_revision(FrameRevision rev) {
    revisions_.push_back(std::move(rev));
    if (revisions_.size() > kRevisionsKept) revisions_.pop_front();
  }

  /// `job` is cached as `keys` under its scope. True when the bars changed.
  bool note(const RenderJob& job, const CachedKeys& keys, const PrebuildMap& map, const Held& held) {
    Scopes& scopes = cover_[job.viewport];
    bool changed = false;
    if (scopes.empty() || scopes.front().scope != job.cacheScope) {
      // Another comp, an edit, another view: the bars follow what the viewport
      // shows now. A scope seen lately comes back with what it still has cached.
      const auto it = std::ranges::find_if(scopes, [&job](const ScopeCover& c) { return c.scope == job.cacheScope; });
      ScopeCover current;
      if (it != scopes.end()) {
        current = std::move(*it);
        scopes.erase(it);
      } else {
        current.scope = job.cacheScope;
        // The same view at a new revision: every frame the revision steps in
        // between did not touch carries over; a touched frame comes back when
        // the map knows its new key and a tier holds it.
        if (!scopes.empty() && same_view(scopes.front().scope, job.cacheScope)) carry(current, scopes.front(), map, held);
      }
      scopes.push_front(std::move(current));
      if (scopes.size() > kScopesKept) scopes.pop_back();
      changed = true;
    }
    CachedKeys& entry = scopes.front().frames[job.frame];
    if (entry.content != keys.content || (keys.disk != 0 && entry.disk != keys.disk)) changed = true;
    entry.content = keys.content;
    if (keys.disk != 0) entry.disk = keys.disk;
    return changed;
  }

  void forget_viewport(std::uint32_t viewport) { cover_.erase(viewport); }
  void clear() {
    cover_.clear();
    revisions_.clear();
  }
  /// Every viewport's scopes (current first), for the owner to prune and publish.
  [[nodiscard]] std::map<std::uint32_t, Scopes>& viewports() noexcept { return cover_; }
  [[nodiscard]] const std::map<std::uint32_t, Scopes>& viewports() const noexcept { return cover_; }
  /// The current scope's frames of `viewport` (null = none yet).
  [[nodiscard]] const ScopeCover* current(std::uint32_t viewport) const {
    const auto it = cover_.find(viewport);
    return it == cover_.end() || it->second.empty() ? nullptr : &it->second.front();
  }
  [[nodiscard]] static bool same_view(std::uint64_t a, std::uint64_t b) noexcept { return (a >> 32U) == (b >> 32U); }
  [[nodiscard]] static std::uint32_t revision_of(std::uint64_t scope) noexcept {
    return static_cast<std::uint32_t>(scope & 0xffffffffULL);
  }

 private:
  /// `into` (a new revision of `from`'s view) starts with what `from` has,
  /// less the frames the revision steps between them changed. Nothing carries
  /// when the chain of steps is not known (the ledger fell behind).
  void carry(ScopeCover& into, const ScopeCover& from, const PrebuildMap& map, const Held& held) const {
    const std::uint32_t target = revision_of(into.scope);
    std::uint32_t rev = revision_of(from.scope);
    std::unordered_map<std::int64_t, CachedKeys> frames = from.frames;
    for (std::size_t steps = 0; rev != target; ++steps) {
      if (steps >= kRevisionsKept) return;  // a cycle of revision words: unknown
      const auto r = std::ranges::find_if(revisions_, [rev](const FrameRevision& x) { return x.fromRev == rev; });
      if (r == revisions_.end()) return;
      if (r->all) {
        frames.clear();
      } else {
        const bool keyed = r->keys.size() == r->frames.size();
        for (std::size_t i = 0; i < r->frames.size(); ++i) {
          const std::int64_t f = r->frames[i];
          if (keyed) {
            if (const std::optional<CachedKeys> k = map.find(prebuild_key(into.scope, r->keys[i])); k && held(*k)) {
              frames[f] = *k;
              continue;
            }
          }
          frames.erase(f);
        }
      }
      rev = r->toRev;
    }
    into.frames = std::move(frames);
  }

  std::map<std::uint32_t, Scopes> cover_;
  std::deque<FrameRevision> revisions_;
};

}  // namespace premation::render
