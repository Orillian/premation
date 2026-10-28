#include "gpu_profiler.hpp"

#include <algorithm>
#include <cstring>
#include <utility>

namespace premation::rg {

void GpuProfiler::init(const wgpu::Device& device, const wgpu::Instance& instance) {
  if (!device.HasFeature(wgpu::FeatureName::TimestampQuery)) return;
  instance_ = instance;
  wgpu::QuerySetDescriptor qd{};
  qd.label = "gpu-profiler";
  qd.type = wgpu::QueryType::Timestamp;
  qd.count = kMaxPasses * 2;
  querySet_ = device.CreateQuerySet(&qd);
  const std::uint64_t bytes = std::uint64_t{kMaxPasses} * 2 * sizeof(std::uint64_t);
  wgpu::BufferDescriptor rd{};
  rd.label = "gpu-profiler-resolve";
  rd.size = bytes;
  rd.usage = wgpu::BufferUsage::QueryResolve | wgpu::BufferUsage::CopySrc;
  resolve_ = device.CreateBuffer(&rd);
  wgpu::BufferDescriptor bd{};
  bd.label = "gpu-profiler-readback";
  bd.size = bytes;
  bd.usage = wgpu::BufferUsage::MapRead | wgpu::BufferUsage::CopyDst;
  readback_ = device.CreateBuffer(&bd);
  writes_.querySet = querySet_;
  passScope_.reserve(kMaxPasses);
}

void GpuProfiler::begin_frame(std::uint64_t frame) {
  frame_ = frame;
  active_ = false;
  if (!supported()) return;
  poll();
  if (!armed_ || reading_) return;
  armed_ = false;
  active_ = true;
  sampleFrame_ = frame;
  passes_ = 0;
  untimed_ = 0;
  passScope_.clear();
  scopes_.clear();
  scopeIndex_.clear();
  scopes_.push_back({std::string(), GpuScopeCost::Kind::frame});
  scope_ = kFrameScope;
}

void GpuProfiler::poll() {
  if (!reading_) return;
  instance_.ProcessEvents();
  if (mapped_ || mapFailed_) collect();
}

void GpuProfiler::set_scope(std::string_view id, GpuScopeCost::Kind kind) {
  if (!active_) return;
  // Kind first: a layer and a 3D group starting with it are two scopes.
  std::string key(1, static_cast<char>('0' + static_cast<int>(kind)));
  key += id;
  auto [it, fresh] = scopeIndex_.try_emplace(std::move(key), static_cast<std::uint32_t>(scopes_.size()));
  if (fresh) scopes_.push_back({std::string(id), kind});
  scope_ = it->second;
}

const wgpu::PassTimestampWrites* GpuProfiler::pass_writes() {
  if (!active_) return nullptr;
  if (passes_ >= kMaxPasses) {
    ++untimed_;
    return nullptr;
  }
  writes_.beginningOfPassWriteIndex = passes_ * 2;
  writes_.endOfPassWriteIndex = passes_ * 2 + 1;
  passScope_.push_back(scope_);
  ++passes_;
  return &writes_;
}

void GpuProfiler::end_frame(const wgpu::CommandEncoder& encoder) {
  if (!active_) return;
  if (passes_ == 0) {
    active_ = false;
    return;
  }
  encoder.ResolveQuerySet(querySet_, 0, passes_ * 2, resolve_, 0);
  encoder.CopyBufferToBuffer(resolve_, 0, readback_, 0, std::uint64_t{passes_} * 2 * sizeof(std::uint64_t));
}

void GpuProfiler::after_submit() {
  if (!active_) return;
  active_ = false;
  reading_ = true;
  mapped_ = false;
  mapFailed_ = false;
  (void)readback_.MapAsync(wgpu::MapMode::Read, 0, std::uint64_t{passes_} * 2 * sizeof(std::uint64_t),
                           wgpu::CallbackMode::AllowProcessEvents, [this](wgpu::MapAsyncStatus s, wgpu::StringView) {
                             if (s == wgpu::MapAsyncStatus::Success) mapped_ = true;
                             else mapFailed_ = true;
                           });
}

void GpuProfiler::collect() {
  reading_ = false;
  if (!mapped_) return;  // the map failed (device lost, destroyed): no sample
  const std::uint64_t bytes = std::uint64_t{passes_} * 2 * sizeof(std::uint64_t);
  const void* data = readback_.GetConstMappedRange(0, bytes);
  if (data != nullptr) {
    std::vector<std::uint64_t> ts(std::size_t{passes_} * 2);
    std::memcpy(ts.data(), data, bytes);
    std::vector<GpuScopeCost> costs(scopes_.size());
    for (std::size_t i = 0; i < costs.size(); ++i) {
      costs[i].id = scopes_[i].id;
      costs[i].kind = scopes_[i].kind;
    }
    double total = 0;
    for (std::uint32_t p = 0; p < passes_; ++p) {
      const std::uint64_t a = ts[std::size_t{p} * 2];
      const std::uint64_t b = ts[(std::size_t{p} * 2) + 1];
      // WebGPU timestamps are nanoseconds; an implementation may quantize them, so end can equal begin.
      const double ms = b > a ? static_cast<double>(b - a) / 1e6 : 0.0;
      GpuScopeCost& c = costs[passScope_[p]];
      c.gpuMs += ms;
      ++c.passes;
      total += ms;
    }
    std::erase_if(costs, [](const GpuScopeCost& c) { return c.passes == 0; });
    // A Device frame that drew no layer (pipeline warm-up, a thumbnail of an
    // empty comp, a mip build) says nothing about the comp: kept armed for the
    // next one instead of replacing a real sample.
    const bool layers = std::ranges::any_of(costs, [](const GpuScopeCost& c) { return c.kind != GpuScopeCost::Kind::frame; });
    if (layers) {
      std::ranges::sort(costs, [](const GpuScopeCost& x, const GpuScopeCost& y) { return x.gpuMs > y.gpuMs; });
      last_ = GpuFrameProfile{std::move(costs), total, untimed_, sampleFrame_};
    } else {
      armed_ = true;
    }
  }
  readback_.Unmap();
  mapped_ = false;
}

}  // namespace premation::rg
