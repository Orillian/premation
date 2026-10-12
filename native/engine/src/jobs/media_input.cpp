#include "media_input.hpp"

#include <algorithm>
#include <array>
#include <cmath>

#include "native_contrib.hpp"

namespace premation::jobs {

RgbaImage box_downscale(RgbaImage img, std::uint32_t maxEdge) {
  const std::uint32_t srcW = img.width;
  const std::uint32_t srcH = img.height;
  const std::uint32_t edge = std::max(srcW, srcH);
  if (maxEdge == 0 || edge <= maxEdge || img.empty()) return img;
  const double k = static_cast<double>(maxEdge) / edge;
  RgbaImage out;
  out.width = std::max(1U, static_cast<std::uint32_t>(std::lround(srcW * k)));
  out.height = std::max(1U, static_cast<std::uint32_t>(std::lround(srcH * k)));
  out.rgba.assign(static_cast<std::size_t>(out.width) * out.height * 4U, 0);
  for (std::uint32_t y = 0; y < out.height; ++y) {
    const auto y0 = static_cast<std::uint32_t>(static_cast<std::uint64_t>(y) * srcH / out.height);
    const std::uint32_t y1 = std::max(y0 + 1, static_cast<std::uint32_t>(static_cast<std::uint64_t>(y + 1) * srcH / out.height));
    for (std::uint32_t x = 0; x < out.width; ++x) {
      const auto x0 = static_cast<std::uint32_t>(static_cast<std::uint64_t>(x) * srcW / out.width);
      const std::uint32_t x1 = std::max(x0 + 1, static_cast<std::uint32_t>(static_cast<std::uint64_t>(x + 1) * srcW / out.width));
      std::array<std::uint64_t, 4> sum{};
      for (std::uint32_t sy = y0; sy < y1; ++sy) {
        for (std::uint32_t sx = x0; sx < x1; ++sx) {
          const std::size_t i = (static_cast<std::size_t>(sy) * srcW + sx) * 4U;
          for (std::size_t c = 0; c < 4; ++c) sum.at(c) += img.rgba[i + c];
        }
      }
      const std::uint64_t n = static_cast<std::uint64_t>(y1 - y0) * (x1 - x0);
      const std::size_t o = (static_cast<std::size_t>(y) * out.width + x) * 4U;
      for (std::size_t c = 0; c < 4; ++c) out.rgba[o + c] = static_cast<std::uint8_t>((sum.at(c) + n / 2) / n);
    }
  }
  return out;
}

namespace {

/// Footage a native plugin imports (P7b): every frame through its importer
/// (doc::NativeImporters — the plugin host's guarded READ_FRAME), as the
/// viewer reads it. Moving footage numbers its frames at the probed rate; a
/// still is one frame.
class PluginFrames final : public FrameSource {
 public:
  bool open(const std::string& path, std::uint32_t maxEdge, std::string& error) {
    path_ = path;
    maxEdge_ = maxEdge;
    js::Json facts;
    if (!doc::NativeImporters::probe(path, facts, error)) return false;
    const js::Json& md = facts.at("metadata");
    const double w = md.at("width").is_number() ? md.at("width").num() : 0;
    const double h = md.at("height").is_number() ? md.at("height").num() : 0;
    if (!(w >= 1) || !(h >= 1)) {
      error = "'" + path + "' has no picture";
      return false;
    }
    srcW_ = static_cast<std::uint32_t>(w);
    srcH_ = static_cast<std::uint32_t>(h);
    const double k = maxEdge == 0 || std::max(srcW_, srcH_) <= maxEdge ? 1.0 : static_cast<double>(maxEdge) / std::max(srcW_, srcH_);
    outW_ = std::max(1U, static_cast<std::uint32_t>(std::lround(srcW_ * k)));
    outH_ = std::max(1U, static_cast<std::uint32_t>(std::lround(srcH_ * k)));
    const double fps = md.at("fps").is_number() ? md.at("fps").num() : 0;
    const double duration = md.at("duration").is_number() ? md.at("duration").num() : 0;
    if (fps > 0 && duration > 0) {
      fps_ = fps;
      count_ = std::max<std::int64_t>(1, std::llround(duration * fps));
    }
    return true;
  }
  [[nodiscard]] std::uint32_t width() const noexcept override { return outW_; }
  [[nodiscard]] std::uint32_t height() const noexcept override { return outH_; }
  [[nodiscard]] std::uint32_t source_width() const noexcept override { return srcW_; }
  [[nodiscard]] std::uint32_t source_height() const noexcept override { return srcH_; }
  [[nodiscard]] double fps() const noexcept override { return fps_; }
  [[nodiscard]] std::int64_t frame_count() const noexcept override { return count_; }
  bool read(std::int64_t frame, RgbaImage& out, std::string& error) override {
    // Frame n's source time, +1 µs so a reader that floors time × rate lands on n.
    const double seconds = count_ > 1 ? static_cast<double>(std::clamp<std::int64_t>(frame, 0, count_ - 1)) / fps_ + 1e-6 : 0.0;
    doc::NativeImage img;
    if (!doc::NativeImporters::read_frame(path_, seconds, img, error)) {
      error = "plugin failed to read '" + path_ + "': " + error;
      return false;
    }
    if (img.width != srcW_ || img.height != srcH_ || img.rgba.size() != static_cast<std::size_t>(srcW_) * srcH_ * 4U) {
      error = "plugin failed to read '" + path_ + "': the frame does not match the probed size";
      return false;
    }
    RgbaImage full;
    full.width = srcW_;
    full.height = srcH_;
    full.rgba.resize(img.rgba.size());
    for (std::size_t i = 0; i < img.rgba.size(); ++i) {
      double v = std::clamp(static_cast<double>(img.rgba[i]), 0.0, 1.0);
      // Scene-linear files are encoded to sRGB, as the viewer shows them; alpha stays linear.
      if (img.linear && i % 4 != 3) v = v <= 0.0031308 ? v * 12.92 : 1.055 * std::pow(v, 1 / 2.4) - 0.055;
      full.rgba[i] = static_cast<std::uint8_t>(std::lround(v * 255));
    }
    out = box_downscale(std::move(full), maxEdge_);
    return true;
  }

 private:
  std::string path_;
  std::uint32_t maxEdge_ = 0;
  std::uint32_t srcW_ = 0, srcH_ = 0, outW_ = 0, outH_ = 0;
  double fps_ = 30;
  std::int64_t count_ = 1;
};

}  // namespace

std::unique_ptr<FrameSource> open_plugin_frames(const std::string& path, std::uint32_t maxEdge, std::string& error) {
  if (!doc::NativeImporters::claims(path)) {
    // A listed importer whose plugin does not run (disabled, revoked, locked, …): the job fails
    // with why, rather than reading the file through a decoder the footage was not imported with.
    if (std::string why = doc::NativeImporters::refusal(path); !why.empty()) error = "plugin failed to read '" + path + "': " + why;
    return nullptr;
  }
  auto f = std::make_unique<PluginFrames>();
  if (!f->open(path, maxEdge, error)) {
    if (error.find("plugin failed to read") == std::string::npos) error = "plugin failed to read '" + path + "': " + error;
    return nullptr;
  }
  return f;
}

LumaImage luma_from_rgba(const RgbaImage& img) {
  LumaImage out;
  out.width = img.width;
  out.height = img.height;
  const std::size_t n = static_cast<std::size_t>(img.width) * img.height;
  out.data.resize(n);
  for (std::size_t i = 0, p = 0; i < n; ++i, p += 4) {
    const double y = (0.299 * img.rgba[p] + 0.587 * img.rgba[p + 1] + 0.114 * img.rgba[p + 2]) / 255;
    out.data[i] = static_cast<float>(y);
  }
  return out;
}

std::vector<float> mono_of(const AudioPcm& pcm) {
  // audioDriver.ts mixToMono: sum in float32 storage, divide in double, stored as float32.
  const std::size_t n = pcm.frames();
  std::vector<float> mono(n, 0.0F);
  if (pcm.channels.empty()) return mono;
  for (const auto& ch : pcm.channels) {
    for (std::size_t i = 0; i < n && i < ch.size(); ++i) {
      mono[i] = static_cast<float>(static_cast<double>(mono[i]) + static_cast<double>(ch[i]));
    }
  }
  if (pcm.channels.size() > 1) {
    const auto k = static_cast<double>(pcm.channels.size());
    for (float& v : mono) v = static_cast<float>(static_cast<double>(v) / k);
  }
  return mono;
}

}  // namespace premation::jobs
