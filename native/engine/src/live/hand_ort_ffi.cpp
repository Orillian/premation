// ONNX Runtime FFI for the hand models (hand_ort.hpp). Ort::Exception never
// leaves this file. Without the runtime it builds to a stub whose load fails
// with a clear error.
#include "hand_ort.hpp"

#if __has_include(<onnxruntime_cxx_api.h>)
#include <onnxruntime_cxx_api.h>
#define PREMATION_LIVE_ORT 1
#elif __has_include(<onnxruntime/onnxruntime_cxx_api.h>)
#include <onnxruntime/onnxruntime_cxx_api.h>
#define PREMATION_LIVE_ORT 1
#endif

#ifdef PREMATION_LIVE_ORT
#include "ort_providers_ffi.hpp"

#include <array>
#include <exception>
#include <filesystem>
#include <sstream>
#endif

namespace premation::live {

#ifdef PREMATION_LIVE_ORT

namespace {

std::filesystem::path path_of(const std::string& utf8) {
  const std::u8string u(reinterpret_cast<const char8_t*>(utf8.data()), utf8.size());
  return std::filesystem::path(u);
}

/// ONE runtime environment for every live model: a second Env re-registers
/// every operator schema (pages of errors on stderr) for nothing.
Ort::Env& shared_env() {
  static Ort::Env env(ORT_LOGGING_LEVEL_WARNING, "premation-live");
  return env;
}

Ort::SessionOptions options_for(bool cpuOnly, std::string& provider) {
  if (cpuOnly) {
    Ort::SessionOptions o;
    o.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
    // A live stream: one frame at a time, so a couple of threads beat many.
    o.SetIntraOpNumThreads(2);
    provider = "cpu";
    return o;
  }
  return jobs::ort::session_options(provider);
}

std::string shape_text(const std::vector<std::int64_t>& s) {
  std::ostringstream o;
  o << '[';
  for (std::size_t i = 0; i < s.size(); ++i) o << (i ? "," : "") << s[i];
  o << ']';
  return o.str();
}

class OrtModel final : public Model {
 public:
  OrtModel(const std::string& path, bool cpuOnly)
      : options_(options_for(cpuOnly, provider_)),
        session_(shared_env(), path_of(path).c_str(), options_),
        memory_(Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault)) {
    Ort::AllocatorWithDefaultOptions alloc;
    inName_ = session_.GetInputNameAllocated(0, alloc).get();
    inShape_ = session_.GetInputTypeInfo(0).GetTensorTypeAndShapeInfo().GetShape();
    planar_ = inShape_.size() == 4 && inShape_[1] == 3;
    if (inShape_.size() == 4) side_ = static_cast<int>(planar_ ? inShape_[2] : inShape_[1]);
    for (std::size_t i = 0; i < session_.GetOutputCount(); ++i) {
      outNames_.emplace_back(session_.GetOutputNameAllocated(i, alloc).get());
      outShapes_.push_back(session_.GetOutputTypeInfo(i).GetTensorTypeAndShapeInfo().GetShape());
    }
  }

  [[nodiscard]] bool planar() const noexcept override { return planar_; }
  [[nodiscard]] int input_side() const noexcept override { return side_ > 0 ? side_ : 0; }
  [[nodiscard]] std::string provider() const override { return provider_; }

  [[nodiscard]] std::string describe() const override {
    std::ostringstream o;
    o << "in  " << inName_ << ' ' << shape_text(inShape_) << '\n';
    for (std::size_t i = 0; i < outNames_.size(); ++i) o << "out " << outNames_[i] << ' ' << shape_text(outShapes_[i]) << '\n';
    return o.str();
  }

  bool run(std::span<const float> input, std::vector<TensorOut>& out, std::string& error) override {
    try {
      const std::int64_t n = side_ > 0 ? side_ : 0;
      const std::array<std::int64_t, 4> shape = planar_ ? std::array<std::int64_t, 4>{1, 3, n, n} : std::array<std::int64_t, 4>{1, n, n, 3};
      // ORT does not write the input; CreateTensor wants a mutable pointer.
      Ort::Value tensor = Ort::Value::CreateTensor<float>(memory_, const_cast<float*>(input.data()), input.size(), shape.data(), shape.size());
      const char* inName = inName_.c_str();
      std::vector<const char*> names;
      names.reserve(outNames_.size());
      for (const std::string& s : outNames_) names.push_back(s.c_str());
      std::vector<Ort::Value> outs = session_.Run(Ort::RunOptions{nullptr}, &inName, &tensor, 1, names.data(), names.size());
      out.resize(outs.size());
      for (std::size_t i = 0; i < outs.size(); ++i) {
        TensorOut& t = out[i];
        t.name = outNames_[i];
        t.data.clear();
        if (!outs[i].IsTensor()) continue;
        const Ort::TensorTypeAndShapeInfo info = outs[i].GetTensorTypeAndShapeInfo();
        t.shape = info.GetShape();
        if (info.GetElementType() != ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT) continue;
        const float* d = outs[i].GetTensorData<float>();
        t.data.assign(d, d + info.GetElementCount());
      }
      return true;
    } catch (const std::exception& e) {
      error = e.what();
      return false;
    }
  }

 private:
  std::string provider_;
  Ort::SessionOptions options_;
  Ort::Session session_;
  Ort::MemoryInfo memory_;
  std::string inName_;
  std::vector<std::int64_t> inShape_;
  std::vector<std::string> outNames_;
  std::vector<std::vector<std::int64_t>> outShapes_;
  bool planar_ = false;
  int side_ = 0;
};

}  // namespace

bool runtime_available() noexcept { return true; }

std::unique_ptr<Model> load_model(const std::string& path, bool cpuOnly, std::string& error) {
  try {
    return std::make_unique<OrtModel>(path, cpuOnly);
  } catch (const std::exception& e) {
    error = e.what();
    return nullptr;
  }
}

#else

bool runtime_available() noexcept { return false; }

std::unique_ptr<Model> load_model(const std::string& /*path*/, bool /*cpuOnly*/, std::string& error) {
  error = "this engine build has no ONNX Runtime";
  return nullptr;
}

#endif

}  // namespace premation::live
