# Program: playback, text, ink (started 2026-10-09)

Owner request (2026-10-09): fix everything the samurai-video audits found —
playback/caching, writing systems, ink features, MCP tool gaps — and keep
going until done. Work lands as local commits on `native-core` (no push until
the owner says so). Evidence for every item: the two audits in this session
(perf audit + rendered ink/text probe), summarised under each task.

## How a resumed session continues

1. `git log --oneline -15` and read **Progress** below; take the first task not `[x]`.
2. If another Claude session is busy in this checkout (`ListAgents`), message it
   before touching `native/` — two native builds in one tree collide.
3. One task = one commit (`<area>: <what>` + why), tests green for what it touches:
   - engine: `npm run native:build -- --engine`, then `npm run native:test -- --engine`
   - app: `npx jest <paths>`; GPU suites with `PREMATION_GPU_TESTS=1`
   - shaders / passes / snapshot: `npm run native-golden` (parity gate, CLAUDE.md)
   - perf: quote before/after (`npm run bench`, heavyScene bench); `npm run bench:check` green
   - `npm run typecheck`, `npm run lint` (no new warnings)
4. Tick the task here in the same commit. Never push.

## Phase P — playback and caching

| id | task | done when |
|---|---|---|
| P0 | Land fx-grow-bounds + oversize-layer patches (in the tree uncommitted) | built, ctest + goldens green, committed (by whichever session owns it) |
| P1 | Video frames reach the frame cache: cache fill builds exact (paused-mode) frames; exact frames store while playing | session test: cache-first over a comp with video stores every frame |
| P2 | Auto resolution reads per-frame drops (FrameReady.dropped / interval), not 1 Hz stats | unit test on the hysteresis with per-frame input; restore in ~1.5 s not ~45 s |
| P3 | Core-thread back-pressure: no frame build while the viewport's job is still pending (superseded builds skipped) | session test: builds ≤ rendered + 1 per viewport during slow playback |
| P4 | Frame build off the core thread: a build worker on an immutable document snapshot; the core answers UI requests while a frame builds | UI request latency during heavy playback < 1 frame build; determinism tests green |
| P5 | CPU/GPU overlap: prepare (rasters, texture feed) of frame N+1 while the GPU draws N; no per-frame `wait_idle` where the route allows (shared-texture fence or a completion callback) | heavyScene bench fps up at Full; no torn frames |
| P6 | Cheaper content key: hash the frame once at build (core thread, in the worker), no re-encode on the render thread; prepare stops copying the file | per-frame CPU on render thread down (bench) |
| P7 | Pipeline warm-up: compile every material pipeline the document uses at open / on first sight, async (CreateRenderPipelineAsync) | no first-appearance hitch (frame-time spike) in a bench that introduces an effect mid-play |
| P8 | Per-layer effect-chain cache: a GPU-routed layer whose content + effect params are unchanged reuses its chain output (layer-space key; transform-only animation reuses) | bench: static glowing layer moving = one chain run; goldens identical |
| P8b | Transform-only reuse of a layer's chain: chains run in layer space (AE), so a layer that only moves keeps its result | bench: a glowing title sliding = one chain run; goldens identical; frames identical to a fresh render |
| P9 | Play falls back to cache-first on a comp that cannot play in real time (or idle background caching), so the second loop is a blit | after one pass, loop 2 has zero drops on heavyScene |
| P10 | Device texture pool idle limit scales with the play range (no re-upload every loop > 4 s) | loop 2 uploads 0 textures |
| P11 | HUD / layerErrors report a layer that fell to the CPU bake (and why) | snapshot test |

## Phase T — writing systems

| id | task | done when |
|---|---|---|
| T1 | Per-character OS font fallback in `fonts_ffi.cpp` (DirectWrite / CoreText / fontconfig `matchFamilyStyleCharacter`), after the bundled chain | JA/ZH/KO/HI/TH/emoji with a missing or Latin-only font render glyphs, not boxes |
| T2 | Bundled core fonts + `PREMATION_FONTS_MANIFEST` set by Electron main (dev + packaged): Inter, Noto Sans/Serif JP, SC, TC, KR, Noto Sans Devanagari/Thai/Arabic/Hebrew, a brush font | engine starts with the manifest; default text renders Inter on a machine without it |
| T3 | Language per text layer (`text/language`, default from content script) passed to HarfBuzz instead of `"en"` | JA vs SC glyph forms differ in a pan-CJK font test |
| T4 | Missing-font report: a fallback recorded on `layerErrors` (stage `font`) and surfaced to MCP `describe_scene` | test: unknown family → layerError names requested + used |
| T5 | MCP/tools: text `orientation`, `boxWidth/boxHeight` (paragraph text), `align` that works for point text (AE: anchor at the alignment edge), `language`, `list_fonts` | probe: left/right align land on x; vertical title via tools |

## Phase I — ink correctness

| id | task | done when |
|---|---|---|
| I1 | Stroke-only shapes from tools: `fill: 'none'` / transparent fill accepted (shape fill disabled), `fillOpacity` stays fill-only for shape content | probe: stroke ring visible, interior transparent |
| I2 | Write-on brush position in layer pixels from the top-left (AE), + taper/pressure-like size over stroke | probe: keyed (400,300)→(1500,800) draws there |
| I3 | Roughen Edges affects the edge band only (AE), scaled for small layers | probe: 56 px seal keeps its body; kanji interior solid |
| I4 | Adjustment layers give position-dependent effects the right box (Vignette edges, Snowfall/Rainfall visible) | probe on adjustment == probe on a full-frame solid |
| I5 | Dither at float → 8-bit (viewport + export) | dark gradient step test: no runs > N px of one value |

## Phase F — ink features

| id | task | done when |
|---|---|---|
| F1 | `ink-bleed` effect (GPU): edge diffusion into paper, darker edge pooling, granulation, animatable spread | golden + registry entry + panel + MCP enum |
| F2 | `paper` generator effect: fibre noise + tone + grain | golden |
| F3 | `ink-splatter` generator: seeded droplets/splashes, animatable | golden |
| F4 | MCP `paint_strokes` tool: strokes from point lists with pressure, brush size/hardness, write-on duration | tool test renders a tapered stroke |
| F5 | MCP `author_scene` reaches strokes/draw-on cleanly (stroke-only kinds, trim, taper) | compile test |

## Phase M — tool gaps

| id | task | done when |
|---|---|---|
| M1 | `reorder_layer` (above/below/top/bottom) | tool test |
| M2 | `update_mask` / `delete_mask` / mask offset / animated mask path | tool test |
| M3 | `add_effect` accepts `params` | tool test |
| M4 | `get_export_status` (progress, output path) | tool test |
| M5 | `inspect_layers`: real bounds, resolved colours, resolved font per layer | tool test |
| M6 | Audio clip loop + fades | tool test |
| M7 | Author scripts: precomps; gradient stop format documented; key-collision warning (two keys in one frame) | compile tests |
| M8 | Design advisor false alarms: adjustment/full-frame layers not "flat fill", contrast measured against the pixels behind, grain/vignette detection | advisor tests |

## Progress

Heartbeat: 2026-10-10 02:32 — session "Motion-editor rendering bugs" working (refresh every 30 min; a resume run stands down if < 45 min old)

- [x] P0 · [x] P1 · [x] P2 · [x] P3 · [ ] P4 · [x] P5 · [x] P6 · [x] P7 · [x] P8 · [ ] P8b · [x] P9 · [x] P10 · [x] P11
- [x] T1 · [ ] T2 · [x] T3 · [x] T4 · [x] T5
- [x] I1 · [x] I2 · [x] I3 · [x] I4 · [x] I5
- [x] F1 · [x] F2 · [x] F3 · [x] F4 · [x] F5
- [x] M1 · [x] M2 · [x] M3 · [x] M4 · [x] M5 · [x] M6 · [x] M7 · [x] M8

Notes log (newest first):
- 2026-10-10: the native batch is committed (see `git log`). Gates on the final build: ctest 16/16; native golden 335/345 (baseline count; two ceilings raised by the I5 dither — every changed value exactly 1/255); native jest 197 suites / 1719 tests; `bench:check` 0 regressions; typecheck + lint clean. Parity fixtures re-blessed: effect_chain / effect_kernel (roughen rows only, I3), d1_eval + undo (`getPropertyTree` / `getDocument` probes of text layers: the new `language` field; the ink effects in catalog listings).
  Bench, pre-program engine → now: heavyScene Full 14–17.5 → 31 fps (GPU 57–71 → 10 ms/frame; the baseline engine also predates P0's grow bounds, which carry part of this); heavy3d first pass 19–29 → 28–29 fps, dropped 26–250 → 6–12 (part of the old count was paused edits carried into the first played frame — fixed: only a superseded PLAYING job is a drop, RenderJob::playing); heavy3d cached pass render p50 2.2–3.1 → 0.4–0.5 ms (P6); P7 bench (effects first appearing at 1 s) in-point frame 180–218 → 10–11 ms.
  P4 measured, not built: during heavy playback a UI query waits p50 0.55–0.7 ms, p95 3.2–3.9 ms, worst ≤ 9.5 ms against a 3.4–3.6 ms frame build (P3 already keeps the core to one build per drawn frame). A build worker needs the frame builder, the expression cache and the plugin host off the core thread — a determinism risk for ≤ one build of latency. Recommend leaving it unless a heavier comp shows builds of tens of ms.
  P8 caches a layer's chain while its input, parameters and the renderer's switches are unchanged (stored once its key held two frames, pixel-exact — nearest copies in the chain target's own format); a layer that only moves still runs its chain (screen-space chains): that is P8b.
  P6's hash moved ~1–2 ms from the render thread to the core thread's build (cpuFrameMs 2.3 → 3.5); the render thread is the playback pace, the core has headroom.
  Found on the way: every export / auto-reframe failed on a document whose font is not installed (the T4 `font` advisory and P11's `cpu-effects` were counted as frame failures) — export_job skips advisories, cliPrepare test now uses an uninstalled family. P7's synchronous compiles had run while frames were in flight and during playback (1.1 s hitches) — warm-up only in true idle now. A ninja deps log truncated by a stopped build made every build a full rebuild ("premature end of file; recovering"): delete native/build/<preset>/.ninja_deps once.
  T2 waits for the owner: scripts/fetchFonts.cjs downloads the OFL fonts (needs an explicit OK); the wiring (resources/fonts, PREMATION_FONTS_MANIFEST, electron-builder) is committed with an empty manifest.
- 2026-10-09 (evening): (superseded by the 2026-10-10 note — committed) native batch in the tree, needs one full build + gates before commit: P1 (video frames reach the frame cache), P3 (back-pressure), M6-engine (looped audio voices), T1/T4 (per-character OS fallback, font layer error), T2 wiring (resources/fonts, fetchFonts.cjs NOT run — downloading the fonts needs the owner's OK), T3 (script language), I3 (Roughen Edges edge band; re-bless effect_kernel_parity / effect_chain_parity roughen rows with PARITY_REBLESS=1), I4 (adjustment bounds), I5 (output dither), F1-F3 (ink-bleed / paper / ink-splatter shaders + catalog), P7 (pipeline warm-up), P9 (auto cache fill at the wrap), P10 (texture budget), P11 (cpu-effects layer error). Tests: src/core/engine/{videoCacheFill,fontFallback,inkEffects}.native.test.ts (PREMATION_GPU_TESTS=1), test_session.cpp [p3] [p9]. Build trap: the dev app holds native/build/windows-clang-cl-engine/engine/premation-engine.exe — rename it to *.in-use-<ts>.exe before linking; CMAKE_BUILD_PARALLEL_LEVEL=6 (higher ran the machine out of memory).
- 2026-10-09: I2 was not an engine bug: Write-on's brush position is centre-relative by design (range ±4000, default 0 = centre; the .aep importer converts), and per-dab size needs Brush Time Properties = Size, as in AE. Fixed by telling the model (EFFECT_AI_NOTES in add_effect / list_capabilities) + a GPU test of position and taper.
- 2026-10-09: T5 done except `language`, which needs T3 (no engine property yet). Point-text anchoring left as is (existing documents depend on it): align works inside a paragraph box (boxWidth), documented in the tool schema. listFonts is empty under --test-ports by design (deterministic replays).
- 2026-10-09: P0 landed by the peer session (3d7148d9, 77361ddd, b41d210b): ctest 16/16, native golden 335/345, native jest 200 suites, bench:check clean.
- 2026-10-09: program started. Peer session "Motion-editor remaining tasks" had P0's patches applied uncommitted in the tree.
