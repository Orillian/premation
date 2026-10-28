#include "gpu.hpp"

#include <array>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string_view>
#include <system_error>
#include <vector>

#include "engine_process.hpp"
#include "os_ffi.hpp"
#include "render_graph/device_limits.hpp"

namespace premation {
namespace {

// ── Dawn's blob cache on disk ────────────────────────────────────────────────
// Dawn hands every compiled shader (and, on D3D12, the pipeline state it
// built) to these callbacks keyed by a hash of the source, the toggles and the
// adapter; the next launch loads them instead of compiling. Without it every
// engine start recompiled every material the first frame used (FXC: tens of
// seconds for the fx-graph shaders, measured 2026-10-27). One file per key,
// named by a 64-bit FNV-1a of the key; written temp + rename, never over a
// file being read. Dawn calls these from its own threads: each call touches
// one file and nothing shared.
struct BlobCache {
  std::filesystem::path dir;

  [[nodiscard]] std::filesystem::path path_of(const void* key, std::size_t keySize) const {
    std::uint64_t h = 1469598103934665603ULL;
    const auto* p = static_cast<const std::uint8_t*>(key);
    for (std::size_t i = 0; i < keySize; ++i) {
      h ^= p[i];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      h *= 1099511628211ULL;
    }
    std::array<char, 24> name{};
    std::snprintf(name.data(), name.size(), "%016llx.bin", static_cast<unsigned long long>(h));
    return dir / name.data();
  }

  // Dawn's contract: the first call has `value` null and answers the size;
  // the second brings a buffer of that size.
  static std::size_t load(std::size_t keySize, const std::uint8_t* key, std::size_t valueSize, std::uint8_t* value,
                          void* userdata, void* /*userdata2*/) {
    const auto* self = static_cast<const BlobCache*>(userdata);
    if (self == nullptr || key == nullptr || keySize == 0) return 0;
    std::error_code ec;
    const std::filesystem::path p = self->path_of(key, keySize);
    const std::uintmax_t size = std::filesystem::file_size(p, ec);
    if (ec || size == 0 || size > (std::uintmax_t{64} << 20U)) return 0;
    if (value == nullptr) return static_cast<std::size_t>(size);  // the size query
    if (valueSize < size) return 0;
    std::ifstream in(p, std::ios::binary);
    if (!in.read(reinterpret_cast<char*>(value), static_cast<std::streamsize>(size))) return 0;  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
    return static_cast<std::size_t>(size);
  }

  static void store(std::size_t keySize, const std::uint8_t* key, std::size_t valueSize, const std::uint8_t* value,
                    void* userdata, void* /*userdata2*/) {
    const auto* self = static_cast<const BlobCache*>(userdata);
    if (self == nullptr || key == nullptr || keySize == 0 || value == nullptr || valueSize == 0) return;
    const std::filesystem::path p = self->path_of(key, keySize);
    std::error_code ec;
    if (std::filesystem::exists(p, ec)) return;
    const std::filesystem::path tmp = p.string() + ".tmp";
    {
      std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
      if (!out.write(reinterpret_cast<const char*>(value), static_cast<std::streamsize>(valueSize))) return;  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
    }
    std::filesystem::rename(tmp, p, ec);
    if (ec) std::filesystem::remove(tmp, ec);
  }
};

// One cache per process: Dawn keeps the userdata pointer for the device's life.
std::unique_ptr<BlobCache>& blob_cache() {
  static std::unique_ptr<BlobCache> cache;
  return cache;
}

std::string_view view(wgpu::StringView s) {
  if (s.data == nullptr) return {};
  return s.length == wgpu::kStrlen ? std::string_view(s.data) : std::string_view(s.data, s.length);
}

const char* backend_name(wgpu::BackendType t) {
  switch (t) {
    case wgpu::BackendType::D3D12: return "D3D12";
    case wgpu::BackendType::D3D11: return "D3D11";
    case wgpu::BackendType::Metal: return "Metal";
    case wgpu::BackendType::Vulkan: return "Vulkan";
    case wgpu::BackendType::OpenGL: return "OpenGL";
    case wgpu::BackendType::OpenGLES: return "OpenGLES";
    case wgpu::BackendType::Null: return "Null";
    default: return "unknown";
  }
}

wgpu::BackendType native_backend() {
#if defined(_WIN32)
  return wgpu::BackendType::D3D12;
#elif defined(__APPLE__)
  return wgpu::BackendType::Metal;
#else
  return wgpu::BackendType::Vulkan;
#endif
}

}  // namespace

std::optional<Gpu> create_gpu(bool wantSharedTexture, bool highPerformance, std::uint32_t vendorId,
                              std::string_view cacheDir) {
  Gpu gpu;

  static constexpr auto kTimedWaitAny = wgpu::InstanceFeatureName::TimedWaitAny;
  wgpu::InstanceDescriptor instanceDesc{};
  instanceDesc.requiredFeatureCount = 1;
  instanceDesc.requiredFeatures = &kTimedWaitAny;
  gpu.instance = wgpu::CreateInstance(&instanceDesc);
  if (gpu.instance == nullptr) {
    std::fprintf(stderr, "engine: wgpu::CreateInstance failed\n");
    return std::nullopt;
  }

  const auto request = [&gpu](wgpu::PowerPreference pref) {
    wgpu::Adapter found;
    wgpu::RequestAdapterOptions adapterOpts{};
    adapterOpts.backendType = native_backend();
    adapterOpts.powerPreference = pref;
    gpu.instance.WaitAny(
        gpu.instance.RequestAdapter(&adapterOpts, wgpu::CallbackMode::WaitAnyOnly,
                                    [&found](wgpu::RequestAdapterStatus status, wgpu::Adapter adapter,
                                             wgpu::StringView msg) {
                                      if (status == wgpu::RequestAdapterStatus::Success) {
                                        found = std::move(adapter);
                                      } else {
                                        std::fprintf(stderr, "engine: RequestAdapter: %.*s\n",
                                                     static_cast<int>(view(msg).size()), view(msg).data());
                                      }
                                    }),
        UINT64_MAX);
    return found;
  };
  const auto hi = wgpu::PowerPreference::HighPerformance;
  const auto lo = wgpu::PowerPreference::LowPower;
  gpu.adapter = request(highPerformance ? hi : lo);
  if (gpu.adapter == nullptr) return std::nullopt;

  wgpu::AdapterInfo info{};
  gpu.adapter.GetInfo(&info);
  if (vendorId != 0 && info.vendorID != vendorId) {
    // Chromium's GPU process is on the other adapter: shared handles and
    // cross-process presentation must stay on ONE device (route C crashes the
    // page's renderer otherwise — measured, docs/VIEWPORT_ROUTE.md).
    wgpu::Adapter other = request(highPerformance ? lo : hi);
    wgpu::AdapterInfo otherInfo{};
    if (other != nullptr) other.GetInfo(&otherInfo);
    if (other != nullptr && otherInfo.vendorID == vendorId) {
      gpu.adapter = std::move(other);
      info = std::move(otherInfo);
    } else {
      std::fprintf(stderr, "engine: no adapter with vendor 0x%04x; staying on 0x%04x\n", vendorId, info.vendorID);
    }
  }
  gpu.adapterName = std::string(view(info.device));
  gpu.backend = backend_name(info.backendType);

  std::vector<wgpu::FeatureName> features;
  // Route C (shared_texture_ffi*.cpp): the memory + fence pair of this OS.
  if (wantSharedTexture) {
#if defined(_WIN32)
    constexpr wgpu::FeatureName kSharedMemory = wgpu::FeatureName::SharedTextureMemoryDXGISharedHandle;
    constexpr wgpu::FeatureName kSharedFence = wgpu::FeatureName::SharedFenceDXGISharedHandle;
#elif defined(__APPLE__)
    constexpr wgpu::FeatureName kSharedMemory = wgpu::FeatureName::SharedTextureMemoryIOSurface;
    constexpr wgpu::FeatureName kSharedFence = wgpu::FeatureName::SharedFenceMTLSharedEvent;
#elif defined(PREMATION_DMABUF)
    // Linux with GBM (shared_texture_ffi_linux.cpp; unverified).
    constexpr wgpu::FeatureName kSharedMemory = wgpu::FeatureName::SharedTextureMemoryDmaBuf;
    constexpr wgpu::FeatureName kSharedFence = wgpu::FeatureName::SharedFenceSyncFD;
#endif
#if defined(_WIN32) || defined(__APPLE__) || defined(PREMATION_DMABUF)
    if (gpu.adapter.HasFeature(kSharedMemory) && gpu.adapter.HasFeature(kSharedFence)) {
      features.push_back(kSharedMemory);
      features.push_back(kSharedFence);
      gpu.sharedTextureCapable = true;
    }
#endif
  }
  // D2w: the render graph (float32 working space, rendering.ts's float32 path)
  // and E1's footage conversion (multi-planar NV12/P010 import, R16 planes) run
  // on this device when the adapter offers them; every one is optional.
  if (gpu.adapter.HasFeature(wgpu::FeatureName::Float32Filterable) &&
      gpu.adapter.HasFeature(wgpu::FeatureName::Float32Blendable)) {
    features.push_back(wgpu::FeatureName::Float32Filterable);
    features.push_back(wgpu::FeatureName::Float32Blendable);
    gpu.float32 = true;
  }
  for (const wgpu::FeatureName f : {wgpu::FeatureName::DawnMultiPlanarFormats, wgpu::FeatureName::MultiPlanarFormatP010,
                                    wgpu::FeatureName::Unorm16TextureFormats}) {
    if (gpu.adapter.HasFeature(f)) features.push_back(f);
  }

  // The 2D texture size the frame builder plans rasters against (device_limits.hpp).
  const wgpu::Limits limits = rg::required_device_limits(gpu.adapter);
  wgpu::DeviceDescriptor deviceDesc{};
  deviceDesc.requiredFeatureCount = features.size();
  deviceDesc.requiredFeatures = features.data();
  deviceDesc.requiredLimits = &limits;

  // Shader compilation. On D3D12 Dawn compiles HLSL with FXC unless told to use
  // DXC (dxcompiler.dll + dxil.dll ship next to the engine, scripts/stageEngine.cjs);
  // FXC took 10–60 s on the fx-graph and lumetri shaders (2026-10-27), DXC
  // seconds. Dawn drops the toggle itself where DXC is not loadable.
  // PREMATION_GPU_FXC=1 keeps FXC (a comparison, a driver bug).
  std::vector<const char*> enabledToggles;
#if defined(_WIN32)
  const std::optional<std::string> fxc = os::env_var("PREMATION_GPU_FXC");
  if (!fxc || *fxc != "1") enabledToggles.push_back("use_dxc");
#endif
  wgpu::DawnTogglesDescriptor toggles{};
  toggles.enabledToggleCount = enabledToggles.size();
  toggles.enabledToggles = enabledToggles.data();
  // The persistent blob cache (BlobCache above): isolated per engine version
  // and adapter, so a driver or engine update never serves a stale blob.
  // The C descriptor: the C++ wrapper keeps the callback slots protected and
  // its setters take wrapper functors; the C struct is the same bytes.
  WGPUDawnCacheDeviceDescriptor cache = WGPU_DAWN_CACHE_DEVICE_DESCRIPTOR_INIT;
  std::string isolationKey;
  if (!cacheDir.empty()) {
    std::error_code ec;
    std::filesystem::create_directories(std::filesystem::path(cacheDir), ec);
    if (!ec) {
      blob_cache() = std::make_unique<BlobCache>(BlobCache{std::filesystem::path(cacheDir)});
      isolationKey = std::string(kEngineVersion) + '|' + std::string(view(info.device)) + '|' +
                     std::string(view(info.description)) + '|' + std::to_string(info.vendorID) + ':' +
                     std::to_string(info.deviceID);
      cache.isolationKey = WGPUStringView{isolationKey.c_str(), isolationKey.size()};
      cache.dawnLoadCacheDataCallbackInfo.callback = &BlobCache::load;
      cache.dawnLoadCacheDataCallbackInfo.userdata1 = blob_cache().get();
      cache.dawnStoreCacheDataCallbackInfo.callback = &BlobCache::store;
      cache.dawnStoreCacheDataCallbackInfo.userdata1 = blob_cache().get();
    } else {
      std::fprintf(stderr, "engine: shader cache folder unusable (%s): %s\n", std::string(cacheDir).c_str(),
                   ec.message().c_str());
    }
  }
  // wgpu::ChainedStruct and WGPUChainedStruct are one layout (the wrapper's own static_asserts).
  toggles.nextInChain = blob_cache() ? reinterpret_cast<wgpu::ChainedStruct*>(&cache) : nullptr;  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  deviceDesc.nextInChain = &toggles;
  deviceDesc.SetUncapturedErrorCallback([](const wgpu::Device&, wgpu::ErrorType type, wgpu::StringView msg) {
    std::fprintf(stderr, "engine: GPU error %d: %.*s\n", static_cast<int>(type), static_cast<int>(view(msg).size()),
                 view(msg).data());
  });
  deviceDesc.SetDeviceLostCallback(wgpu::CallbackMode::AllowSpontaneous,
                                   [lost = gpu.lost](const wgpu::Device&, wgpu::DeviceLostReason reason, wgpu::StringView msg) {
                                     if (reason == wgpu::DeviceLostReason::Destroyed) return;
                                     lost->store(true);
                                     std::fprintf(stderr, "engine: device lost (%d): %.*s\n",
                                                  static_cast<int>(reason), static_cast<int>(view(msg).size()),
                                                  view(msg).data());
                                   });
  gpu.instance.WaitAny(gpu.adapter.RequestDevice(&deviceDesc, wgpu::CallbackMode::WaitAnyOnly,
                                                 [&gpu](wgpu::RequestDeviceStatus status, wgpu::Device device,
                                                        wgpu::StringView msg) {
                                                   if (status == wgpu::RequestDeviceStatus::Success) {
                                                     gpu.device = std::move(device);
                                                   } else {
                                                     std::fprintf(stderr, "engine: RequestDevice: %.*s\n",
                                                                  static_cast<int>(view(msg).size()),
                                                                  view(msg).data());
                                                   }
                                                 }),
                       UINT64_MAX);
  if (gpu.device == nullptr) return std::nullopt;
  gpu.queue = gpu.device.GetQueue();
  return gpu;
}

void wait_idle(const Gpu& gpu) {
  gpu.instance.WaitAny(gpu.queue.OnSubmittedWorkDone(wgpu::CallbackMode::WaitAnyOnly,
                                                     [](wgpu::QueueWorkDoneStatus, wgpu::StringView) {}),
                       UINT64_MAX);
}

}  // namespace premation
