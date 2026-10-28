// The single-frame Object Matte's encoder output, kept on disk between calls
// (hover-to-preview asks the same frame again and again, each time in a fresh
// child process): keyed by the footage file + its mtime + the frame index +
// the encoder model file + its mtime, one file per entry in a cache folder,
// the most recent `keep` kept. A second prompt on the same frame then skips
// the encoder (the costly half). Written temp + rename, so a crash mid-write
// never leaves an entry that reads.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace premation::jobs::sam {

struct CachedTensor {
  std::vector<float> data;
  std::vector<std::int64_t> shape;
};

struct CachedEmbedding {
  std::uint32_t width = 0;   ///< the decoded frame's size (the prompts and the mask need it)
  std::uint32_t height = 0;
  CachedTensor image;
  CachedTensor positional;
};

/// The cache key: every input the encoder output depends on. Empty when a file cannot be stat'ed.
[[nodiscard]] std::string embedding_key(const std::string& footage, std::int64_t frame, const std::string& encoderModel);

/// The entry for `key` in `dir`, or nullopt (absent, unreadable, or not this format). A hit marks the entry recent.
[[nodiscard]] std::optional<CachedEmbedding> read_embedding(const std::string& dir, const std::string& key);

/// Store `e` under `key`, then drop all but the `keep` most recent entries. False on an I/O failure (the job goes on).
bool write_embedding(const std::string& dir, const std::string& key, const CachedEmbedding& e, std::size_t keep = 8);

}  // namespace premation::jobs::sam
