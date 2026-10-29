// ViTMatte (hustvl, MIT; the Xenova ONNX export, int8): learned alpha matting
// from a picture and a trimap — what Refine Edge runs inside its band when the
// model is installed (models.json `vitmatte`, PREMATION_VITMATTE_USER_DIR).
// The colour-based refine (subject_edit.hpp refine_band) stays the fallback.
//
//   input   pixel_values [1, 4, H, W]: RGB rescaled to 0…1 and normalised
//           (mean 0.5, std 0.5), then the trimap rescaled to 0…1 (0 sure
//           background, 0.5 unknown, 1 sure foreground); H and W padded with
//           zeros up to multiples of 32 (VitMatteImageProcessor);
//   output  alphas [1, 1, H, W] in 0…1.
//
// The ONNX Runtime half is vitmatte_ort_ffi.cpp (FFI only there); this is the
// pure half and the interface the job sees.
#pragma once

#include <cstdint>
#include <memory>
#include <span>
#include <string>
#include <vector>

namespace premation::jobs::vitmatte {

inline constexpr const char* kModelFile = "model_quantized.onnx";
inline constexpr int kMultiple = 32;

class Model {
 public:
  Model() = default;
  virtual ~Model() = default;
  Model(const Model&) = delete;
  Model& operator=(const Model&) = delete;
  Model(Model&&) = delete;
  Model& operator=(Model&&) = delete;
  /// `input` from prepare_input (padded `height`×`width`) → `alpha` (height×width). False with `error`.
  virtual bool run(std::span<const float> input, int width, int height, std::vector<float>& alpha, std::string& error) = 0;
  [[nodiscard]] virtual std::string provider() const = 0;
};

[[nodiscard]] bool runtime_available() noexcept;
/// Opened on the CPU (the export's Einsum nodes trip DirectML).
[[nodiscard]] std::unique_ptr<Model> load(const std::string& path, std::string& error);

/// The model's input for a width×height RGBA8 crop and its trimap (0 / 0.5 / 1):
/// [1,4,padH,padW] NCHW, zero-padded to multiples of kMultiple (`padW` / `padH` set).
[[nodiscard]] std::vector<float> prepare_input(std::span<const std::uint8_t> rgba, std::span<const float> trimap, int width, int height,
                                               int& padW, int& padH);

}  // namespace premation::jobs::vitmatte
