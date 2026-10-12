/*
 * Premation native plugin SDK — file I/O (SDK 1.2): importers and output
 * modules. After Effects' AEIO class (a footage format the app cannot read)
 * and its output-module plugins (a format the Render Queue writes).
 *
 * Both are listed in PrPluginInfo's SDK 1.2 trailing fields (`importers`,
 * `output_modules`) and named in the manifest:
 *
 *     "importers":     [ { "id": "ppm", "name": "PPM / PFM", "extensions": ["ppm", "pfm"] } ],
 *     "outputModules": [ { "id": "ppmseq", "name": "PPM Sequence", "extension": "ppm",
 *                          "options": [ { "id": "maxval", "name": "Depth", "type": "popup",
 *                                         "choices": ["8-bit", "16-bit"], "default": 1 } ] } ]
 *
 * Both run in premation-engine inside the crash guard, the watchdog and the
 * crash journal. A crash or an error fails that ONE item — the footage reads
 * as "plugin failed to read …" on layerErrors (the frame still renders without
 * it), the export job fails with the plugin's message — never the frame, the
 * engine or the editor.
 *
 * ── importers ──────────────────────────────────────────────────────────────
 *   PR_IMPORT_PROBE       `path` → `info` (size, rate, duration, alpha, audio).
 *                         Called on import and on relink; no state is kept.
 *   PR_IMPORT_OPEN        `path` → `file_data` (a handle the plugin owns; 0 is fine).
 *   PR_IMPORT_READ_FRAME  `time` (source time, PR_TIME_SCALE ticks; a still ignores it)
 *                         → `frame`, a host world of info.width × info.height at
 *                         info.pixel_format. Pixels are the file's own: STRAIGHT
 *                         (not premultiplied) RGBA, display-encoded (sRGB) unless
 *                         info.linear says scene-linear (e.g. PFM, EXR). Opaque files
 *                         write alpha = 1.
 *   PR_IMPORT_READ_AUDIO  `audio_start` (sample frame index) + `audio_frames` →
 *                         `audio`: interleaved float32, info.audio_channels per frame,
 *                         host-owned; set `audio_frames_read` (fewer = the end).
 *   PR_IMPORT_CLOSE       free `file_data`.
 *
 * ── output modules ─────────────────────────────────────────────────────────
 *   PR_OUTPUT_BEGIN        `path`, size, rate, frame count, audio format, `options_json`
 *                          (the module's declared options, `{ "<id>": value }`) →
 *                          `job_data` (a handle the plugin owns).
 *   PR_OUTPUT_WRITE_FRAME  `frame_index`, `frame`: the rendered frame, host-owned,
 *                          RGBA32F, STRAIGHT alpha, display-encoded (the comp's output
 *                          space, sRGB) — what an image file stores. Frames come in order.
 *   PR_OUTPUT_WRITE_AUDIO  `audio` / `audio_frames`: interleaved float32 (only when
 *                          audio_channels > 0), in order, after the frames.
 *   PR_OUTPUT_END          finish and free `job_data`; `cancelled` = 1 when the job was
 *                          cancelled or failed (remove partial files if you like).
 */
#ifndef PREMATION_SDK_PR_IO_H
#define PREMATION_SDK_PR_IO_H

#include "pr_host.h"
#include "pr_types.h"
#include "pr_world.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef int32_t PrIoCmd;
#define PR_IMPORT_PROBE 0
#define PR_IMPORT_OPEN 1
#define PR_IMPORT_READ_FRAME 2
#define PR_IMPORT_READ_AUDIO 3
#define PR_IMPORT_CLOSE 4

#define PR_OUTPUT_BEGIN 0
#define PR_OUTPUT_WRITE_FRAME 1
#define PR_OUTPUT_WRITE_AUDIO 2
#define PR_OUTPUT_END 3

/** What PR_IMPORT_PROBE reports. The host zero-fills it (struct_size set) before the call. */
typedef struct PrImportInfo {
  uint32_t struct_size;
  int32_t width, height;     /* pixels (0 × 0 = audio only) */
  double frame_rate;         /* frames per second; 0 = a still image */
  int64_t duration;          /* PR_TIME_SCALE ticks (0 = a still image) */
  int32_t has_alpha;         /* the file carries an alpha channel */
  int32_t linear;            /* pixels are scene-linear (else display-encoded sRGB) */
  PrPixelFormat pixel_format; /* the depth READ_FRAME writes (PR_PIXEL_FORMAT_*) */
  int32_t has_audio;
  uint32_t audio_sample_rate;
  uint32_t audio_channels;
  int64_t audio_frames;      /* total sample frames */
  char codec[64];            /* shown in the Project panel ("PPM", NUL-terminated) */
} PrImportInfo;

typedef struct PrImportCall {
  uint32_t struct_size;
  uint32_t host_sdk_version;
  const PrHostSuite* host;   /* handles and log */
  PrHost* host_ref;
  const char* importer_id;   /* the manifest importer id */
  const char* path;          /* the file, absolute, UTF-8 */
  PrHandle file_data;        /* OPEN writes it; READ_* and CLOSE receive it */
  PrImportInfo* info;        /* PROBE: out. READ_*: what PROBE said */
  int64_t time;              /* READ_FRAME: source time */
  PrWorld* frame;            /* READ_FRAME: out pixels (host-owned) */
  int64_t audio_start;       /* READ_AUDIO: first sample frame */
  uint32_t audio_frames;     /* READ_AUDIO: frames wanted */
  uint32_t audio_frames_read; /* READ_AUDIO: out */
  float* audio;              /* READ_AUDIO: out, audio_frames × channels floats (host-owned) */
  char return_msg[PR_MAX_MESSAGE]; /* why a call failed (NUL-terminated) */
} PrImportCall;

typedef PrErr(PR_CALL* PrImporterMainFn)(PrIoCmd cmd, PrImportCall* call);

/** One importer of the module (PrPluginInfo.importers); `id` equals the manifest's. */
typedef struct PrImporterEntry {
  const char* id;
  PrImporterMainFn main;
} PrImporterEntry;

typedef struct PrOutputCall {
  uint32_t struct_size;
  uint32_t host_sdk_version;
  const PrHostSuite* host;
  PrHost* host_ref;
  const char* module_id;     /* the manifest output module id */
  const char* path;          /* BEGIN: the output path the user chose (UTF-8; a sequence numbers it itself) */
  int32_t width, height;     /* BEGIN: frame size */
  double frame_rate;
  int64_t frame_count;       /* frames the job will write */
  uint32_t audio_sample_rate; /* 0 with audio_channels 0 = no audio */
  uint32_t audio_channels;
  const char* options_json;  /* BEGIN: the options, `{ "<option id>": value, … }` (defaults filled) */
  PrHandle job_data;         /* BEGIN writes it; the others receive it */
  int64_t frame_index;       /* WRITE_FRAME */
  int64_t time;              /* WRITE_FRAME: the frame's composition time */
  const PrWorld* frame;      /* WRITE_FRAME: RGBA32F, straight, display-encoded */
  const float* audio;        /* WRITE_AUDIO: interleaved float32 */
  uint32_t audio_frames;
  int32_t cancelled;         /* END: 1 when the job did not finish */
  char return_msg[PR_MAX_MESSAGE];
} PrOutputCall;

typedef PrErr(PR_CALL* PrOutputMainFn)(PrIoCmd cmd, PrOutputCall* call);

/** One output module of the module (PrPluginInfo.output_modules); `id` equals the manifest's. */
typedef struct PrOutputModuleEntry {
  const char* id;
  PrOutputMainFn main;
} PrOutputModuleEntry;

#ifdef __cplusplus
}
#endif

#endif /* PREMATION_SDK_PR_IO_H */
