// Image codecs for still footage (image_decode.hpp). FFI lives here only:
// WIC on Windows, Skia's codecs elsewhere.
#include "image_decode.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <limits>
#include <optional>
#include <string_view>
#include <vector>

#include "hdr_read.hpp"
#include "media_paths.hpp"

#ifdef _WIN32
#include <windows.h>
#include <wincodec.h>
#include <wrl/client.h>
#else
#include <system_error>

#include "include/codec/SkBmpDecoder.h"
#include "include/codec/SkCodec.h"
#include "include/codec/SkGifDecoder.h"
#include "include/codec/SkJpegDecoder.h"
#include "include/codec/SkPngDecoder.h"
#include "include/codec/SkWebpDecoder.h"
#include "include/core/SkData.h"
#include "include/core/SkImageInfo.h"
#endif

namespace premation::scene {

bool is_still_image_path(const std::filesystem::path& p) {
  std::string ext = p.extension().string();
  std::ranges::transform(ext, ext.begin(), [](char c) { return c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c; });
  for (const std::string_view e : {".png", ".jpg", ".jpeg", ".jpe", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".hdr"}) {
    if (ext == e) return true;
  }
  return false;
}

namespace {

/// E7: a Radiance .hdr still — not a codec of WIC's or Skia's: decoded here
/// (hdr_read.hpp, pure C++) to linear float, and tone-mapped for the 8-bit
/// raster the way the EXR import's preview is: clamped to [0, 1] and sRGB
/// encoded, opaque. The environment sky reads the linear planes from the file
/// itself (env_asset.cpp), never this preview.
bool hdr_path(const std::filesystem::path& p) {
  std::string ext = p.extension().string();
  std::ranges::transform(ext, ext.begin(), [](char c) { return c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c; });
  return ext == ".hdr";
}

bool decode_hdr_still(std::span<const std::uint8_t> bytes, DecodedImage& out, std::string& error) {
  const std::optional<hdr::FloatRgba> img = hdr::decode(bytes, error);
  if (!img) return false;
  const auto encode = [](float v) {
    const double c = std::clamp(static_cast<double>(v), 0.0, 1.0);
    const double s = c <= 0.0031308 ? c * 12.92 : 1.055 * std::pow(c, 1.0 / 2.4) - 0.055;
    return static_cast<std::uint8_t>(std::lround(std::clamp(s, 0.0, 1.0) * 255.0));
  };
  out.width = static_cast<std::uint32_t>(img->width);
  out.height = static_cast<std::uint32_t>(img->height);
  out.rgba.resize(img->rgba.size());
  for (std::size_t i = 0; i + 3 < img->rgba.size(); i += 4) {
    out.rgba[i] = encode(img->rgba[i]);
    out.rgba[i + 1] = encode(img->rgba[i + 1]);
    out.rgba[i + 2] = encode(img->rgba[i + 2]);
    out.rgba[i + 3] = 255;
  }
  return true;
}

bool decode_hdr_file(const std::filesystem::path& p, DecodedImage& out, std::string& error) {
  std::ifstream in(p, std::ios::binary);
  if (!in) {
    error = "open " + utf8_path(p) + " failed";
    return false;
  }
  const std::vector<std::uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  return decode_hdr_still(bytes, out, error);
}

}  // namespace

#ifdef _WIN32

FileStamp file_stamp(const std::filesystem::path& p) {
  WIN32_FILE_ATTRIBUTE_DATA a{};
  if (GetFileAttributesExW(p.wstring().c_str(), GetFileExInfoStandard, &a) == 0) return {};
  FileStamp s;
  s.size = (static_cast<std::uint64_t>(a.nFileSizeHigh) << 32U) | a.nFileSizeLow;
  s.modified = (static_cast<std::uint64_t>(a.ftLastWriteTime.dwHighDateTime) << 32U) | a.ftLastWriteTime.dwLowDateTime;
  return s;
}

namespace {

using Microsoft::WRL::ComPtr;

/// COM on this thread for the duration of a decode (balanced; a thread that
/// already chose the other apartment keeps it and is left alone).
class ComScope {
 public:
  ComScope() : hr_(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) {}
  ~ComScope() {
    if (SUCCEEDED(hr_)) CoUninitialize();
  }
  ComScope(const ComScope&) = delete;
  ComScope& operator=(const ComScope&) = delete;
  ComScope(ComScope&&) = delete;
  ComScope& operator=(ComScope&&) = delete;
  [[nodiscard]] bool usable() const noexcept { return SUCCEEDED(hr_) || hr_ == RPC_E_CHANGED_MODE; }

 private:
  HRESULT hr_;
};

std::string hr_text(std::string_view what, HRESULT hr) {
  std::array<char, 16> buf{};
  std::snprintf(buf.data(), buf.size(), "%08lx", static_cast<unsigned long>(hr));  // NOLINT(cppcoreguidelines-pro-type-vararg)
  std::string out(what);
  out += " failed (0x";
  out += buf.data();
  out += ')';
  return out;
}

}  // namespace

namespace {
bool decode_frame(IWICBitmapDecoder* decoder, DecodedImage& out, std::string& error);
}  // namespace

bool decode_image_file(const std::filesystem::path& p, DecodedImage& out, std::string& error) {
  if (hdr_path(p)) return decode_hdr_file(p, out, error);  // E7
  const ComScope com;
  if (!com.usable()) {
    error = "COM unavailable";
    return false;
  }
  ComPtr<IWICImagingFactory> factory;
  HRESULT hr = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_IWICImagingFactory,
                                reinterpret_cast<void**>(factory.GetAddressOf()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): COM out-param
  if (FAILED(hr)) {
    error = hr_text("WIC factory", hr);
    return false;
  }
  ComPtr<IWICBitmapDecoder> decoder;
  hr = factory->CreateDecoderFromFilename(p.wstring().c_str(), nullptr, GENERIC_READ, WICDecodeMetadataCacheOnDemand,
                                          &decoder);
  if (FAILED(hr)) {
    error = hr_text("open " + utf8_path(p), hr);
    return false;
  }
  return decode_frame(decoder.Get(), out, error);
}

bool decode_image_bytes(std::span<const std::uint8_t> bytes, DecodedImage& out, std::string& error) {
  if (hdr::looks_like_hdr(bytes)) return decode_hdr_still(bytes, out, error);  // E7
  const ComScope com;
  if (!com.usable()) {
    error = "COM unavailable";
    return false;
  }
  if (bytes.empty() || bytes.size() > (std::numeric_limits<DWORD>::max)()) {
    error = "image bytes unusable";
    return false;
  }
  ComPtr<IWICImagingFactory> factory;
  HRESULT hr = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_IWICImagingFactory,
                                reinterpret_cast<void**>(factory.GetAddressOf()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): COM out-param
  if (FAILED(hr)) {
    error = hr_text("WIC factory", hr);
    return false;
  }
  ComPtr<IWICStream> stream;
  hr = factory->CreateStream(&stream);
  if (SUCCEEDED(hr)) {
    // WIC reads the buffer in place (it never writes through this pointer).
    hr = stream->InitializeFromMemory(const_cast<BYTE*>(bytes.data()), static_cast<DWORD>(bytes.size()));  // NOLINT(cppcoreguidelines-pro-type-const-cast)
  }
  if (FAILED(hr)) {
    error = hr_text("memory stream", hr);
    return false;
  }
  ComPtr<IWICBitmapDecoder> decoder;
  hr = factory->CreateDecoderFromStream(stream.Get(), nullptr, WICDecodeMetadataCacheOnLoad, &decoder);
  if (FAILED(hr)) {
    error = hr_text("decode", hr);
    return false;
  }
  return decode_frame(decoder.Get(), out, error);
}

namespace {

bool decode_frame(IWICBitmapDecoder* decoder, DecodedImage& out, std::string& error) {
  ComPtr<IWICBitmapFrameDecode> frame;
  HRESULT hr = decoder->GetFrame(0, &frame);
  if (FAILED(hr)) {
    error = hr_text("first frame", hr);
    return false;
  }
  // Straight (non-premultiplied) RGBA8: the file's channels as stored.
  ComPtr<IWICBitmapSource> rgba;
  hr = WICConvertBitmapSource(GUID_WICPixelFormat32bppRGBA, frame.Get(), &rgba);
  if (FAILED(hr)) {
    error = hr_text("convert to RGBA", hr);
    return false;
  }
  UINT w = 0;
  UINT h = 0;
  hr = rgba->GetSize(&w, &h);
  constexpr UINT kMaxSide = 32768;
  if (FAILED(hr) || w == 0 || h == 0 || w > kMaxSide || h > kMaxSide) {
    error = "image size unusable";
    return false;
  }
  const std::size_t stride = static_cast<std::size_t>(w) * 4U;
  const std::size_t size = stride * h;
  if (size > (std::numeric_limits<UINT>::max)()) {  // parenthesised: windows.h's max macro
    error = "image too large";
    return false;
  }
  out.width = w;
  out.height = h;
  out.rgba.assign(size, 0);
  hr = rgba->CopyPixels(nullptr, static_cast<UINT>(stride), static_cast<UINT>(size), out.rgba.data());
  if (FAILED(hr)) {
    error = hr_text("decode pixels", hr);
    out.rgba.clear();
    return false;
  }
  return true;
}

}  // namespace

#else

FileStamp file_stamp(const std::filesystem::path& p) {
  std::error_code ec;
  const auto size = std::filesystem::file_size(p, ec);
  if (ec) return {};
  const auto when = std::filesystem::last_write_time(p, ec);
  if (ec) return {};
  FileStamp s;
  s.size = static_cast<std::uint64_t>(size);
  s.modified = static_cast<std::uint64_t>(when.time_since_epoch().count());
  return s;
}

namespace {

/// The first frame as straight RGBA8, the file's channels unconverted — what
/// the WIC path hands over (no colour space on the destination: no conversion).
bool decode_data(sk_sp<SkData> data, DecodedImage& out, std::string& error) {
  if (!data || data->size() == 0) {
    error = "image bytes unusable";
    return false;
  }
  const std::array<SkCodecs::Decoder, 5> decoders = {SkPngDecoder::Decoder(), SkJpegDecoder::Decoder(),
                                                     SkWebpDecoder::Decoder(), SkGifDecoder::Decoder(),
                                                     SkBmpDecoder::Decoder()};
  const std::unique_ptr<SkCodec> codec = SkCodec::MakeFromData(std::move(data), decoders);
  if (!codec) {
    error = "unsupported image format";
    return false;
  }
  const SkISize d = codec->dimensions();
  constexpr int kMaxSide = 32768;
  if (d.width() <= 0 || d.height() <= 0 || d.width() > kMaxSide || d.height() > kMaxSide) {
    error = "image size unusable";
    return false;
  }
  const SkImageInfo info = SkImageInfo::Make(d, kRGBA_8888_SkColorType, kUnpremul_SkAlphaType);
  const std::size_t stride = static_cast<std::size_t>(d.width()) * 4U;
  out.width = static_cast<std::uint32_t>(d.width());
  out.height = static_cast<std::uint32_t>(d.height());
  out.rgba.assign(stride * static_cast<std::size_t>(d.height()), 0);
  const SkCodec::Result r = codec->getPixels(info, out.rgba.data(), stride);
  // A truncated file keeps the rows that decoded (the rest stays transparent).
  if (r != SkCodec::kSuccess && r != SkCodec::kIncompleteInput) {
    error = std::string("decode pixels failed (") + SkCodec::ResultToString(r) + ")";
    out.rgba.clear();
    return false;
  }
  return true;
}

}  // namespace

bool decode_image_file(const std::filesystem::path& p, DecodedImage& out, std::string& error) {
  if (hdr_path(p)) return decode_hdr_file(p, out, error);  // E7
  sk_sp<SkData> data = SkData::MakeFromFileName(utf8_path(p).c_str());
  if (!data) {
    error = "open " + utf8_path(p) + " failed";
    return false;
  }
  return decode_data(std::move(data), out, error);
}

bool decode_image_bytes(std::span<const std::uint8_t> bytes, DecodedImage& out, std::string& error) {
  if (bytes.empty()) {
    error = "image bytes unusable";
    return false;
  }
  if (hdr::looks_like_hdr(bytes)) return decode_hdr_still(bytes, out, error);  // E7
  return decode_data(SkData::MakeWithCopy(bytes.data(), bytes.size()), out, error);
}

#endif

}  // namespace premation::scene
