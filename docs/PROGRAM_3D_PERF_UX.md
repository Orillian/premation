# Program: 3D playback performance, 3D viewport UX, ink tools (started 2026-10-11)

Owner request (2026-10-11): the MCP-built "The Last Samurai" comp (37 SVG cards
in 3D, 12 cameras, 9 adjustment layers, 20 s) played laggy, froze and lost
quality. "Improve the engine, make it high-performance and strong, and improve
the ink and 3D features' quality, UX and UI — the grid floor, environment and
scene UI." Analysis (memory `project-samurai-3d-perf-analysis-2026-10-11`):
the script was duplicated by the author tools, Auto resolution pumped between
Full and Half with a 0.3–1.7 s stall per switch, SVGs are rasterised at
intrinsic size, 3D layer chains are uncached and full-viewport.

Work lands as local commits on `native-core` (no push until the owner says so).

## How a resumed session continues

1. `git log --oneline -15`, read **Progress**; take the first task not `[x]`.
2. Two native builds in one checkout collide: ONE engine worker at a time.
   The dev app holds `native/build/windows-clang-cl-engine/engine/premation-engine.exe`
   — rename it `*.in-use-<ts>.exe` before linking.
3. One task = one commit (`<area>: <what>`), tests green for what it touches:
   engine `npm run native:build -- --engine` + `npm run native:test -- --engine`;
   app `npx jest <paths>` (GPU suites `PREMATION_GPU_TESTS=1`); shaders /
   passes `npm run native-golden`; perf quotes before/after
   (`src/core/engine/__tests__/heavy3d.bench.test.ts`, the Samurai probe recipe
   in the memory file: `startNativeEngine` + `ProcessEngineClient` +
   `openProject` with a forward-slash path); `npm run typecheck`, `npm run lint`.
4. Tick the task here in the same commit. Never push.

## Measured baseline (2026-10-11, RTX 4060 laptop, 1080p30, 20 s, Full)

Samurai comp: first pass 516–566/600 frames, 35–85 dropped, render p50 9–12 ms,
first frame 1.06–1.7 s; second pass 595–599/600, p50 8–9 ms, p95 19 ms.
Half: p50 9.4 ms (not faster than Full). Any Full↔Half switch: 0.3–1.7 s stall.
Draft 3D: no gain. heavy3d bench: 28–29 fps first pass, 6–12 dropped.

## Tasks

### M — MCP authoring

| id | task | done when |
|---|---|---|
| M1 | `author_scene` / `cast_piece` / `add_scene` never append a second copy of a script: a beat whose name (or `beatId`) already exists is REPLACED (its layers removed inside one undo entry) unless `append: true`; a re-run of a whole piece replaces the piece | tool test: run cast twice → one copy, one history entry per run |
| M2 | `describe_scene` / `review_design` warn on duplicate beats, duplicate cameras active at the same time, and stacked full-frame adjustment layers | advisor test |

### A — app

| id | task | done when |
|---|---|---|
| A1 | Auto resolution does not pump: degrade needs a sustained slow run (not 3 drops), restore waits ≥ 3 s after a degrade and backs off; a switch during the first 2 s of playback (cold caches) is ignored | unit test on the hysteresis with the Samurai drop pattern: ≤ 1 switch per 20 s |
| A2 | HUD shows VRAM and the time of the last slot-size switch; `vramBytes` real in `getRenderStats` | native test |

### E — engine (one worker at a time)

| id | task | done when |
|---|---|---|
| E1 | 3D layer effect chains get a content key and `LayerFxCache` (threed.cpp `resolve_surface` / `run_effects_chain`); chain targets sized to the layer footprint, not the viewport | heavy3d + Samurai probe: render p50 down; goldens identical |
| E2 | 3D surfaces with effects are resolved before the run's main pass: no mid-run MSAA flush/resolve per effect layer | pass count per frame down (debug counter); goldens identical |
| E3 | Precomp / scene targets allocated on demand and kept across a slot-size change (old size kept warm for N frames, no full pool miss) | Full↔Half switch < 100 ms on the Samurai comp |
| E4 | SVG layers rasterised at the displayed scale (DPR × layer scale × camera magnification, quantised, capped) with a mip chain; raster off the prepare path (async, nearest size meanwhile) | probe: a 300 px leaf at 1.4× is sharp; no first-appearance spike > 50 ms |
| E5 | Shadow maps / SSAO / reflections reused within a frame across runs and across frames when lights and casters are unchanged | lit heavy3d: maps rebuilt 0× on a static scene |
| E6 | Draft 3D keeps cheap lighting (ambient + key, no shadows / SSAO / DOF); labels agree in SceneControls / ViewControls / TopNav | render test + UI strings |
| E7 | Radiance `.hdr` (RGBE) environment input | env test |
| E8 | Engine-drawn ground grid (depth-tested, adaptive spacing, distance fade, X/Z axis colours), viewport-only, replaces the SVG overlay grid | GPU test; overlay grid removed |

### U — 3D viewport UI

| id | task | done when |
|---|---|---|
| U1 | Extended Viewer: Custom / axis views (and Draft 3D in Active Camera, as AE) draw layers outside the comp frame (`clipToComp` off), with the frame outline on top | native test + screenshot |
| U2 | Overlay ground grid interim: adaptive spacing by camera distance, distance fade, X/Z axis colours (until E8) | screenshot |
| U3 | Renderer settings dialog (Composition Settings ▸ Renderer): shadow-map size, shadow-light cap, SSAO on/off + quality, DOF quality, MSAA; persisted per comp; engine reads them | native test |
| U4 | Gizmo works on cameras and lights (position / orientation) | test |
| U5 | Scene outliner filter preset: a "3D" view of the Layers panel listing cameras, lights, 3D layers only, with the active camera marked | test |

### I — ink tools

| id | task | done when |
|---|---|---|
| I1 | `paint.<strokeId>.<param>` keyframes accepted by the animatable gate (toolContext.ts) | tool test |
| I2 | `create_layer` / `update_layer` expose stroke cap, join, miter, dash, taper (start/end/ease), wave | tool test |
| I3 | `paint_strokes` exposes brush angle, roundness, spacing, flow, mode | tool test |
| I4 | Tapered stroke on a rounded rect keeps its corners (vector_paint.cpp) | render test |

### B — bugs hit while authoring the samurai comp (peer session, 2026-10-12)

| id | task | done when |
|---|---|---|
| B1 | `author_scene` places adjustment layers at x/y 0,0 so full-frame effects cover only the top-left quarter; adjustment / full-frame layers are centred on the comp | compile test + render probe |
| B2 | `add_sfx` fails inside `begin_edit` / `end_edit` | tool test |
| B3 | Script text-animator sweeps go offset -100→100 over a square [0,100] selector: text visible before/after, hidden mid-sweep; the compiler emits AE-correct offsets (selector sweeps across the text once) | compile test + evaluate_at probe |
| B4 | Out-of-range effect params (e.g. negative snowfall evolution) silently clamp to 0: the tool reply says what was clamped, and params that are legitimately signed (evolution, rotation, offsets) accept negatives | tool test |
| B5 | Light Sweep on a text layer paints the whole text box, not the glyph alpha (engine, effects_spatial) | GPU test |

## Progress

- [x] M1 · [x] M2 · [x] A1 · [ ] A2
- [x] E1 · [x] E2 · [x] E3 · [ ] E4 · [ ] E5 · [ ] E6 · [ ] E7 · [ ] E8
- [x] U1 (UI; engine `clipToComp` pending) · [x] U2 · [x] U3 (UI; engine `renderer` key pending) · [x] U4 · [x] U5
- [x] I1 · [x] I2 · [x] I3 · [ ] I4
- [x] B1 (TS; engine keep-world re-parent of adjustment layers pending) · [x] B2 · [x] B3 · [x] B4 (TS; catalog signed ranges pending) · [ ] B5

Notes log (newest first):
- 2026-10-12 B1–B4 (TS only). B1: `create_layer` centres a full-frame layer
  (kind adjustment, or a solid with no size) on the comp — the engine creates
  it comp-sized at (0, 0), and the quad is centred on its position; and
  `reparent_layer` of an adjustment layer no longer uses the engine's
  keep-world re-parent, which reads an adjustment layer's world transform as
  identity and dropped a centred one to the parent's origin (`setParent
  keepWorldTransform`, and `getLayerTransforms` answers identity for them —
  engine side still owed). B2: `add_sfx` inside a group — the timed insert
  (`insertMediaEdit` with `follow`) opened its OWN gesture, refused
  `gestureOpen` while the group's was open; `joinGesture` sends it into the
  caller's. B3: the text_animator sweep default is offset 0 → 100 (was
  −100 → 100: over Start 0 / End 100 that covers the text only mid-sweep);
  the compiler spells `fromOffset`/`toOffset` out. B4: `add_effect` params and
  `update_effect_param` clamp numbers to the catalog range and SAY so; the
  engine's own clamp is silent. Catalog ranges that forbid negatives for
  signed-looking params (snowfall / rainfall / drizzle / cc-bubbles
  `evolution` 0..36000, noise 0..1000, scatter 0..10000, star-burst /
  card-dance / noise-hls `phase`, pixel-polly `spin`, camera-shake `rotation`,
  scale-wipe / particle-systems `direction`) are reported for the engine
  catalog, not changed. Tests: authoringBugs.native.test.ts (B1 probe over
  evaluated position + size, B3 per-character weights via rangeSelectorAt over
  evaluate_at offsets, B4 reply + engine read-back), sfxInsertEdits.native.test.ts,
  mcpHost.test.ts (inGroup flag), compile.test.ts (B1, B3).
- 2026-10-12 E1–E3 (render graph): 3D surface chains run in LAYER-SIZED buffers
  (footprint at comp scale + margin, multiples of 16, capped at the viewport;
  `SceneRenderer::set_effect_layer_buffers`, on in the engine and exports, off
  in the parity harness so the goldens' pixels hold) and are keyed by content +
  effect params (`fx_keys.hpp`, `surface_content_key`) and kept across frames
  in a second `LayerFxCache` (`fx-surface-<i>`, 16 slots) — a layer that only
  moves under the camera reuses its chain. Each surface's result lives in a
  target of its own (`fx3d-out-<n>`), so a run no longer flushes its MSAA group
  pass per effect layer. Graph targets are declared per frame and allocated on
  first use (`PassContext::target`), and the device pool keeps idle targets up
  to 1800 frames within a 768 MB budget (a Full↔Half switch finds the other
  size warm). Numbers (RTX 4060 laptop): heavy3d first pass p50 23.5 → 7.0 ms,
  second pass p50 16.5 → 0.6 ms (0 dropped); Samurai probe (20 s, 1080p30)
  p50 10.3 → 8.0 ms first pass, 8.8 → 7.6 second; Half→Full switch stall
  155 → 7 ms (first pass), 75 → 20 ms (second). Tests: `E1:`/`E2:`/`E3:` in
  test_render_graph_gpu.cpp (reuse bit-identical to a fresh render under a
  camera move; `p3 − p0 == 3·(p1 − p0)` passes; on-demand + warm pool).
- 2026-10-12: A1, U1–U5 landed on the UI side (renderQualityStore hysteresis; extendedViewer store flag + outline; adaptive overlay grid; Renderer tab under World JSON `renderer`; gizmo on cameras/lights via deviceGizmo.ts; Layers "3D" view + active-camera mark). Engine side still owed: `SetViewport.clipToComp` (+ pasteboard clear colour), `renderer` in the World key whitelist (handlers_comps.cpp:110, readmodel.cpp:499) and its consumers, E6's Draft 3D lighting.
- 2026-10-12: M1, M2, I1–I3 landed (TS only). A beat's identity is its NAME (compileScript's `Beat N — <name>` root; the Beat type has no id); cast_piece identity is the host's per-client record of the last cast's layer ids; add_scene's is its index via sceneWindow's element registry. Structure warnings (structureAdvisors.ts) run in describe_scene (`warnings`) and review_design ("Structure" block); two different adjustment layers at once are deliberately NOT flagged. Native tool tests ran on premation-engine-headless via PREMATION_ENGINE_PATH while the full engine was renamed for a link.
- 2026-10-11: program started.
