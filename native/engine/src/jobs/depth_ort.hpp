// Camera program D3 (Photo → 3D parallax): monocular depth estimation with
// Depth Anything V2 Small (ONNX, Apache-2.0) through ONNX Runtime. The FFI
// lives in depth_ort_ffi.cpp (Ort::Exception never leaves it); without the
// runtime it builds to a stub whose load() fails with a clear error.
//
// The pre/post-processing is pure and tested without a model:
//   prepare_input  RGBA → 1×3×518×518 float, bilinear, ImageNet-normalised (NCHW)
//   depth_to_gray  the model's relative inverse depth → 8-bit greyscale at the
//                  picture's aspect, min/max normalised, NEAR = WHITE (the
//                  convention the Depth Parallax renderer reads)
#pragma once

#include <cstdint>
#include <memory>
#include <span>
#include <string>
#include <vector>

namespace premation::jobs::depth {

inline constexpr std::uint32_t kInput = 518;  ///< the model's square input (a multiple of its 14 px patch)

/// The model file the engine looks for in PREMATION_DEPTH_USER_DIR / PREMATION_DEPTH_DIR.
inline constexpr const char* kModelFile = "depth_anything_v2_small.onnx";

class DepthModel {
 public:
  DepthModel() = default;
  virtual ~DepthModel() = default;
  DepthModel(const DepthModel&) = delete;
  DepthModel& operator=(const DepthModel&) = delete;
  DepthModel(DepthModel&&) = delete;
  DepthModel& operator=(DepthModel&&) = delete;
  /// `input` from prepare_input → `out` (kInput² relative inverse depth, row-major). False with `error`.
  virtual bool run(std::span<const float> input, std::vector<float>& out, std::string& error) = 0;
  [[nodiscard]] virtual std::string provider() const = 0;
};

[[nodiscard]] bool runtime_available() noexcept;
[[nodiscard]] std::unique_ptr<DepthModel> load(const std::string& path, std::string& error);

/// Straight RGBA (w × h) → the model input (1×3×kInput×kInput, NCHW, ImageNet mean / std).
[[nodiscard]] std::vector<float> prepare_input(std::span<const std::uint8_t> rgba, std::uint32_t w, std::uint32_t h);

/// The model's kInput² output → an RGBA8 greyscale picture `outW × outH` (near = white).
/// A flat output (no range) is mid grey.
[[nodiscard]] std::vector<std::uint8_t> depth_to_gray(std::span<const float> depth, std::uint32_t outW, std::uint32_t outH);

}  // namespace premation::jobs::depth
