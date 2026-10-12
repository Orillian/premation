// Sample: PPM Sequence — an OUTPUT MODULE plugin (SDK 1.2, pr_io.h): a format
// the Render Queue lists ("plugin:com.premation.samples.ppmseq/ppmseq") that
// writes every frame as a binary PPM beside the output path the user chose:
// `shot.ppm` → `shot_00000.ppm`, `shot_00001.ppm`, … and, when the export
// carries sound, `shot.wav` (32-bit float WAV of the mix, PR_OUTPUT_WRITE_AUDIO).
//
// Options (declared in the manifest, drawn by the Render Queue):
//   depth    popup  8-bit | 16-bit
//   digits   number 1..9, the frame number's width
//   fault    popup  None | Crash on frame 2 | Error on frame 2 — the samples'
//            fault injection: the export job fails with the plugin's message;
//            the engine and the editor carry on.
#include <premation_sdk/premation_sdk.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "sample_json.hpp"

namespace {

namespace json = prs::json;

struct Job {
  std::string stem;  ///< the path without its extension
  std::string ext;
  int depth = 8;
  int digits = 5;
  int fault = 1;
  long long frames = 0;
  unsigned audioRate = 0;
  unsigned audioChannels = 0;
  unsigned long long audioFrames = 0;  ///< sample frames written to the .wav
  bool audioStarted = false;
};

void put_u32(unsigned char* p, unsigned long long v) {
  for (int i = 0; i < 4; ++i) p[i] = static_cast<unsigned char>((v >> (8U * static_cast<unsigned>(i))) & 0xFFU);
}

/// A 44-byte WAVE header: IEEE float (format 3), 32-bit, `frames` sample frames.
void wav_header(unsigned char* h, unsigned rate, unsigned channels, unsigned long long frames) {
  const unsigned long long data = frames * channels * 4ULL;
  std::memcpy(h, "RIFF", 4);
  put_u32(h + 4, 36 + data);
  std::memcpy(h + 8, "WAVEfmt ", 8);
  put_u32(h + 16, 16);
  h[20] = 3;  // WAVE_FORMAT_IEEE_FLOAT
  h[21] = 0;
  h[22] = static_cast<unsigned char>(channels);
  h[23] = 0;
  put_u32(h + 24, rate);
  put_u32(h + 28, static_cast<unsigned long long>(rate) * channels * 4ULL);
  h[32] = static_cast<unsigned char>(channels * 4);
  h[33] = 0;
  h[34] = 32;
  h[35] = 0;
  std::memcpy(h + 36, "data", 4);
  put_u32(h + 40, data);
}

std::FILE* open_utf8(const std::string& path, const char* mode) {
#if defined(_WIN32)
  std::wstring w;
  for (std::size_t i = 0; i < path.size();) {
    unsigned cp = static_cast<unsigned char>(path[i]);
    int extra = cp < 0x80 ? 0 : cp < 0xE0 ? 1 : cp < 0xF0 ? 2 : 3;
    cp &= extra == 0 ? 0x7FU : extra == 1 ? 0x1FU : extra == 2 ? 0x0FU : 0x07U;
    ++i;
    for (; extra > 0 && i < path.size(); --extra, ++i) cp = (cp << 6U) | (static_cast<unsigned char>(path[i]) & 0x3FU);
    if (cp >= 0x10000) {
      cp -= 0x10000;
      w.push_back(static_cast<wchar_t>(0xD800 + (cp >> 10U)));
      w.push_back(static_cast<wchar_t>(0xDC00 + (cp & 0x3FFU)));
    } else {
      w.push_back(static_cast<wchar_t>(cp));
    }
  }
  std::wstring m;
  for (const char* c = mode; *c != '\0'; ++c) m.push_back(static_cast<wchar_t>(*c));
  std::FILE* f = nullptr;
  return _wfopen_s(&f, w.c_str(), m.c_str()) == 0 ? f : nullptr;
#else
  return std::fopen(path.c_str(), mode);
#endif
}

void fail(PrOutputCall* c, const std::string& why) { std::snprintf(c->return_msg, sizeof(c->return_msg), "%s", why.c_str()); }

Job* job_of(PrOutputCall* c) { return static_cast<Job*>(c->host->handle_lock(c->host_ref, c->job_data)); }

PrErr begin(PrOutputCall* c) {
  const PrHandle h = c->host->handle_new(c->host_ref, sizeof(Job));
  void* mem = c->host->handle_lock(c->host_ref, h);
  if (h == 0 || mem == nullptr) return PR_ERR_OUT_OF_MEMORY;
  Job* j = new (mem) Job();  // NOLINT(cppcoreguidelines-owning-memory): placement into the host's handle, destroyed at END
  c->job_data = h;
  const std::string path = c->path != nullptr ? c->path : "";
  const std::size_t dot = path.find_last_of('.');
  const std::size_t sep = path.find_last_of("/\\");
  const bool hasExt = dot != std::string::npos && (sep == std::string::npos || dot > sep);
  j->stem = hasExt ? path.substr(0, dot) : path;
  j->ext = hasExt ? path.substr(dot) : ".ppm";
  json::Value o;
  (void)json::parse(c->options_json != nullptr ? c->options_json : "{}", o);
  j->depth = o["depth"].num(1) >= 2 ? 16 : 8;
  j->digits = static_cast<int>(o["digits"].num(5));
  if (j->digits < 1 || j->digits > 9) j->digits = 5;
  j->fault = static_cast<int>(o["fault"].num(1));
  j->frames = c->frame_count;
  j->audioRate = c->audio_sample_rate;
  j->audioChannels = c->audio_channels;
  if (j->stem.empty()) return fail(c, "no output path"), PR_ERR_INVALID_PARAM;
  return PR_ERR_NONE;
}

PrErr write_frame(PrOutputCall* c) {
  Job* j = job_of(c);
  const PrWorld* w = c->frame;
  if (j == nullptr || w == nullptr || w->format != PR_PIXEL_FORMAT_RGBA32F) return fail(c, "no frame"), PR_ERR_INVALID_PARAM;
  if (c->frame_index == 2 && j->fault == 2) {
    volatile int* bad = nullptr;
    *bad = 42;  // NOLINT(clang-analyzer-core.NullDereference): the fault being injected
  }
  if (c->frame_index == 2 && j->fault == 3) return fail(c, "injected error on frame 2"), PR_ERR_INTERNAL;
  char num[16];
  std::snprintf(num, sizeof num, "%0*lld", j->digits, static_cast<long long>(c->frame_index));
  const std::string file = j->stem + "_" + num + j->ext;
  std::FILE* f = open_utf8(file, "wb");
  if (f == nullptr) return fail(c, "cannot write " + file), PR_ERR_INTERNAL;
  const int maxval = j->depth == 16 ? 65535 : 255;
  std::fprintf(f, "P6\n%d %d\n%d\n", w->width, w->height, maxval);
  std::vector<unsigned char> row(static_cast<std::size_t>(w->width) * 3 * (j->depth == 16 ? 2 : 1));
  for (int y = 0; y < w->height; ++y) {
    const auto* px = static_cast<const float*>(pr_world_row(w, y));
    for (int x = 0; x < w->width; ++x) {
      for (int k = 0; k < 3; ++k) {
        float v = px[x * 4 + k];  // straight, display-encoded: what a PPM stores
        v = v < 0 ? 0 : v > 1 ? 1 : v;
        const auto q = static_cast<unsigned>(v * static_cast<float>(maxval) + 0.5F);
        const std::size_t i = static_cast<std::size_t>(x * 3 + k);
        if (j->depth == 16) {
          row[i * 2] = static_cast<unsigned char>(q >> 8U);  // big-endian
          row[i * 2 + 1] = static_cast<unsigned char>(q & 0xFFU);
        } else {
          row[i] = static_cast<unsigned char>(q);
        }
      }
    }
    std::fwrite(row.data(), 1, row.size(), f);
  }
  const bool ok = std::fclose(f) == 0;
  return ok ? PR_ERR_NONE : (fail(c, "cannot finish " + file), PR_ERR_INTERNAL);
}

PrErr write_audio(PrOutputCall* c) {
  Job* j = job_of(c);
  if (j == nullptr || c->audio == nullptr || j->audioChannels == 0 || j->audioRate == 0) return PR_ERR_NONE;
  const std::string file = j->stem + ".wav";
  // The first block writes the header (sizes patched at END); later blocks append.
  std::FILE* f = open_utf8(file, j->audioStarted ? "ab" : "wb");
  if (f == nullptr) return fail(c, "cannot write " + file), PR_ERR_INTERNAL;
  if (!j->audioStarted) {
    unsigned char h[44];
    wav_header(h, j->audioRate, j->audioChannels, 0);
    std::fwrite(h, 1, sizeof h, f);
    j->audioStarted = true;
  }
  // Little-endian float32 as the host hands it (every platform the SDK targets is little-endian).
  const std::size_t n = static_cast<std::size_t>(c->audio_frames) * j->audioChannels;
  const bool ok = std::fwrite(c->audio, sizeof(float), n, f) == n;
  const bool closed = std::fclose(f) == 0;
  if (!ok || !closed) return fail(c, "cannot write " + file), PR_ERR_INTERNAL;
  j->audioFrames += c->audio_frames;
  return PR_ERR_NONE;
}

PrErr end(PrOutputCall* c) {
  Job* j = job_of(c);
  PrErr err = PR_ERR_NONE;
  if (j != nullptr && j->audioStarted) {  // the WAV's sizes, now that they are known
    const std::string file = j->stem + ".wav";
    std::FILE* f = open_utf8(file, "r+b");
    unsigned char h[44];
    wav_header(h, j->audioRate, j->audioChannels, j->audioFrames);
    if (f == nullptr || std::fwrite(h, 1, sizeof h, f) != sizeof h) err = (fail(c, "cannot finish " + file), PR_ERR_INTERNAL);
    if (f != nullptr) std::fclose(f);
  }
  if (j != nullptr) j->~Job();
  c->host->handle_dispose(c->host_ref, c->job_data);
  return err;
}

PrErr PR_CALL ppmseq_main(PrIoCmd cmd, PrOutputCall* c) {
  if (c == nullptr || c->struct_size < sizeof(PrOutputCall)) return PR_ERR_BAD_VERSION;
  switch (cmd) {
    case PR_OUTPUT_BEGIN: return begin(c);
    case PR_OUTPUT_WRITE_FRAME: return write_frame(c);
    case PR_OUTPUT_WRITE_AUDIO: return write_audio(c);
    case PR_OUTPUT_END: return end(c);
    default: return PR_ERR_UNSUPPORTED;
  }
}

const PrOutputModuleEntry kModules[] = {{"ppmseq", &ppmseq_main}};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): C ABI table
const PrPluginInfo kInfo = {sizeof(PrPluginInfo), PR_SDK_VERSION, "com.premation.samples.ppmseq", 0, nullptr, 0, nullptr, 0, nullptr, 1, kModules};

}  // namespace

extern "C" PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void) { return &kInfo; }
