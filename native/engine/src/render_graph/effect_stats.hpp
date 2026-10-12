// E4: which path the render graph's effect chain took for each entry of a
// frame — the render stats beside FrameStats' timings (scene_renderer.hpp).
//
// The counters are always kept (plain integers, no allocation). The per-entry
// record (`paths`) is kept only when the caller asks for it (`keepPaths`: the
// bench, the tests, a diagnostics query): it allocates a string pair per
// entry, which the playback hot path must not.
#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace premation::rg {

enum class FxPath : std::uint8_t {
  gpu,             ///< the entry's WGSL pass(es)
  gpu_sdf,         ///< a style drawn from an alpha distance field built this frame
  gpu_sdf_cached,  ///< … from a distance field kept from an earlier frame (content unchanged)
  gpu_silhouette,  ///< a style shaped by the fill-opacity silhouette (style-fill)
  gpu_contours,    ///< a contour-stroke effect (Vegas) from cached contours
  native_plugin,   ///< a G1 native SDK plugin (its host ran it)
  skipped,         ///< declined (a plugin host refused, a missing input)
};

[[nodiscard]] constexpr std::string_view fx_path_name(FxPath p) noexcept {
  switch (p) {
    case FxPath::gpu: return "gpu";
    case FxPath::gpu_sdf: return "gpu-sdf";
    case FxPath::gpu_sdf_cached: return "gpu-sdf-cached";
    case FxPath::gpu_silhouette: return "gpu-silhouette";
    case FxPath::gpu_contours: return "gpu-contours";
    case FxPath::native_plugin: return "native-plugin";
    case FxPath::skipped: return "skipped";
  }
  return "gpu";
}

struct EffectPathRecord {
  std::string layer;
  std::string type;
  FxPath path = FxPath::gpu;
};

struct EffectStats {
  /// Chain entries drawn on the GPU this frame (every path but `skipped`).
  std::uint32_t gpuEntries = 0;
  /// Alpha distance fields built / reused from the cache (fx_distance.hpp).
  std::uint32_t sdfBuilt = 0;
  std::uint32_t sdfReused = 0;
  /// P8: layers whose whole effect chain was a copy of an earlier frame's result.
  std::uint32_t layerChainsReused = 0;
  /// Styles shaped by a fill-opacity silhouette; entries blended back through a scoped mask.
  std::uint32_t silhouetteStyles = 0;
  std::uint32_t scoped = 0;
  /// Faded / scoped effects of several chain entries blended back once over their kept input.
  std::uint32_t blendSpans = 0;
  std::uint32_t skipped = 0;
  /// Grow bounds (fx_bounds.hpp): entries whose passes were scissored to the
  /// chain's reach, and entries drawn over the full frame (an unknown reach).
  std::uint32_t bounded = 0;
  std::uint32_t fullFrame = 0;
  /// E5 (3D perf): shadow maps / SSAO passes / planar reflections rendered this
  /// frame, and the ones served from the last frame's (or an earlier run's)
  /// targets (scene_cache3d.hpp).
  std::uint32_t shadowMapsBuilt = 0;
  std::uint32_t shadowMapsReused = 0;
  std::uint32_t ssaoBuilt = 0;
  std::uint32_t ssaoReused = 0;
  std::uint32_t reflectionsBuilt = 0;
  std::uint32_t reflectionsReused = 0;
  /// Set by the caller before the frame: keep one record per entry.
  bool keepPaths = false;
  std::vector<EffectPathRecord> paths;

  void record(std::string_view layer, std::string_view type, FxPath p) {
    if (p == FxPath::skipped) ++skipped;
    else ++gpuEntries;
    if (p == FxPath::gpu_silhouette) ++silhouetteStyles;
    if (keepPaths) paths.push_back({std::string(layer), std::string(type), p});
  }
};

}  // namespace premation::rg
