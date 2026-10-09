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

Heartbeat: 2026-10-09 15:40 — session "Motion-editor rendering bugs" working (refresh every 30 min; a resume run stands down if < 45 min old)

- [x] P0 · [ ] P1 · [x] P2 · [ ] P3 · [ ] P4 · [ ] P5 · [ ] P6 · [ ] P7 · [ ] P8 · [ ] P9 · [ ] P10 · [ ] P11
- [ ] T1 · [ ] T2 · [ ] T3 · [ ] T4 · [ ] T5
- [x] I1 · [ ] I2 · [ ] I3 · [ ] I4 · [ ] I5
- [ ] F1 · [ ] F2 · [ ] F3 · [ ] F4 · [ ] F5
- [x] M1 · [x] M2 · [x] M3 · [ ] M4 · [ ] M5 · [ ] M6 · [ ] M7 · [ ] M8

Notes log (newest first):
- 2026-10-09: T5 done except `language`, which needs T3 (no engine property yet). Point-text anchoring left as is (existing documents depend on it): align works inside a paragraph box (boxWidth), documented in the tool schema. listFonts is empty under --test-ports by design (deterministic replays).
- 2026-10-09: P0 landed by the peer session (3d7148d9, 77361ddd, b41d210b): ctest 16/16, native golden 335/345, native jest 200 suites, bench:check clean.
- 2026-10-09: program started. Peer session "Motion-editor remaining tasks" had P0's patches applied uncommitted in the tree.
