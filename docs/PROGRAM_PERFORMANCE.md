# Program: After Effects-level performance (started 2026-10-10)

Owner request (2026-10-10): "uploaded a video, gave it effects and motion
tracks — it became super slow … handle every edge case like After Effects, at
least AE-level performance." Work lands as local commits on `native-core`
(no push until the owner says so).

How it is measured — every task quotes before/after from these:

- `src/core/engine/__tests__/videoHeavy.bench.test.ts` — footage + an effect
  stack + a tracked title: play (first / second pass), scrub (first frame and
  the settled exact frame), the motion tracker, edit → frame, UI latency.
  `PREMATION_BENCH_FILES=a.mp4,b.mov` runs it on real footage,
  `PREMATION_BENCH_COMP=3840x2160@60` sets the comp.
- `heavy3d.bench.test.ts`, `heavyScene.bench.test.ts`, `p7Warmup.bench.test.ts`.
- The real app driven over CDP (production renderer build + Electron with
  `--remote-debugging-port`, dialogs stubbed in the main process): viewport fps
  as the page draws it, long tasks, rAF gaps.

Machine of record: the owner's laptop — RTX 4060 Laptop (engine + Electron),
Radeon 780M iGPU unused (`force_high_performance_gpu`), d3d11va zero-copy decode.

## Findings and tasks

| id | finding (measured) | fix | status |
|---|---|---|---|
| V1 | Paused seek deep into a long GOP (phone / stock H.264, 4K) never showed the exact frame: the viewport waited 250 ms on the exact decode lane, then skipped the layer, and nothing drew again. Every paused seek also queued FIFO on that lane, so a scrub decoded every stale frame (each from its keyframe) before the one under the playhead. Test: never exact within 20 s. | `MediaTextures::Mode::settle` for paused viewport draws: the latest lane (a newer seek supersedes), 60 ms wait, nearest frame meanwhile; the render thread draws the job again once its footage is decoded (`take_media_wants` / `media_settled`, polled every 12 ms). Stills, Cache Work Area and export stay exact. | done — seek 240 frames into a 4K GOP exact after ~750 ms; last of 20 scrub seeks exact after ~130 ms (`videoSettle.native.test.ts`) |
| V2 | Vertical 4K footage (2160×3840) first pass: 22 fps, 24 of 90 dropped, render p95 114 ms. Converted footage frames are RGBA16F (66 MB each at 4K); the viewport kept 24 of them + 8 spares — 2.1 GB of an 8 GB laptop GPU — and the driver paged. | Converted-footage LRU on a byte budget (384 MB) besides the count; spare targets ≤ 256 MB; a texture drawn this frame is never recycled before the frame is (`begin_frame`). | done — 91/90 frames, 0 dropped, p95 16–18 ms |
| V3 | `decodeMs` and `vramBytes` in the render stats were always 0 (the HUD could not show decode cost or memory). | Drawer reports the slowest source's decode ms/frame and its GPU bytes; render thread adds the frame cache. | done |
| V4 | `add_effect` / `update_effect_param` refused every parameter on a layer whose property tree the page had not loaded (made in the timeline, by an import, a script): "effect parameter write the engine does not take: blurriness". | `toolContext` loads the tree before addressing the write. | done |
| V5 | Keyframes written through the AI tools: 600 keys took 7 s (~11 ms a key). | | open |
| V6 | Motion tracker 38 fps on 1440p60, 52 fps on 4K (90 frames: 2.4 s / 1.7 s): the analysis decodes and converts full frames to track at 960 px. | | open |
| V7 | Tracking job could not open footage the media system had opened (`/c/…` path accepted by import, refused by the job's reader). | | open |
| V8 | Properties shows shape fields (Roundness, Fill 1, Stroke 1) on a video layer. | | open |
| P8b | (from the playback program) a layer that only moves re-runs its effect chain every frame. | | open |

## Progress

- [x] V1 · [x] V2 · [x] V3 · [x] V4 · [ ] V5 · [ ] V6 · [ ] V7 · [ ] V8 · [ ] P8b
