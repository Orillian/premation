// Footage files changed on disk (reloadItems, Edit Original's save): the
// session posts the paths here; every viewport drawer drains what it has not
// seen before its next frame — it closes those files' decoders, forgets a
// failed open, and re-reads their stamps — so the next draw decodes the new
// bytes. A log of (generation, paths), not one shared flag, because each
// viewport has its own drawer and each must see every reload once. Bounded:
// a drawer that has fallen behind the log forgets every source (the safe
// answer: everything re-opens).
#pragma once

#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

namespace premation::scene {

class MediaReloadLog {
 public:
  static MediaReloadLog& instance() {
    static MediaReloadLog log;
    return log;
  }

  /// Post one reload (absolute paths, UTF-8). Returns its generation.
  std::uint64_t post(std::vector<std::string> paths) {
    const std::scoped_lock lock(m_);
    entries_.emplace_back(++gen_, std::move(paths));
    while (entries_.size() > kKeep) entries_.pop_front();
    return gen_;
  }

  struct Pending {
    std::vector<std::string> paths;
    /// The drawer is further behind than the log keeps: forget every source.
    bool everything = false;
  };

  /// What a drawer that last saw `seen` has to forget; advances `seen`.
  Pending take(std::uint64_t& seen) {
    const std::scoped_lock lock(m_);
    Pending out;
    if (seen >= gen_) return out;
    if (!entries_.empty() && entries_.front().first > seen + 1) out.everything = true;
    for (const auto& [g, paths] : entries_) {
      if (g > seen) out.paths.insert(out.paths.end(), paths.begin(), paths.end());
    }
    seen = gen_;
    return out;
  }

  /// The newest generation (a new drawer starts here: it has nothing open yet).
  std::uint64_t generation() {
    const std::scoped_lock lock(m_);
    return gen_;
  }

 private:
  MediaReloadLog() = default;
  static constexpr std::size_t kKeep = 64;
  std::mutex m_;
  std::uint64_t gen_ = 0;
  std::deque<std::pair<std::uint64_t, std::vector<std::string>>> entries_;
};

}  // namespace premation::scene
