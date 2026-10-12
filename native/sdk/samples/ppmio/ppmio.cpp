// Sample: PPM / PFM footage — an IMPORTER plugin (SDK 1.2, pr_io.h): AE's
// AEIO class. Binary PPM (P6, 8- or 16-bit) and PFM (PF colour / Pf grey,
// 32-bit float, scene-linear, rows stored bottom-up) import as still footage.
// A PPM holding several images back to back (Netpbm allows that) is MOVING
// footage, one image per frame, at 30 fps or the rate a `# fps <n>` comment
// in the first header names.
//
//   PROBE       the header(s): size, depth, linear (PFM), frame count and rate
//   OPEN        reads the whole file into a host handle (the file's state)
//   READ_FRAME  converts the frame at `time` into the host's world (RGBA8 / RGBA16 / RGBA32F)
//   CLOSE       frees the handle
//
// A second importer, `praw` (.praw, "Premation raw audio"), is SOUND only:
// a text line `PRAW <sample rate> <channels>` then interleaved little-endian
// float32 samples. It shows READ_AUDIO: the item plays in the mix and exports
// like any audio file.
//
// Fault injection (docs/PLUGIN_SDK.md "Crash isolation"): a file whose name
// contains "crash" faults in READ_FRAME (access violation); one containing
// "broken" fails PROBE with an error. The engine then fails just that footage.
#include <premation_sdk/premation_sdk.h>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace {

struct Header {
  int kind = 0;  ///< 6 = P6, 'F' = PF (RGB float), 'f' = Pf (grey float)
  int width = 0, height = 0;
  int maxval = 255;   ///< P6
  float scale = 1;    ///< PFM: < 0 = little-endian
  std::size_t data = 0;  ///< offset of the pixels
  std::size_t end = 0;   ///< offset just past the pixels (the next image of a moving PPM starts here)
};

constexpr double kTimeScale = static_cast<double>(PR_TIME_SCALE);

bool read_file(const char* path, std::vector<unsigned char>& out) {
  std::FILE* f = nullptr;
#if defined(_WIN32)
  // The path is UTF-8: open it as wide characters.
  std::wstring w;
  const std::string_view s(path);
  for (std::size_t i = 0; i < s.size();) {
    unsigned cp = static_cast<unsigned char>(s[i]);
    int extra = cp < 0x80 ? 0 : cp < 0xE0 ? 1 : cp < 0xF0 ? 2 : 3;
    cp &= extra == 0 ? 0x7FU : extra == 1 ? 0x1FU : extra == 2 ? 0x0FU : 0x07U;
    ++i;
    for (; extra > 0 && i < s.size(); --extra, ++i) cp = (cp << 6U) | (static_cast<unsigned char>(s[i]) & 0x3FU);
    if (cp >= 0x10000) {
      cp -= 0x10000;
      w.push_back(static_cast<wchar_t>(0xD800 + (cp >> 10U)));
      w.push_back(static_cast<wchar_t>(0xDC00 + (cp & 0x3FFU)));
    } else {
      w.push_back(static_cast<wchar_t>(cp));
    }
  }
  if (_wfopen_s(&f, w.c_str(), L"rb") != 0) f = nullptr;
#else
  f = std::fopen(path, "rb");
#endif
  if (f == nullptr) return false;
  unsigned char buf[65536];
  std::size_t n = 0;
  while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) out.insert(out.end(), buf, buf + n);
  std::fclose(f);
  return true;
}

/// The next whitespace-separated token of a PNM header (skipping # comments).
bool token(const std::vector<unsigned char>& b, std::size_t& i, std::string& out) {
  out.clear();
  for (;;) {
    while (i < b.size() && std::isspace(b[i]) != 0) ++i;
    if (i < b.size() && b[i] == '#') {
      while (i < b.size() && b[i] != '\n') ++i;
      continue;
    }
    break;
  }
  while (i < b.size() && std::isspace(b[i]) == 0 && out.size() < 32) out.push_back(static_cast<char>(b[i++]));
  return !out.empty();
}

/// The header of the image starting at byte `start`.
bool parse_header(const std::vector<unsigned char>& b, std::size_t start, Header& h, std::string& why) {
  std::size_t i = start;
  std::string t;
  if (!token(b, i, t)) return why = "empty file", false;
  if (t == "P6") h.kind = 6;
  else if (t == "PF") h.kind = 'F';
  else if (t == "Pf") h.kind = 'f';
  else return why = "not a binary PPM (P6) or PFM (PF / Pf) file", false;
  std::string ws, hs, ms;
  if (!token(b, i, ws) || !token(b, i, hs) || !token(b, i, ms)) return why = "truncated header", false;
  h.width = std::atoi(ws.c_str());
  h.height = std::atoi(hs.c_str());
  if (h.width <= 0 || h.height <= 0 || h.width > 16384 || h.height > 16384) return why = "bad size", false;
  if (h.kind == 6) {
    h.maxval = std::atoi(ms.c_str());
    if (h.maxval <= 0 || h.maxval > 65535) return why = "bad maxval", false;
  } else {
    h.scale = static_cast<float>(std::atof(ms.c_str()));
    if (h.scale == 0 || !std::isfinite(h.scale)) return why = "bad scale", false;
  }
  h.data = i + 1;  // exactly one whitespace byte after the last header token
  const std::size_t channels = h.kind == 'f' ? 1 : 3;
  const std::size_t bytes = h.kind == 6 ? (h.maxval > 255 ? 2 : 1) : 4;
  const std::size_t need = static_cast<std::size_t>(h.width) * static_cast<std::size_t>(h.height) * channels * bytes;
  if (b.size() < h.data + need) return why = "truncated pixels", false;
  h.end = h.data + need;
  return true;
}

/// Every image of the file (a moving PPM: P6 images back to back, all the same size and depth)
/// and the rate: 30 fps unless the first header carries a `# fps <n>` comment.
bool scan_frames(const std::vector<unsigned char>& b, std::vector<Header>& frames, double& fps, std::string& why) {
  frames.clear();
  Header first;
  if (!parse_header(b, 0, first, why)) return false;
  frames.push_back(first);
  fps = 30;
  const std::string head(b.begin(), b.begin() + static_cast<std::ptrdiff_t>(first.data));
  if (const std::size_t at = head.find("# fps "); at != std::string::npos) {
    const double v = std::atof(head.c_str() + at + 6);
    if (v > 0 && v <= 1000) fps = v;
  }
  if (first.kind != 6) return true;  // PFM: one image
  for (std::size_t at = first.end; frames.size() < 100000;) {
    while (at < b.size() && std::isspace(b[at]) != 0) ++at;
    if (at >= b.size()) break;
    Header next;
    if (!parse_header(b, at, next, why)) return false;
    if (next.kind != first.kind || next.width != first.width || next.height != first.height || next.maxval != first.maxval) {
      return why = "frame " + std::to_string(frames.size()) + " differs in size or depth from the first", false;
    }
    frames.push_back(next);
    at = next.end;
  }
  return true;
}

void fail(PrImportCall* c, const std::string& why) { std::snprintf(c->return_msg, sizeof(c->return_msg), "%s", why.c_str()); }

PrErr probe(PrImportCall* c) {
  const std::string name(c->path);
  if (name.find("broken") != std::string::npos) return fail(c, "injected error: a broken file"), PR_ERR_INVALID_PARAM;
  std::vector<unsigned char> b;
  if (!read_file(c->path, b)) return fail(c, "the file cannot be opened"), PR_ERR_NOT_FOUND;
  std::vector<Header> frames;
  double fps = 30;
  std::string why;
  if (!scan_frames(b, frames, fps, why)) return fail(c, why), PR_ERR_INVALID_PARAM;
  const Header& h = frames.front();
  PrImportInfo* info = c->info;
  info->width = h.width;
  info->height = h.height;
  const bool moving = frames.size() > 1;
  info->frame_rate = moving ? fps : 0;  // one image: a still
  info->duration = moving ? static_cast<int64_t>(std::llround(static_cast<double>(frames.size()) / fps * kTimeScale)) : 0;
  info->has_alpha = 0;
  info->linear = h.kind == 6 ? 0 : 1;
  info->pixel_format = h.kind == 6 ? (h.maxval > 255 ? PR_PIXEL_FORMAT_RGBA16 : PR_PIXEL_FORMAT_RGBA8) : PR_PIXEL_FORMAT_RGBA32F;
  std::snprintf(info->codec, sizeof(info->codec), "%s", h.kind == 6 ? (h.maxval > 255 ? "PPM 16-bit" : "PPM") : "PFM");
  return PR_ERR_NONE;
}

PrErr open(PrImportCall* c) {
  std::vector<unsigned char> b;
  if (!read_file(c->path, b)) return fail(c, "the file cannot be opened"), PR_ERR_NOT_FOUND;
  const PrHandle h = c->host->handle_new(c->host_ref, b.size());
  void* p = c->host->handle_lock(c->host_ref, h);
  if (h == 0 || p == nullptr) return PR_ERR_OUT_OF_MEMORY;
  std::memcpy(p, b.data(), b.size());
  c->file_data = h;
  return PR_ERR_NONE;
}

PrErr read_frame(PrImportCall* c) {
  if (std::string(c->path).find("crash") != std::string::npos) {
    volatile int* bad = nullptr;
    *bad = 42;  // NOLINT(clang-analyzer-core.NullDereference): the fault being injected
  }
  const auto* p = static_cast<const unsigned char*>(c->host->handle_lock(c->host_ref, c->file_data));
  const std::size_t n = c->host->handle_size(c->host_ref, c->file_data);
  if (p == nullptr) return fail(c, "the file is not open"), PR_ERR_NOT_FOUND;
  const std::vector<unsigned char> b(p, p + n);
  std::vector<Header> frames;
  double fps = 30;
  std::string why;
  if (!scan_frames(b, frames, fps, why)) return fail(c, why), PR_ERR_INVALID_PARAM;
  // The image shown at `time` (source time): frame floor(time x rate), held at the ends.
  const double at = std::floor(static_cast<double>(c->time) / kTimeScale * fps + 1e-6);
  const std::size_t index = at <= 0 ? 0 : std::min(frames.size() - 1, static_cast<std::size_t>(at));
  const Header& h = frames[index];
  PrWorld* w = c->frame;
  if (w == nullptr || w->width != h.width || w->height != h.height) return fail(c, "the frame does not match the file"), PR_ERR_INVALID_PARAM;
  const unsigned char* px = b.data() + h.data;
  for (int y = 0; y < h.height; ++y) {
    auto* row = static_cast<unsigned char*>(pr_world_row(w, y));
    for (int x = 0; x < h.width; ++x) {
      const std::size_t i = static_cast<std::size_t>(y) * static_cast<std::size_t>(h.width) + static_cast<std::size_t>(x);
      if (h.kind == 6 && h.maxval <= 255 && w->format == PR_PIXEL_FORMAT_RGBA8) {
        for (int k = 0; k < 3; ++k) {
          row[x * 4 + k] = static_cast<unsigned char>(std::lround(px[i * 3 + static_cast<std::size_t>(k)] * 255.0 / h.maxval));
        }
        row[x * 4 + 3] = 255;
      } else if (h.kind == 6 && w->format == PR_PIXEL_FORMAT_RGBA16) {
        uint16_t out[4] = {0, 0, 0, 65535};
        for (int k = 0; k < 3; ++k) {
          const std::size_t o = (i * 3 + static_cast<std::size_t>(k)) * 2;
          const unsigned v = h.maxval > 255 ? (static_cast<unsigned>(px[o]) << 8U) | px[o + 1] : px[i * 3 + static_cast<std::size_t>(k)];  // big-endian
          out[k] = static_cast<uint16_t>(std::lround(v * 65535.0 / h.maxval));
        }
        std::memcpy(row + x * 8, out, 8);
      } else if (h.kind != 6 && w->format == PR_PIXEL_FORMAT_RGBA32F) {
        // PFM rows run bottom-up; floats in the scale's byte order.
        const int sy = h.height - 1 - y;
        const std::size_t si = static_cast<std::size_t>(sy) * static_cast<std::size_t>(h.width) + static_cast<std::size_t>(x);
        const std::size_t ch = h.kind == 'F' ? 3 : 1;
        float out[4] = {0, 0, 0, 1};
        for (std::size_t k = 0; k < 3; ++k) {
          unsigned char v[4];
          std::memcpy(v, px + (si * ch + (ch == 1 ? 0 : k)) * 4, 4);
          if (h.scale > 0) std::swap(v[0], v[3]), std::swap(v[1], v[2]);  // big-endian file
          std::memcpy(&out[k], v, 4);
        }
        std::memcpy(row + x * 16, out, 16);
      } else {
        return fail(c, "unexpected world depth"), PR_ERR_UNSUPPORTED;
      }
    }
  }
  return PR_ERR_NONE;
}

PrErr PR_CALL ppm_main(PrIoCmd cmd, PrImportCall* c) {
  if (c == nullptr || c->struct_size < sizeof(PrImportCall)) return PR_ERR_BAD_VERSION;
  switch (cmd) {
    case PR_IMPORT_PROBE: return probe(c);
    case PR_IMPORT_OPEN: return open(c);
    case PR_IMPORT_READ_FRAME: return read_frame(c);
    case PR_IMPORT_READ_AUDIO: return fail(c, "PPM files have no sound"), PR_ERR_UNSUPPORTED;
    case PR_IMPORT_CLOSE:
      if (c->file_data != 0) c->host->handle_dispose(c->host_ref, c->file_data);
      return PR_ERR_NONE;
    default: return PR_ERR_UNSUPPORTED;
  }
}

// ── .praw: sound only (READ_AUDIO) ──────────────────────────────────────────

struct RawAudio {
  unsigned rate = 0;
  unsigned channels = 0;
  std::size_t data = 0;    ///< offset of the samples
  long long frames = 0;    ///< whole sample frames in the file
};

/// `PRAW <rate> <channels>\n` + interleaved little-endian float32.
bool parse_raw(const unsigned char* b, std::size_t n, RawAudio& a, std::string& why) {
  std::size_t eol = 0;
  while (eol < n && eol < 128 && b[eol] != '\n') ++eol;
  if (eol >= n || eol >= 128) return why = "not a PRAW file (no header line)", false;
  const std::string line(reinterpret_cast<const char*>(b), eol);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): bytes as text
  if (line.rfind("PRAW ", 0) != 0) return why = "not a PRAW file", false;
  char* rest = nullptr;
  const unsigned long rate = std::strtoul(line.c_str() + 5, &rest, 10);
  const unsigned long channels = rest != nullptr ? std::strtoul(rest, nullptr, 10) : 0;
  if (rate < 1000 || rate > 768000 || channels < 1 || channels > 8) return why = "bad PRAW rate or channel count", false;
  a.rate = static_cast<unsigned>(rate);
  a.channels = static_cast<unsigned>(channels);
  a.data = eol + 1;
  a.frames = static_cast<long long>((n - a.data) / (4U * channels));
  return true;
}

PrErr raw_probe(PrImportCall* c) {
  std::vector<unsigned char> b;
  if (!read_file(c->path, b)) return fail(c, "the file cannot be opened"), PR_ERR_NOT_FOUND;
  RawAudio a;
  std::string why;
  if (!parse_raw(b.data(), b.size(), a, why)) return fail(c, why), PR_ERR_INVALID_PARAM;
  PrImportInfo* info = c->info;
  info->width = 0;  // no picture
  info->height = 0;
  info->frame_rate = 0;
  info->duration = static_cast<int64_t>(std::llround(static_cast<double>(a.frames) / a.rate * kTimeScale));
  info->has_audio = 1;
  info->audio_sample_rate = a.rate;
  info->audio_channels = a.channels;
  info->audio_frames = a.frames;
  std::snprintf(info->codec, sizeof(info->codec), "PRAW float32");
  return PR_ERR_NONE;
}

PrErr raw_read_audio(PrImportCall* c) {
  const auto* p = static_cast<const unsigned char*>(c->host->handle_lock(c->host_ref, c->file_data));
  const std::size_t n = c->host->handle_size(c->host_ref, c->file_data);
  if (p == nullptr || c->audio == nullptr) return fail(c, "the file is not open"), PR_ERR_NOT_FOUND;
  RawAudio a;
  std::string why;
  if (!parse_raw(p, n, a, why)) return fail(c, why), PR_ERR_INVALID_PARAM;
  const long long start = c->audio_start < 0 ? 0 : c->audio_start;
  const long long avail = a.frames > start ? a.frames - start : 0;
  const long long count = avail < static_cast<long long>(c->audio_frames) ? avail : static_cast<long long>(c->audio_frames);
  // Little-endian floats straight into the host's buffer (every platform the SDK targets is little-endian).
  std::memcpy(c->audio, p + a.data + static_cast<std::size_t>(start) * a.channels * 4U, static_cast<std::size_t>(count) * a.channels * 4U);
  c->audio_frames_read = static_cast<uint32_t>(count);
  return PR_ERR_NONE;
}

PrErr PR_CALL praw_main(PrIoCmd cmd, PrImportCall* c) {
  if (c == nullptr || c->struct_size < sizeof(PrImportCall)) return PR_ERR_BAD_VERSION;
  switch (cmd) {
    case PR_IMPORT_PROBE: return raw_probe(c);
    case PR_IMPORT_OPEN: return open(c);
    case PR_IMPORT_READ_FRAME: return fail(c, "PRAW files have no picture"), PR_ERR_UNSUPPORTED;
    case PR_IMPORT_READ_AUDIO: return raw_read_audio(c);
    case PR_IMPORT_CLOSE:
      if (c->file_data != 0) c->host->handle_dispose(c->host_ref, c->file_data);
      return PR_ERR_NONE;
    default: return PR_ERR_UNSUPPORTED;
  }
}

const PrImporterEntry kImporters[] = {{"ppm", &ppm_main}, {"praw", &praw_main}};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): C ABI table
const PrPluginInfo kInfo = {sizeof(PrPluginInfo), PR_SDK_VERSION, "com.premation.samples.ppmio", 0, nullptr, 0, nullptr, 2, kImporters, 0, nullptr};

}  // namespace

extern "C" PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void) { return &kInfo; }
