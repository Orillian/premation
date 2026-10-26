// Live camera capture on Windows: Media Foundation's source reader
// (camera.hpp). COM and MF never leave this file.
//
// Latency choices, in order of effect:
//   * an uncompressed sensor format (NV12 / YUY2) over MJPG — MJPG costs a
//     decode per frame before we see it;
//   * MF_LOW_LATENCY on the reader, so it does not queue frames;
//   * synchronous ReadSample on the caller's thread: the newest frame is
//     handed over as soon as it exists, nothing in between.
// The reader's video processor converts to RGB32 (BGRA in memory).
#include "camera.hpp"

#include <windows.h>

#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wrl/client.h>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstring>

namespace premation::live {

namespace {

using Microsoft::WRL::ComPtr;

std::string utf8(const wchar_t* w) {
  if (w == nullptr) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  if (n <= 1) return {};
  std::string s(static_cast<std::size_t>(n - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
  return s;
}

std::string hr_text(const char* what, HRESULT hr) {
  char buf[96];
  std::snprintf(buf, sizeof buf, "%s failed (0x%08lX)", what, static_cast<unsigned long>(hr));
  return buf;
}

/// MF started for the life of one object (MFStartup / MFShutdown are reference counted).
class MfScope {
 public:
  MfScope() {
    const HRESULT co = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    // S_FALSE: already initialised on this thread; RPC_E_CHANGED_MODE: an
    // apartment exists — MF works in either, so only a real failure counts.
    coOwned_ = SUCCEEDED(co);
    ok_ = SUCCEEDED(MFStartup(MF_VERSION, MFSTARTUP_LITE));
  }
  ~MfScope() {
    if (ok_) MFShutdown();
    if (coOwned_) CoUninitialize();
  }
  MfScope(const MfScope&) = delete;
  MfScope& operator=(const MfScope&) = delete;
  MfScope(MfScope&&) = delete;
  MfScope& operator=(MfScope&&) = delete;
  [[nodiscard]] bool ok() const noexcept { return ok_; }

 private:
  bool coOwned_ = false;
  bool ok_ = false;
};

/// The capture devices as IMFActivate objects, released together.
struct Devices {
  IMFActivate** list = nullptr;
  UINT32 count = 0;
  Devices() = default;
  ~Devices() {
    for (UINT32 i = 0; i < count; ++i) list[i]->Release();
    CoTaskMemFree(list);
  }
  Devices(const Devices&) = delete;
  Devices& operator=(const Devices&) = delete;
  Devices(Devices&&) = delete;
  Devices& operator=(Devices&&) = delete;
};

HRESULT enumerate(Devices& d) {
  ComPtr<IMFAttributes> attr;
  HRESULT hr = MFCreateAttributes(&attr, 1);
  if (FAILED(hr)) return hr;
  hr = attr->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
  if (FAILED(hr)) return hr;
  return MFEnumDeviceSources(attr.Get(), &d.list, &d.count);
}

std::string string_attr(IMFActivate* a, const GUID& key) {
  WCHAR* w = nullptr;
  UINT32 len = 0;
  if (FAILED(a->GetAllocatedString(key, &w, &len))) return {};
  std::string s = utf8(w);
  CoTaskMemFree(w);
  return s;
}

/// Infrared and depth sensors show up as cameras too; they are no use for hands.
bool not_a_colour_camera(const std::string& name) {
  std::string n = name;
  std::transform(n.begin(), n.end(), n.begin(), [](char c) { return static_cast<char>(std::tolower(static_cast<unsigned char>(c))); });
  return n.find(" ir ") != std::string::npos || n.find("ir camera") != std::string::npos || n.find("infrared") != std::string::npos ||
         n.find("depth") != std::string::npos;
}

std::string fourcc_name(const GUID& sub) {
  if (sub == MFVideoFormat_NV12) return "NV12";
  if (sub == MFVideoFormat_YUY2) return "YUY2";
  if (sub == MFVideoFormat_MJPG) return "MJPG";
  if (sub == MFVideoFormat_RGB32) return "RGB32";
  if (sub == MFVideoFormat_RGB24) return "RGB24";
  if (sub == MFVideoFormat_I420) return "I420";
  // FOURCC subtypes keep the code in Data1.
  char s[5] = {static_cast<char>(sub.Data1 & 0xFF), static_cast<char>((sub.Data1 >> 8) & 0xFF), static_cast<char>((sub.Data1 >> 16) & 0xFF),
               static_cast<char>((sub.Data1 >> 24) & 0xFF), 0};
  return s;
}

class MfCamera final : public Camera {
 public:
  bool open(const CameraRequest& req, std::string& error) {
    if (!mf_.ok()) {
      error = "Media Foundation is not available";
      return false;
    }
    Devices d;
    HRESULT hr = enumerate(d);
    if (FAILED(hr)) {
      error = hr_text("listing cameras", hr);
      return false;
    }
    IMFActivate* pick = nullptr;
    for (UINT32 i = 0; i < d.count && pick == nullptr; ++i) {
      const std::string id = string_attr(d.list[i], MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK);
      const std::string nm = string_attr(d.list[i], MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME);
      if (req.id.empty() ? !not_a_colour_camera(" " + nm + " ") : id == req.id) {
        pick = d.list[i];
        name_ = nm;
      }
    }
    if (pick == nullptr) {
      error = d.count == 0 ? "no camera is connected" : "that camera is not connected";
      return false;
    }
    // The IID by name: IID_PPV_ARGS expands to __uuidof, a language extension -Werror refuses.
    hr = pick->ActivateObject(IID_IMFMediaSource, reinterpret_cast<void**>(source_.ReleaseAndGetAddressOf()));
    if (FAILED(hr)) {
      // Windows ▸ Privacy ▸ Camera off, or another app holding it exclusively.
      error = hr == E_ACCESSDENIED ? "camera access is turned off for desktop apps (Windows Settings ▸ Privacy ▸ Camera)"
                                   : hr_text("opening the camera", hr);
      return false;
    }
    ComPtr<IMFAttributes> attr;
    MFCreateAttributes(&attr, 3);
    // Advanced processing: colour conversion AND scaling (the plain kind only converts).
    attr->SetUINT32(MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, TRUE);
    attr->SetUINT32(MF_LOW_LATENCY, TRUE);
    hr = MFCreateSourceReaderFromMediaSource(source_.Get(), attr.Get(), &reader_);
    if (FAILED(hr)) {
      error = hr_text("creating the camera reader", hr);
      return false;
    }
    if (!choose_format(req, error)) return false;
    // Scale down to the requested width (even sizes, aspect kept) in the
    // reader; if this driver's processor refuses, take the sensor size.
    if (req.width > 0 && req.width < width_) {
      const int w = req.width & ~1;
      const int h = static_cast<int>(std::lround(static_cast<double>(height_) * w / width_)) & ~1;
      if (set_output(w, h)) {
        width_ = w;
        height_ = h;
      } else if (!set_output(0, 0)) {
        error = "the camera cannot deliver RGB frames";
        return false;
      }
    } else if (!set_output(0, 0)) {
      error = "the camera cannot deliver RGB frames";
      return false;
    }
    ComPtr<IMFMediaType> cur;
    if (SUCCEEDED(reader_->GetCurrentMediaType(static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM), &cur))) {
      UINT32 s = 0;
      if (SUCCEEDED(cur->GetUINT32(MF_MT_DEFAULT_STRIDE, &s))) defaultStride_ = static_cast<LONG>(s);
    }
    return true;
  }

  ~MfCamera() override {
    reader_.Reset();
    if (source_) source_->Shutdown();
  }
  MfCamera() = default;
  MfCamera(const MfCamera&) = delete;
  MfCamera& operator=(const MfCamera&) = delete;
  MfCamera(MfCamera&&) = delete;
  MfCamera& operator=(MfCamera&&) = delete;

  bool read(CameraFrame& f, std::string& error) override {
    for (int attempt = 0; attempt < 64; ++attempt) {
      DWORD stream = 0;
      DWORD flags = 0;
      LONGLONG ts = 0;
      ComPtr<IMFSample> sample;
      const HRESULT hr = reader_->ReadSample(static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM), 0, &stream, &flags, &ts, &sample);
      if (FAILED(hr)) {
        error = hr_text("reading a camera frame", hr);
        return false;
      }
      if ((flags & MF_SOURCE_READERF_ERROR) != 0 || (flags & MF_SOURCE_READERF_ENDOFSTREAM) != 0) {
        error = "the camera stopped (disconnected, or taken by another app)";
        return false;
      }
      if (!sample) continue;  // a stream tick, no frame yet
      f.arrivalNs = now_ns();
      UINT64 device = 0;
      // The driver's capture time, QPC in 100 ns units (Windows 10+); absent on some drivers.
      f.captureNs = SUCCEEDED(sample->GetUINT64(MFSampleExtension_DeviceTimestamp, &device)) ? qpc100_to_ns(device) : 0;
      return copy(sample.Get(), f, error);
    }
    error = "the camera sent no frames";
    return false;
  }

  [[nodiscard]] int width() const noexcept override { return width_; }
  [[nodiscard]] int height() const noexcept override { return height_; }
  [[nodiscard]] double fps() const noexcept override { return fps_; }
  [[nodiscard]] std::string format() const override { return format_; }
  [[nodiscard]] std::string name() const override { return name_; }
  [[nodiscard]] std::vector<std::string> formats() const override { return formats_; }

 private:
  /// RGB32 out at w × h (0 × 0 = the sensor's size).
  bool set_output(int w, int h) {
    ComPtr<IMFMediaType> out;
    MFCreateMediaType(&out);
    out->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    out->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
    if (w > 0 && h > 0) MFSetAttributeSize(out.Get(), MF_MT_FRAME_SIZE, static_cast<UINT32>(w), static_cast<UINT32>(h));
    return SUCCEEDED(reader_->SetCurrentMediaType(static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM), nullptr, out.Get()));
  }

  /// The native type: the highest rate up to the request first (a frame not
  /// captured is latency we can never win back), uncompressed over MJPG at an
  /// equal rate (MJPG costs a decode per frame), then the width nearest the
  /// request (the reader scales the rest).
  bool choose_format(const CameraRequest& req, std::string& error) {
    ComPtr<IMFMediaType> best;
    double bestScore = -1e300;
    for (DWORD i = 0;; ++i) {
      ComPtr<IMFMediaType> t;
      const HRESULT hr = reader_->GetNativeMediaType(static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM), i, &t);
      if (hr == MF_E_NO_MORE_TYPES) break;
      if (FAILED(hr)) break;
      GUID sub{};
      t->GetGUID(MF_MT_SUBTYPE, &sub);
      UINT32 w = 0;
      UINT32 h = 0;
      MFGetAttributeSize(t.Get(), MF_MT_FRAME_SIZE, &w, &h);
      UINT32 num = 0;
      UINT32 den = 1;
      MFGetAttributeRatio(t.Get(), MF_MT_FRAME_RATE, &num, &den);
      if (w == 0 || h == 0 || den == 0) continue;
      const double rate = static_cast<double>(num) / den;
      char line[96];
      std::snprintf(line, sizeof line, "%s %ux%u @ %.2f", fourcc_name(sub).c_str(), w, h, rate);
      formats_.emplace_back(line);
      const double rateScore = rate <= req.fps + 0.5 ? rate : req.fps - (rate - req.fps);
      const double score = rateScore * 100.0 + (sub == MFVideoFormat_MJPG ? 0.0 : 50.0) -
                           std::abs(static_cast<double>(w) - req.width) / 100.0;
      if (score > bestScore) {
        bestScore = score;
        best = t;
        width_ = static_cast<int>(w);
        height_ = static_cast<int>(h);
        fps_ = rate;
        format_ = fourcc_name(sub);
      }
    }
    if (!best) {
      error = "the camera offers no video format";
      return false;
    }
    const HRESULT hr = reader_->SetCurrentMediaType(static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM), nullptr, best.Get());
    if (FAILED(hr)) {
      error = hr_text("choosing the camera format", hr);
      return false;
    }
    return true;
  }

  static std::int64_t qpc100_to_ns(UINT64 t) noexcept { return static_cast<std::int64_t>(t) * 100; }

  bool copy(IMFSample* sample, CameraFrame& f, std::string& error) {
    ComPtr<IMFMediaBuffer> buf;
    HRESULT hr = sample->ConvertToContiguousBuffer(&buf);
    if (FAILED(hr)) {
      error = hr_text("reading the frame buffer", hr);
      return false;
    }
    f.width = width_;
    f.height = height_;
    f.stride = width_ * 4;
    f.bgra.resize(static_cast<std::size_t>(f.stride) * static_cast<std::size_t>(height_));
    const auto rowBytes = static_cast<std::size_t>(f.stride);
    ComPtr<IMF2DBuffer> twoD;
    if (SUCCEEDED(buf.As(&twoD))) {
      BYTE* scan0 = nullptr;
      LONG pitch = 0;
      hr = twoD->Lock2D(&scan0, &pitch);
      if (FAILED(hr)) {
        error = hr_text("locking the frame", hr);
        return false;
      }
      // scan0 is the TOP row whatever the layout; pitch < 0 walks a bottom-up buffer upward.
      for (int y = 0; y < height_; ++y) {
        std::memcpy(f.bgra.data() + static_cast<std::size_t>(y) * rowBytes, scan0 + static_cast<std::ptrdiff_t>(y) * pitch, rowBytes);
      }
      twoD->Unlock2D();
    } else {
      BYTE* p = nullptr;
      DWORD max = 0;
      DWORD len = 0;
      hr = buf->Lock(&p, &max, &len);
      if (FAILED(hr)) {
        error = hr_text("locking the frame", hr);
        return false;
      }
      // RGB in MF defaults to bottom-up unless the type says otherwise.
      const LONG stride = defaultStride_ != 0 ? defaultStride_ : -static_cast<LONG>(rowBytes);
      const std::size_t need = rowBytes * static_cast<std::size_t>(height_);
      if (len < need) {
        buf->Unlock();
        error = "the frame is smaller than its format";
        return false;
      }
      const BYTE* top = stride < 0 ? p + static_cast<std::ptrdiff_t>(height_ - 1) * static_cast<std::ptrdiff_t>(rowBytes) : p;
      for (int y = 0; y < height_; ++y) {
        std::memcpy(f.bgra.data() + static_cast<std::size_t>(y) * rowBytes, top + static_cast<std::ptrdiff_t>(y) * stride, rowBytes);
      }
      buf->Unlock();
    }
    return true;
  }

  MfScope mf_;
  ComPtr<IMFMediaSource> source_;
  ComPtr<IMFSourceReader> reader_;
  int width_ = 0;
  int height_ = 0;
  double fps_ = 0;
  LONG defaultStride_ = 0;
  std::string format_;
  std::string name_;
  std::vector<std::string> formats_;
};

}  // namespace

std::vector<CameraDevice> list_cameras(std::string& error) {
  MfScope mf;
  std::vector<CameraDevice> out;
  if (!mf.ok()) {
    error = "Media Foundation is not available";
    return out;
  }
  Devices d;
  const HRESULT hr = enumerate(d);
  if (FAILED(hr)) {
    error = hr_text("listing cameras", hr);
    return out;
  }
  for (UINT32 i = 0; i < d.count; ++i) {
    out.push_back({string_attr(d.list[i], MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK),
                   string_attr(d.list[i], MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME)});
  }
  return out;
}

std::unique_ptr<Camera> open_camera(const CameraRequest& request, std::string& error) {
  auto cam = std::make_unique<MfCamera>();
  if (!cam->open(request, error)) return nullptr;
  return cam;
}

std::string env_utf8(const char* name) {
  std::wstring w;
  for (const char* p = name; *p != '\0'; ++p) w.push_back(static_cast<wchar_t>(static_cast<unsigned char>(*p)));
  const DWORD n = GetEnvironmentVariableW(w.c_str(), nullptr, 0);
  if (n == 0) return {};
  std::wstring v(n, L'\0');
  const DWORD got = GetEnvironmentVariableW(w.c_str(), v.data(), n);
  v.resize(got);
  return utf8(v.c_str());
}

std::int64_t now_ns() noexcept {
  static const LONGLONG freq = [] {
    LARGE_INTEGER f;
    QueryPerformanceFrequency(&f);
    return f.QuadPart;
  }();
  LARGE_INTEGER c;
  QueryPerformanceCounter(&c);
  // Split to keep the multiply in range for a machine that has been up for weeks.
  const LONGLONG whole = c.QuadPart / freq;
  const LONGLONG rest = c.QuadPart % freq;
  return static_cast<std::int64_t>(whole) * 1'000'000'000 + static_cast<std::int64_t>(rest * 1'000'000'000 / freq);
}

}  // namespace premation::live
