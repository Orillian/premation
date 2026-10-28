// The hand models through ONNX Runtime (P1). The ORT API lives only in
// hand_ort_ffi.cpp; this is what the rest of the engine sees. Runs in the
// live-input CHILD process, so a crash inside the runtime stops live input
// only, never the engine or the editor.
#pragma once

#include <cstdint>
#include <memory>
#include <span>
#include <string>
#include <vector>

namespace premation::live {

/// One output tensor of a run, as floats.
struct TensorOut {
  std::string name;
  std::vector<std::int64_t> shape;
  std::vector<float> data;
};

class Model {
 public:
  Model() = default;
  virtual ~Model() = default;
  Model(const Model&) = delete;
  Model& operator=(const Model&) = delete;
  Model(Model&&) = delete;
  Model& operator=(Model&&) = delete;

  /// True when the model takes NCHW (planar) input.
  [[nodiscard]] virtual bool planar() const noexcept = 0;
  /// The square input side the model declares (0 when dynamic).
  [[nodiscard]] virtual int input_side() const noexcept = 0;
  /// The execution provider in use (cpu, dml, coreml, cuda).
  [[nodiscard]] virtual std::string provider() const = 0;
  /// Inputs and outputs with their shapes, one line each (diagnostics).
  [[nodiscard]] virtual std::string describe() const = 0;
  /// One run; `out` holds every float output in the model's output order.
  virtual bool run(std::span<const float> input, std::vector<TensorOut>& out, std::string& error) = 0;
};

/// False when this engine build has no ONNX Runtime.
[[nodiscard]] bool runtime_available() noexcept;
/// `cpuOnly`: skip the GPU providers (small models can be faster on the CPU — no upload).
[[nodiscard]] std::unique_ptr<Model> load_model(const std::string& path, bool cpuOnly, std::string& error);

}  // namespace premation::live
