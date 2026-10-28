// ONNX Runtime FFI for the SAM 2.1 video graphs (sam2_track.hpp) — the only
// file that sees the ORT API for them. The GPU provider when the runtime has
// one (ort_providers_ffi.hpp), else the CPU; Ort::Exception never leaves this
// file. Without the runtime it builds to a stub whose load() fails clearly.
#include "sam2_track.hpp"

#if __has_include(<onnxruntime_cxx_api.h>)
#include <onnxruntime_cxx_api.h>
#define PREMATION_SAM2_ORT 1
#elif __has_include(<onnxruntime/onnxruntime_cxx_api.h>)
#include <onnxruntime/onnxruntime_cxx_api.h>
#define PREMATION_SAM2_ORT 1
#endif

#ifdef PREMATION_SAM2_ORT
#include "ort_providers_ffi.hpp"

#include <array>
#include <exception>
#include <filesystem>
#endif

namespace premation::jobs::sam2 {

#ifdef PREMATION_SAM2_ORT

namespace {

std::filesystem::path model_path(const std::string& dir, const char* file) {
  return std::filesystem::path(std::u8string(dir.begin(), dir.end())) / file;
}

/// ORT never writes an input; CreateTensor wants a mutable pointer.
Ort::Value input(const Ort::MemoryInfo& m, std::span<const float> d, std::span<const std::int64_t> shape) {
  return Ort::Value::CreateTensor<float>(m, const_cast<float*>(d.data()), d.size(), shape.data(), shape.size());  // NOLINT(cppcoreguidelines-pro-type-const-cast)
}

bool take(Ort::Value& v, std::vector<float>& out, const char* name, std::string& error) {
  if (!v.IsTensor() || v.GetTensorTypeAndShapeInfo().GetElementType() != ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT) {
    error = std::string(name) + " is not a float tensor";
    return false;
  }
  const std::size_t n = v.GetTensorTypeAndShapeInfo().GetElementCount();
  const float* d = v.GetTensorData<float>();
  out.assign(d, d + n);
  return true;
}

class OrtSam2 final : public Models {
 public:
  explicit OrtSam2(const std::string& dir)
      : env_(ORT_LOGGING_LEVEL_WARNING, "premation-sam2"),
        vision_(ort::open_session(env_, model_path(dir, "vision_encoder.onnx").c_str(), provider_)),
        decoder_(ort::open_session(env_, model_path(dir, "mask_decoder.onnx").c_str(), unused_)),
        memEnc_(ort::open_session(env_, model_path(dir, "memory_encoder.onnx").c_str(), unused_)),
        memAttn_(ort::open_session(env_, model_path(dir, "memory_attention.onnx").c_str(), unused_)),
        // 16 numbers in, 16×64 out: the CPU, no round trip to the GPU.
        tpos_(env_, model_path(dir, "pointer_tpos.onnx").c_str(), ort::cpu_options(1)),
        memory_(Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault)) {}

  [[nodiscard]] std::string provider() const override { return provider_; }

  bool encode(std::span<const float> pixels, Vision& out, std::string& error) override {
    try {
      const std::array<std::int64_t, 4> shape{1, 3, kInput, kInput};
      Ort::Value in = input(memory_, pixels, shape);
      const std::array<const char*, 1> inNames{"pixel_values"};
      const std::array<const char*, 5> outNames{"feats0", "feats1", "feats2", "feats2_no_mem", "vision_pos_embed"};
      std::vector<Ort::Value> outs = vision_.Run(Ort::RunOptions{nullptr}, inNames.data(), &in, 1, outNames.data(), outNames.size());
      return outs.size() == 5 && take(outs[0], out.feats0, "feats0", error) && take(outs[1], out.feats1, "feats1", error) &&
             take(outs[2], out.feats2, "feats2", error) && take(outs[3], out.feats2NoMem, "feats2_no_mem", error) &&
             take(outs[4], out.pos, "vision_pos_embed", error);
    } catch (const std::exception& e) {
      error = e.what();
      return false;
    }
  }

  bool decode(const Vision& v, std::span<const float> featsCond, std::span<const float> points, std::span<const std::int32_t> labels,
              Decoded& out, std::string& error) override {
    try {
      const auto n = static_cast<std::int64_t>(labels.size());
      const std::array<std::int64_t, 4> s0{1, 32, 256, 256};
      const std::array<std::int64_t, 4> s1{1, 64, 128, 128};
      const std::array<std::int64_t, 4> s2{1, 256, 64, 64};
      const std::array<std::int64_t, 4> sp{1, 1, n, 2};
      const std::array<std::int64_t, 3> sl{1, 1, n};
      std::array<Ort::Value, 5> ins{
          input(memory_, v.feats0, s0), input(memory_, v.feats1, s1), input(memory_, featsCond, s2), input(memory_, points, sp),
          Ort::Value::CreateTensor<std::int32_t>(memory_, const_cast<std::int32_t*>(labels.data()), labels.size(), sl.data(),  // NOLINT(cppcoreguidelines-pro-type-const-cast)
                                                 sl.size())};
      const std::array<const char*, 5> inNames{"feats0", "feats1", "feats2_cond", "input_points", "input_labels"};
      const std::array<const char*, 4> outNames{"high_res_mask", "iou", "object_score_logits", "object_pointer"};
      std::vector<Ort::Value> outs = decoder_.Run(Ort::RunOptions{nullptr}, inNames.data(), ins.data(), ins.size(), outNames.data(), outNames.size());
      std::vector<float> iou, score;
      if (outs.size() != 4 || !take(outs[0], out.highRes, "high_res_mask", error) || !take(outs[1], iou, "iou", error) ||
          !take(outs[2], score, "object_score_logits", error) || !take(outs[3], out.pointer, "object_pointer", error)) {
        if (error.empty()) error = "mask_decoder answered the wrong outputs";
        return false;
      }
      out.iou = iou.empty() ? 0.0F : iou.front();
      out.objectScore = score.empty() ? 0.0F : score.front();
      return true;
    } catch (const std::exception& e) {
      error = e.what();
      return false;
    }
  }

  bool encode_memory(std::span<const float> feats2, std::span<const float> highRes, float objectScore, bool binarize, Memory& out,
                     std::string& error) override {
    try {
      const std::array<std::int64_t, 4> s2{1, 256, 64, 64};
      const std::array<std::int64_t, 4> sm{1, 1, kInput, kInput};
      const std::array<std::int64_t, 2> ss{1, 1};
      std::array<float, 1> score{objectScore};
      std::array<float, 1> bin{binarize ? 1.0F : 0.0F};
      std::array<Ort::Value, 4> ins{input(memory_, feats2, s2), input(memory_, highRes, sm), input(memory_, score, ss),
                                    Ort::Value::CreateTensor<float>(memory_, bin.data(), 1, nullptr, 0)};
      const std::array<const char*, 4> inNames{"feats2", "high_res_mask", "object_score_logits", "binarize"};
      const std::array<const char*, 2> outNames{"memory_tokens", "memory_pos"};
      std::vector<Ort::Value> outs = memEnc_.Run(Ort::RunOptions{nullptr}, inNames.data(), ins.data(), ins.size(), outNames.data(), outNames.size());
      return outs.size() == 2 && take(outs[0], out.tokens, "memory_tokens", error) && take(outs[1], out.pos, "memory_pos", error);
    } catch (const std::exception& e) {
      error = e.what();
      return false;
    }
  }

  bool attend(std::span<const float> features, std::span<const float> pos, std::span<const float> memory, std::span<const float> memoryPos,
              std::vector<float>& conditioned, std::string& error) override {
    try {
      const std::array<std::int64_t, 3> sf{static_cast<std::int64_t>(kTokens), 1, static_cast<std::int64_t>(kHidden)};
      const std::array<std::int64_t, 3> sm{static_cast<std::int64_t>(kMemoryTokens), 1, static_cast<std::int64_t>(kMemDim)};
      std::array<Ort::Value, 4> ins{input(memory_, features, sf), input(memory_, pos, sf), input(memory_, memory, sm),
                                    input(memory_, memoryPos, sm)};
      const std::array<const char*, 4> inNames{"current_vision_features", "current_vision_position_embeddings", "memory", "memory_pos"};
      const std::array<const char*, 1> outNames{"conditioned_feats"};
      std::vector<Ort::Value> outs = memAttn_.Run(Ort::RunOptions{nullptr}, inNames.data(), ins.data(), ins.size(), outNames.data(), outNames.size());
      return outs.size() == 1 && take(outs[0], conditioned, "conditioned_feats", error);
    } catch (const std::exception& e) {
      error = e.what();
      return false;
    }
  }

  bool pointer_pos(std::span<const float> normalizedDiffs, std::vector<float>& out, std::string& error) override {
    try {
      const std::array<std::int64_t, 1> sd{static_cast<std::int64_t>(normalizedDiffs.size())};
      Ort::Value in = input(memory_, normalizedDiffs, sd);
      const std::array<const char*, 1> inNames{"normalized_diffs"};
      const std::array<const char*, 1> outNames{"pointer_pos"};
      std::vector<Ort::Value> outs = tpos_.Run(Ort::RunOptions{nullptr}, inNames.data(), &in, 1, outNames.data(), outNames.size());
      return outs.size() == 1 && take(outs[0], out, "pointer_pos", error);
    } catch (const std::exception& e) {
      error = e.what();
      return false;
    }
  }

 private:
  // Declaration order is construction order: the providers and the Env first.
  std::string provider_;
  std::string unused_;
  Ort::Env env_;
  Ort::Session vision_;
  Ort::Session decoder_;
  Ort::Session memEnc_;
  Ort::Session memAttn_;
  Ort::Session tpos_;
  Ort::MemoryInfo memory_;
};

}  // namespace

std::unique_ptr<Models> load(const std::string& dir, std::string& error) {
  if (!installed(dir)) {
    error = "the SAM 2 model folder '" + dir + "' is incomplete";
    return nullptr;
  }
  try {
    return std::make_unique<OrtSam2>(dir);
  } catch (const std::exception& e) {
    error = e.what();
    return nullptr;
  }
}

#else

std::unique_ptr<Models> load(const std::string& /*dir*/, std::string& error) {
  error = "this engine build has no ONNX Runtime";
  return nullptr;
}

#endif

}  // namespace premation::jobs::sam2
