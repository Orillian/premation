// The limits the engine asks Dawn for when it makes a device.
//
// A device made without requiredLimits gets the WebGPU defaults — 2D textures
// up to 8192 px — while the frame builder plans rasters up to the TS
// provider's 16384 (frame_build texture_dimension_limit). A text layer at a
// large scale rasterised wider than 8192, Dawn made an error texture, the
// frame's command buffer failed validation and the WHOLE frame came back
// transparent (every layer, backdrop and comp background with it). Both
// device creators (gpu.cpp for the engine process, SceneRenderer::create for
// export) ask for this, and the renderers report the limit they got.
#pragma once

#include <webgpu/webgpu_cpp.h>

#include <algorithm>
#include <cstdint>

namespace premation::rg {

/// The 2D texture size rasters are planned against (VectorRasterizer.ts deviceMax).
inline constexpr std::uint32_t kTextureDimensionWanted = 16384;

/// DeviceDescriptor.requiredLimits: the defaults (undefined = no requirement),
/// with the 2D texture size raised to what the adapter supports, up to
/// kTextureDimensionWanted.
[[nodiscard]] inline wgpu::Limits required_device_limits(const wgpu::Adapter& adapter) {
  wgpu::Limits want{};
  wgpu::Limits supported{};
  if (adapter.GetLimits(&supported) == wgpu::Status::Success && supported.maxTextureDimension2D != wgpu::kLimitU32Undefined) {
    want.maxTextureDimension2D = std::min(supported.maxTextureDimension2D, kTextureDimensionWanted);
  }
  return want;
}

}  // namespace premation::rg
