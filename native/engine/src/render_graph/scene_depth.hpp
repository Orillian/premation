// Plugin SDK 1.2 (S6): the scene depth a native plugin effect reads —
// checkout_scene_depth[_gpu] (pr_host.h), Element 3D's "Composite with scene
// depth".
//
// What it is: the camera-space z ((view · p).z, comp px, positive in front of
// the eye) of the nearest surface of the composition's 3D layers OTHER than the
// effect's own, seen through the comp camera at the frame's time, in the
// effect's world pixels (the chain buffer: comp px → world px through the
// chain's comp_to_world). +inf where no 3D layer is drawn. A texel whose
// coverage (texture alpha × mask × layer opacity × tint alpha, or the solid's
// shape) is under 1/255 writes no depth — the rule the engine's own 3D pass
// discards by (textured3d.wgsl / solid3d.wgsl).
//
// How: one render pass of its own (an r32float colour target + a depth32float
// buffer), over the same geometry the 3D group draws — the unit quad under
// `three_d.model`, an extruded / model mesh's cached vertex + index buffers
// (Device::geometry keys threed.cpp uses) — through the scope's camera3d.
// Submitted on the queue at once, so it runs before a plugin's commands.
//
// Cost: only an effect that declares PR_OUT_FLAG_USES_SCENE_DEPTH and then asks
// for it pays. Within one frame every effect that asks with the same world
// size, placement and set of drawn layers (an effect on a 2D layer excludes
// nothing, so all of them share) gets the SAME pass; the CPU read-back is kept
// with it.
//
// Render thread only (the Device is single-threaded).
#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "render_context.hpp"

namespace premation::rg {

class SceneDepth {
 public:
  struct Request {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    /// comp px → world px, row-major 3×3 (PrInData.comp_to_world).
    std::array<double, 9> compToWorld{1, 0, 0, 0, 1, 0, 0, 0, 1};
    /// The effect's own layer: never drawn into its depth.
    std::string_view selfId;
    /// SDK 1.2 (checkout_scene_depth_gpu_at): the 3D layers and camera posed at a sample's time.
    /// `poseKey` names the pose (the sample's time; INT64_MIN = the frame's own); `camera` replaces
    /// the comp camera (nullptr = the frame's) and `models` a drawn renderable's three_d.model by id.
    std::int64_t poseKey = INT64_MIN;
    const api::RenderCamera3D* camera = nullptr;
    const std::vector<std::pair<std::string, std::vector<double>>>* models = nullptr;
  };
  struct Result {
    wgpu::Texture texture;  ///< r32float, TextureBinding | CopySrc | RenderAttachment
    wgpu::TextureView view;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    /// The 3D layers drawn into it (tests, diagnostics).
    std::uint32_t layers = 0;
  };

  SceneDepth();
  ~SceneDepth();
  SceneDepth(const SceneDepth&) = delete;
  SceneDepth& operator=(const SceneDepth&) = delete;
  SceneDepth(SceneDepth&&) = delete;
  SceneDepth& operator=(SceneDepth&&) = delete;

  /// The depth for `req` this frame: rendered on the first ask, the same pass for every later
  /// ask of the frame with an equal request. nullptr when it cannot be made (a zero size, past
  /// the device's texture limit).
  const Result* render(PassContext& ctx, const Request& req);
  /// The same depth on the CPU: width × height floats, rows top-down (kept with the pass).
  const std::vector<float>* read_back(PassContext& ctx, const Request& req);
  /// Passes rendered so far (tests: several effects of one frame share one).
  [[nodiscard]] std::uint64_t passes() const noexcept { return passes_; }

 private:
  struct Gpu;
  struct Entry;
  Entry* entry_for(PassContext& ctx, const Request& req);
  std::unique_ptr<Gpu> gpu_;
  std::vector<std::unique_ptr<Entry>> entries_;
  std::uint64_t frame_ = ~std::uint64_t{0};
  std::uint64_t passes_ = 0;
};

}  // namespace premation::rg
