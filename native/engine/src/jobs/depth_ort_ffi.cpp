// ONNX Runtime FFI for the depth model (depth_ort.hpp, camera program D3).
// Ort::Exception never leaves this file. Without the runtime it builds to a
// stub whose load() fails with a clear error.
#include "depth_ort.hpp"

#if __has_include(<onnxruntime_cxx_api.h>)
#include <onnxruntime_cxx_api.h>
#define PREMATION_DEPTH_ORT 1
#elif __has_include(<onnxruntime/onnxruntime_cxx_api.h>)
#include <onnxruntime/onnxruntime_cxx_api.h>
#define PREMATION_DEPTH_ORT 1
#endif

#ifdef PREMATION_DEPTH_ORT
#include "ort_providers_ffi.hpp"

#include <array>
#include <cstdint>
#include <exception>
#include <filesystem>
#endif

namespace premation::jobs::depth {

#ifdef PREMATION_DEPTH_ORT

namespace {

std::filesystem::path path_of(const std::string& utf8) {
  const std::u8string u(reinterpret_cast<const char8_t*>(utf8.data()), utf8.size());  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  return std::filesystem::path(u);
}

class OrtDepth final : public DepthModel {
 public:
  explicit OrtDepth(const std::string& path)
      : env_(ORT_LOGGING_LEVEL_WARNING, "premation-depth"),
        session_(ort::open_session(env_, path_of(path).c_str(), provider_)),
        memory_(Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault)) {
    Ort::AllocatorWithDefaultOptions alloc;
    inName_ = session_.GetInputNameAllocated(0, alloc).get();
    outName_ = session_.GetOutputNameAllocated(0, alloc).get();
  }

  [[nodiscard]] std::string provider() const override { return provider_; }

  bool run(std::span<const float> input, std::vector<float>& out, std::string& error) override {
    try {
      std::vector<float> in(input.begin(), input.end());
      const std::array<std::int64_t, 4> shape{1, 3, kInput, kInput};
      Ort::Value tensor = Ort::Value::CreateTensor<float>(memory_, in.data(), in.size(), shape.data(), shape.size());
      const char* inName = inName_.c_str();
      const char* outName = outName_.c_str();
      std::vector<Ort::Value> outs = session_.Run(Ort::RunOptions{nullptr}, &inName, &tensor, 1, &outName, 1);
      if (outs.empty() || !outs[0].IsTensor()) {
        error = "the model gave no depth tensor";
        return false;
      }
      const Ort::TensorTypeAndShapeInfo info = outs[0].GetTensorTypeAndShapeInfo();
      if (info.GetElementType() != ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT || info.GetElementCount() != std::size_t{kInput} * kInput) {
        error = "the model's output is not a 518×518 float depth map";
        return false;
      }
      const float* d = outs[0].GetTensorData<float>();
      out.assign(d, d + info.GetElementCount());
      return true;
    } catch (const std::exception& e) {
      error = e.what();
      return false;
    }
  }

 private:
  std::string provider_;
  Ort::Env env_;
  Ort::Session session_;
  Ort::MemoryInfo memory_;
  std::string inName_;
  std::string outName_;
};

}  // namespace

bool runtime_available() noexcept { return true; }

std::unique_ptr<DepthModel> load(const std::string& path, std::string& error) {
  try {
    return std::make_unique<OrtDepth>(path);
  } catch (const std::exception& e) {
    error = e.what();
    return nullptr;
  }
}

#else

bool runtime_available() noexcept { return false; }

std::unique_ptr<DepthModel> load(const std::string& /*path*/, std::string& error) {
  error = "this engine build has no ONNX Runtime";
  return nullptr;
}

#endif

}  // namespace premation::jobs::depth
