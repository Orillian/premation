// Sound the engine's decoders do not read: files a native plugin imports
// (P7b, pr_io.h PR_IMPORT_READ_AUDIO). The plugin host (src/plugins/contrib.cpp)
// installs the handlers when it attaches; without a host nothing is claimed.
//
// audio_decode_ffi.cpp asks claims(path) first in every entry point
// (probe_audio, conform_audio, decode_range, decode_all_native), and a claimed
// file's samples go through the SAME down-mix and resampler as a decoded stream
// — so the playback mixer (AudioSystem), the export mix and the analysis jobs
// (jobs::read_audio) hear plugin footage exactly as they hear any other.
//
// Header-only (one registry per process, a function-local static): the audio
// libraries do not link the plugin host, and the host does not link ffmpeg.
// A read holds the registry's shared lock for its duration, so clear_handlers()
// (the host going away) waits for reads in flight and none starts after it.
#pragma once

#include <cstdint>
#include <functional>
#include <mutex>
#include <shared_mutex>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace premation::audio {

/// What a claimed file's sound is. `channels` 0 = the file has no sound.
struct ExternalAudioFormat {
  int channels = 0;
  int sampleRate = 0;
  std::int64_t frames = 0;  ///< total sample frames (0 = unknown: read until a short read)
  std::string codec;
};

class ExternalAudio {
 public:
  /// Does a reader take `path` (by extension)? The engine's decoders are then never asked.
  using ClaimFn = std::function<bool(std::string_view path)>;
  /// The file's sound format; false + `error` when the file cannot be read.
  using ProbeFn = std::function<bool(const std::string& path, ExternalAudioFormat& out, std::string& error)>;
  /// Interleaved float32 sample frames [start, start + frames) at the file's own rate and
  /// channel count; fewer than asked = the end of the sound.
  using ReadFn = std::function<bool(const std::string& path, std::int64_t start, std::uint32_t frames,
                                    std::vector<float>& interleaved, std::string& error)>;

  static void set_handlers(ClaimFn claim, ProbeFn probe, ReadFn read) {
    Registry& r = reg();
    const std::unique_lock lock(r.mutex);
    r.claim = std::move(claim);
    r.probe = std::move(probe);
    r.read = std::move(read);
  }

  static void clear_handlers() {
    Registry& r = reg();
    const std::unique_lock lock(r.mutex);
    r.claim = nullptr;
    r.probe = nullptr;
    r.read = nullptr;
  }

  [[nodiscard]] static bool claims(std::string_view path) {
    Registry& r = reg();
    const std::shared_lock lock(r.mutex);
    return r.claim && r.claim(path);
  }

  [[nodiscard]] static bool probe(const std::string& path, ExternalAudioFormat& out, std::string& error) {
    Registry& r = reg();
    const std::shared_lock lock(r.mutex);
    if (!r.probe) {
      error = "no reader for '" + path + "' (the plugin host is gone)";
      return false;
    }
    return r.probe(path, out, error);
  }

  [[nodiscard]] static bool read(const std::string& path, std::int64_t start, std::uint32_t frames,
                                 std::vector<float>& interleaved, std::string& error) {
    Registry& r = reg();
    const std::shared_lock lock(r.mutex);
    if (!r.read) {
      error = "no reader for '" + path + "' (the plugin host is gone)";
      return false;
    }
    return r.read(path, start, frames, interleaved, error);
  }

 private:
  struct Registry {
    std::shared_mutex mutex;
    ClaimFn claim;
    ProbeFn probe;
    ReadFn read;
  };
  static Registry& reg() {
    static Registry r;  // NOLINT(cppcoreguidelines-avoid-non-const-global-variables): the process's one registry
    return r;
  }
};

}  // namespace premation::audio
