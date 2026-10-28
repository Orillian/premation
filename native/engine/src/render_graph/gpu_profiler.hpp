// GPU time per layer, sampled one frame at a time — what the Cache & Memory
// panel's "Heaviest layers" reads (getRenderStats profileLayers).
//
// A sampled frame puts begin/end timestamps on every render pass the Device
// opens (WebGPU pass timestampWrites, TimestampQuery) and tags each pass with
// the scope that opened it: the root-level layer the composition pass is
// drawing (a precomp's whole subtree and every effect pass count to the layer
// that holds it), a run of 3D layers drawn as one depth-tested group, or the
// frame's own work (clear, background, display transform). The query set is
// resolved at the end of the frame into a buffer that is mapped without
// waiting: the result lands a frame or two later, and a frame never stalls on
// it. Off between samples: no queries, no extra passes, nothing allocated per
// frame. Render thread only.
#pragma once

#include <webgpu/webgpu_cpp.h>

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace premation::rg {

/// One scope's share of a sampled frame.
struct GpuScopeCost {
  enum class Kind : std::uint8_t { layer, scene3d, frame };
  std::string id;  ///< the layer id (scene3d: the group's first layer; frame: empty)
  Kind kind = Kind::layer;
  double gpuMs = 0;
  std::uint32_t passes = 0;
};

/// A finished sample: every scope, heaviest first, and the frame's measured total.
struct GpuFrameProfile {
  std::vector<GpuScopeCost> scopes;
  double totalMs = 0;
  /// Passes the sample could not time (the query set was full): the totals are a floor.
  std::uint32_t untimedPasses = 0;
  /// The Device frame it was taken on.
  std::uint64_t frame = 0;
};

class GpuProfiler {
 public:
  /// The scope id of the frame's own work.
  static constexpr std::uint32_t kFrameScope = 0;

  GpuProfiler() = default;
  /// Whether the device can time passes (TimestampQuery was granted).
  void init(const wgpu::Device& device, const wgpu::Instance& instance);
  [[nodiscard]] bool supported() const noexcept { return querySet_ != nullptr; }

  /// Sample the next frame begin_frame starts (no-op while a sample is still being read back).
  void arm() noexcept { armed_ = true; }
  /// Device::begin_frame: collect a finished read-back, start a sample if armed.
  void begin_frame(std::uint64_t frame);
  /// Whether this frame is being sampled (the composition pass then flushes per layer).
  [[nodiscard]] bool active() const noexcept { return active_; }
  /// Passes opened from now on count to `id` (a layer id; kind scene3d for a 3D group).
  void set_scope(std::string_view id, GpuScopeCost::Kind kind = GpuScopeCost::Kind::layer);
  /// Back to the frame's own work.
  void clear_scope() noexcept { scope_ = kFrameScope; }
  /// Device::begin_pass: the pass's timestamp writes while sampling (null otherwise / when full).
  [[nodiscard]] const wgpu::PassTimestampWrites* pass_writes();
  /// Device::end_frame, before the encoder is finished: resolve the queries and copy them for read-back.
  void end_frame(const wgpu::CommandEncoder& encoder);
  /// Device::end_frame, after the submit: start the asynchronous map.
  void after_submit();
  /// Collect a sample whose read-back finished (begin_frame does too; this is for an idle engine).
  void poll();
  /// The newest finished sample (nullopt until one has been read back).
  [[nodiscard]] const std::optional<GpuFrameProfile>& last() const noexcept { return last_; }

 private:
  /// Passes one sample can time (two queries each).
  static constexpr std::uint32_t kMaxPasses = 1024;
  struct Scope {
    std::string id;
    GpuScopeCost::Kind kind = GpuScopeCost::Kind::frame;
  };
  void collect();

  wgpu::Instance instance_;
  wgpu::QuerySet querySet_;
  wgpu::Buffer resolve_;
  wgpu::Buffer readback_;
  wgpu::PassTimestampWrites writes_{};
  bool armed_ = false;
  bool active_ = false;
  /// A sample's read-back is mapping: no new sample until it is collected.
  bool reading_ = false;
  bool mapped_ = false;
  bool mapFailed_ = false;
  std::uint64_t frame_ = 0;
  std::uint64_t sampleFrame_ = 0;
  std::uint32_t passes_ = 0;
  std::uint32_t untimed_ = 0;
  std::uint32_t scope_ = kFrameScope;
  /// Scope per timed pass of the sample in flight.
  std::vector<std::uint32_t> passScope_;
  std::vector<Scope> scopes_;
  std::unordered_map<std::string, std::uint32_t> scopeIndex_;
  std::optional<GpuFrameProfile> last_;
};

}  // namespace premation::rg
