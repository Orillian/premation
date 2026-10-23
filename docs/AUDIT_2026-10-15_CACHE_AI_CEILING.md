# Audit 2026-10-15 — disk cache, AI sameness, capability ceiling

Read-only audit; no code changed. Evidence was gathered on `native-core` with the
uncommitted disk-cache work in the tree, using the built
`native/build/windows-clang-cl-engine/engine/premation-engine.exe` (10-15 02:22).
Premation was not running, so no MCP test scene could be built (see §3, last row).

---

## 1. Disk cache: it writes and reads, but the write policy skips the frames worth caching

### What works (verified)

| Link | State | Evidence |
|---|---|---|
| Prefs | `diskCacheEnabled: true`, folder `null` (→ default), 20 GB | read from the app's localStorage |
| Main / preload | `cache:defaultFolder` registered, `diskCache.defaultFolder` bridged; compiled into `dist-electron` | `dist-electron/ipc/diskCache.js`, `preload.js` |
| Page → engine | `installDiskCacheSync` (App.tsx:88) sends `setCacheBudget` | the folder exists and fills |
| Engine writer | 4,451 `.pfc` files, 2.5 GB, last write 12:05 today | `%LOCALAPPDATA%\electron\Disk Cache\premation-frames-v1` |
| Key stability across processes | Stable on a real project | probe run E below: 0 new files, every frame served from disk |
| Read path | Works with any policy | probe run F below |

### Probe: "In Motion — brand film" (real MCP-built project), 3 s at 60 fps, 1920×1080, fresh engine process per run

| Run | Policy | Frames written (cumulative) | Wall time to fill 3 s | Slowest frame |
|---|---|---|---|---|
| A | cache off | — | 6.60 s | 3,846 ms |
| B | auto, empty folder | 50 of 180 | 6.60 s | 3,824 ms |
| C | auto, new process, same folder | 63 of 180 | 6.15 s | **3,996 ms** |
| D | forced (`--disk-cache-min-draw-ms 0`) | 180 | 7.49 s | 3,959 ms |
| E | forced, new process | 180 (0 new) | **1.76 s** | **11.8 ms** |
| F | auto, over D's full folder | 180 (0 new) | 1.75 s | 13.9 ms |

With every frame on disk, reopening is 3.7× faster and the 4-second first frame disappears (E, F).
With the shipping policy, a restart still draws ~65% of the frames, including the 4-second
first frame (C). To the user this looks like "the disk cache does nothing".

### Root cause 1 (main): the decision is made before the draw, from earlier frames

`render_thread.cpp:916-960`: whether a frame is read back for disk is decided **before** it draws,
using `predictedMs = min(drawMsAvg_, lastDrawMs_)`. The slow frames are exactly the ones this
prediction misses:

- **The first frame after open / seek** (fonts, rasters, SVGs, pipelines: 3.8 s here). Prediction = 0,
  so `worth_disk(0)` is false and nothing is queued. This happens on every run, including C, where
  the folder already holds files.
- **Spikes in the middle** (a cut, a new text or SVG raster, an effect warming up; p90 = 24 ms here).
  The previous frame was fast, so `min(avg, last)` is small and the spike is skipped. The frame
  after a spike is predicted slow, gets read back, and is then thrown away at
  `render_thread.cpp:1079` because it drew fast.

The policy keeps fast frames off disk, as it was meant to. It also keeps off the slow ones.

### Root cause 2: the threshold is high for a fast GPU

`worth_disk` = draw > 1.5 × 2.0 ms/MP × 2.07 MP + 1 ms ≈ **7.2 ms at 1080p** (`render_thread.hpp:325`
seeds the read cost at 2 ms/MP before any read has been measured). On an RTX 4060 most 2D frames
draw in 5–7 ms, so at most a few frames of a typical comp qualify. The bars stay mostly empty,
and nothing marks them as disk frames.

### Contributing (dev only)

- The disk salt includes the engine exe's size and mtime (`engine_frames.cpp` `disk_salt`), so every
  engine rebuild orphans the whole folder. Most of the 4,451 files are such orphans.
  The salt is also re-read every 2 s: if a peer build replaces the exe on disk, the running engine's
  keys change under it mid-session.
- In dev, `app.getName()` is `Electron`, so the folder is `%LOCALAPPDATA%\electron\Disk Cache`,
  which other Electron dev apps on this machine (kiosk, eye-controll) also use. It is harmless
  because the engine only touches `premation-frames-v1`, but it is confusing. Release builds are unaffected.

### P1 landed (2026-10-15): fixes 1–3 and 6 below

The write decision now uses each frame's own measured draw time. A slow frame with no eager
read-back is copied from its VRAM copy (`queue_late_spill`). The read cost is seeded from a timed
read of the folder's own files (`DiskCache::read_ms_per_mp`). The new native test
`auto policy: the slow first frame goes to disk…` passes.

I reran the same probe on In Motion with the shipping (auto) policy:

| Engine process over the same folder | Fill 3 s | Worst frame |
|---|---|---|
| before the fix, 2nd process (C above) | 6.15 s | 3,996 ms |
| after, processes 1 / 2 / 3 | 6.90 / 7.32 / 7.25 s | ~3.9–4.2 s |
| after, process 4 | 6.86 s | 4,076 ms (frame 163, spilled late) |
| after, processes 5 / 6 / 7 | 2.43 / 2.40 / 2.46 s | 657 / 632 / 638 ms |

Some slow costs are one-time loads (a font, a raster, a pipeline), not costs of a particular frame.
Such a load is paid by the first frame of the process that needs the resource and has to draw it.
Once that frame is a disk hit, the next uncached frame pays instead. So the 4-second cost moved
from frame to frame for four runs, until every frame that needs it was on disk. The ~630 ms cost
still moves one frame per run (5 → 6 → 7). The cache converges, but only over several runs.
Rendering frames ahead into the cache while idle (P8), or warming those resources on idle, would
get there in one. The fill is also slower before it converges (6.15 s → about 7 s). Processes 1–3 ran while an
engine link was still going on this machine, so part of that may be noise. Part of it is real:
late spills run on the render thread (a map and an 8 MB copy per frame written).
Also, the timeline shows no disk lane: the blue lane was removed on the owner's call on 2026-10-14.
Even when the cache works, nothing on screen shows it.

### 2026-10-16: the RAM tier, honest bars, no playback degrade

The owner reported that playback stops and drops in quality, that the cache bars do not work,
and that simple 3D objects sometimes blink. The causes found:

- **The "RAM" cache was VRAM.** It held a quarter of VRAM, capped at 4 GiB: about 4 s of 1080p60
  on an 8 GB card. Eviction was plain LRU, so a loop longer than that missed on every frame. When a
  pass drops frames, the P9 fill at the wrap renders the whole range; with this cache the next pass
  thrashed anyway.
- **The green bar lied.** Coverage was keyed by frame index only. After an edit, the old frames'
  keys were still in the cache and the bar stayed green while every frame redrew. Another comp
  showed this comp's frames.
- **Playback lowered the resolution.** On a heavy comp, Auto dropped playback to Half. Every switch
  was a new slot size: the cache missed every frame, and one frame was mis-framed.
- **A frame spoiled by a GPU error was cached.** It was final as far as the cache knew, so it came
  back on every pass over it (a blink at the same frame).

The changes:

- `render/ram_cache.hpp`: a system-memory tier between VRAM and disk. By default it takes half the
  installed RAM, leaving at least 4 GiB, within 512 MiB–64 GiB; `setCacheBudget.ramMegabytes` or
  `--ram-cache-mb` override it. It shrinks while free memory is under max(1.5 GiB, 10 %).
- The RAM tier is filled from VRAM evictions, so a range that fits VRAM pays no read-back.
- Frames of the range being played are never evicted to make room. A loop larger than the cache
  keeps its cached part and plays it in real time.
- When the RAM tier evicts a slow frame (draw > disk read) it goes to the disk tier, from memory,
  with no GPU read-back.
- Coverage is kept per viewport and per cache scope (comp + document revision + view state;
  `RenderJob::cacheScope`). The timeline shows the blue disk lane under the green one again, in
  one row as AE does.
- `RenderStats.cacheHitRate` is filled in: the share of the last second's frames served from a tier.
- A frame drawn with a GPU error is not final and is not cached. A paused one is drawn again,
  twice at most.
- Frames shown with a stand-in footage frame count toward the P9 fill, as dropped frames do.
- `renderQualityStore`: playback never degrades the resolution; drags still do (Fast Previews).
- Tests: `[ram_cache]` in `engine_tests`, `src/core/engine/ramCache.native.test.ts` (GPU), and
  `__tests__/flicker3d.bench.test.ts`. The bench compares every played frame of a lit 3D scene
  (cold and cached) with the same frame drawn paused. It found no blink in the engine, simple or
  rich (extruded type, glow on 3D, DOF, PBR).

### 2026-10-18: the blink's cause was the raster cache, not the frame cache

The 10-16 bench compared played frames with paused ones over a lit and a rich 3D scene and found no
blink. The owner still saw objects and strokes vanish in a BIG 3D comp. The cause is in the texture
feed, which no frame-cache test touches: `SceneTextures::insert` evicted least-recently-used rasters
whenever the cache passed its fixed 768 MB — including rasters of the frame being prepared. A 3D
layer's raster follows its projected size (`frame_build.cpp screen_per_layer_px`, up to 16 Mpx =
64 MB each), so a dozen layers near the camera outgrow the budget inside one frame; the last layers'
inserts evicted the first layers' rasters, and `external_texture` draws nothing for an evicted raster
("not re-prepared"). The heavier the frame, the more layers blinked out on exactly that frame — and a
cached copy of such a frame came back the same way every pass.

Fixed: a raster of the frame being prepared is never evicted (`Slot.lastUse` / `frame_`; the budget is
a steady-state limit one frame may exceed, `PrepareStats.rasterOverBudget` says by how much); the
budget is sized from the machine (`raster_cache_budget`: an eighth of installed memory within
768 MiB–4 GiB; `PREMATION_RASTER_CACHE_MB` pins it for tests). Tests: `[raster_cache]` in
`engine_scene_tests`; `FLICKER_SCENE=big` in `flicker3d.bench.test.ts` (forty stroked shapes under a
camera push-in with the budget pinned at 8 MB: no blink, cached pass 96 % hits).

The timeline shows the disk tier again: a blue line in its own row right above the green one
(owner 2026-10-18), both from `getCacheCoverage`.

### 2026-10-22: a 600-layer film — the disk tier ignored the build, one warning disabled the no-build path

The owner's report: a 49 s, 657-layer 3D film (1080p60) plays slowly, the RAM cache "cannot cache it", the
disk cache neither, and the two should work together as in After Effects. Measured on that document
(exported read-only, loaded into a fresh `premation-engine`, viewer 1280×720, first 6 s):

| Pass | Result |
|---|---|
| Cache Work Area | 360 frames in 33 s: 92 ms/frame, of which ~64 ms is the CPU build and ~3 ms the GPU draw |
| Play after the fill | 100 % hits, yet 276 of 360 frames dropped (14.5 fps): every frame was built again |
| New engine process, play | 0 % hits; only 138 of the 360 frames had reached disk |

Three causes, each in the engine:

1. **The disk decision weighed the GPU draw alone.** `worth_disk(gpuMs)` saw 2–3 ms and kept the frames off
   disk, while each had cost ~95 ms to make. A range longer than the RAM tier (49 s at 1080p is ~24 GB) then
   lost every frame RAM refused: not in RAM, not on disk, drawn again on every pass. Now `RenderJob::buildMs`
   travels with the frame and the tiers weigh `build + draw` (eager read-back, late spill, RAM eviction).
2. **Any layer warning switched the no-build path off.** The build worker dropped the pre-build key whenever
   a frame had a layer error other than `expression` — a missing font, an unported feature, an oversize
   texture — so a comp with one such layer built every frame even with all of them cached. Only the stages
   that can change on their own (`plugin`, `snapshot`) block it now. With the app's bundled fonts the same
   film plays its cached range at 60 fps with no build.
3. **A new session had to build a frame to find its file.** The disk key is a hash of the built frame, and
   the pre-build map lived in memory, so after a restart the disk tier saved only the GPU draw. The disk cache
   now keeps an alias log (`aliases-v1.bin`: salted pre-build key → content and disk keys, loaded with the
   scan, compacted when dead records outnumber live ones, purged with the frames). Frames that read footage
   files get no alias: their file stamps are in the disk key only, so a replaced file stays a miss.

Also fixed: the frame-key index mapped a frame outside every clip of a layer on the comp clock, where
`comp_to_keyframe_time` maps it through the nearest clip (changed 2026-10-21), so such frames were keyed by
another time's content (`test_session.cpp` "frame keys …" was red). A `playback_summary` log line now says,
per play, how many frames were keyed and how many were served without a build.

### Proposed fix (small, engine-only)

1. **Decide after the draw, from the frame's own measured cost.** When `worth_disk(gpuMs)` holds at
   completion and no readback was queued, spill the frame **from the VRAM frame cache** (the
   frame is already stored there under `key`): queue a lazy readback on idle via
   `cache_->copy_to` → readback buffer → `disk_->store(diskKey, …)`. Fast frames pay nothing, and
   slow frames, first frames and spikes are always written. Keep `diskKey` computed whenever the
   disk tier is on. It is one hash per frame, and the footage-stamp part is already cached for 2 s.
2. Drop the up-front `predictedMs` gate (lines 917 and 960) or keep it only as the eager path.
3. Seed `diskReadMsPerMp_` from a measured read at folder scan (one file read), not a constant.
4. Optional, closer to AE: a pref **"Cache every frame of Cache Work Area"** that sets the min-draw to 0
   while a `cacheOnly` fill runs. The user asked for those frames explicitly.
5. Dev only: salt with an engine **build id** (a git hash or `PREMATION_BUILD_ID` baked in by CMake)
   instead of the exe mtime, so a rebuild with no render change keeps the cache.
   For releases the version string is enough.
6. Tests: extend `diskCache.native.test.ts` with an **auto-policy** case on a comp that has one
   expensive first frame. Expect it to be on disk after run 1 and to be a hit in run 2.
   Today the suite only runs with `--disk-cache-min-draw-ms 0`, which is why it passed while the
   real policy missed these frames.

---

## 2. Why AI output looks like one template

### Evidence: the last 10 AI-built projects (export-job snapshots under `%APPDATA%\electron\export-jobs`)

| Project | Background | 3D layers | Cameras | Lights |
|---|---|---|---|---|
| Premation Launch Film | #06080f | 0 | 2 | 0 |
| Premation Launch Film v3 | #06080f | 0 | 4 | 1 |
| Untitled | #0a0908 | 0 | 1 | 0 |
| Ambient Gradient Flow | #0e1230 | 0 | 0 | 0 |
| Silk Waves | #06080f | 0 | 0 | 0 |
| ChatGPT Launch Film ×3 | #03050b | 0 | 1 | 0 |
| The Last Blade (samurai) | #ece4d6 | 0 | 0 | 0 |
| In Motion — brand film | #06060a | 0 | 0 | 0 |

9 of 10 are near-black. **None has a single 3D layer**, so every camera in them moves over flat
2D layers: a zoom with no parallax. Lights appear once and light nothing, since no layer is 3D.

### Causes, ranked by influence

**C1. The model cannot reach most of the 3D engine (vocabulary gap).** The engine supports PBR
(`metal`, `roughness`, PBR maps), toon shading, extruded meshes (3D text and shapes, bevels),
light types with shadow maps (`shadowSoftness`, `shadowDarkness`, cone feather, falloff), SSAO,
a shadow catcher, HDR skies, a DOF iris and glTF models (`96_render.eapi` RenderShade3D /
RenderLight3D / RenderExtrudedMesh / RenderSsao). The AI tool surface exposes only
`threeD, z, rotationX/Y, acceptsLights, ambient, diffuse, specular, shininess` (`update_layer`),
plus `set_light {color, intensity, radius, coneAngle}` (`packages/ai-tools/src/tools/craft.ts:177`).
It has no light **type**, no shadows, no extrusion or bevel, no metal or roughness, no environment,
no SSAO and no model import. A search of `packages/author/src` finds zero hits for extrusion,
metal, roughness, castsShadows, environment, gltf or lightType. The author `LightSpec` is
`{color, intensity, radius, coneAngle}` (`packages/author/src/types.ts:151`). In the
vocabulary card, light, material and environment props are not animatable
(`vocabulary.ts ANIMATABLE_PROPS`). The model is offered AE 2.5D from 2005 while the engine underneath
can do much more.

**C2. Every worked example is dark, centred and flat.** `packages/author/src/exemplars.ts`, the
reference script embedded in the system prompt **and** returned by `get_author_guide`:

- product_reveal `#070b16`, kinetic_quote `#0b0b10`, logo_sting `#0a0a0f`. All three are near-black.
- All three are centred (`x: 960`), with Inter, Fraunces or Space Grotesk.
- 3D in them is one `threeD` halo and mark plus a 200 px camera z-push. No lights, materials or
  shadows, and no layers at varied depths.
- `get_author_guide` without a brief always returns **product_reveal**, the navy, Inter, centred one
  (`selectAuthorExemplar` picks the first on a tie).
  The prompt says "take none of its colours". Models still copy palette and staging from the one
  example they are shown, so this is the strongest single source of sameness.

**C3. The craft rules penalise cinematic motion.** `packages/ai-tools/src/craftRules.ts`:
"Multi-second moves feel broken unless asked for" and "Move a short distance. 20-60px". These
are UI-motion rules. They forbid slow camera drifts, long dolly moves, big parallax and orbit
reveals, which are the vocabulary of premium motion design. The 3D rule sits in `NEVER_RULES` as
a procedure ("call update_layer { threeD: true } …"), not as a design idea.

**C4. Dark defaults all the way down.**
- New comp background `#101014` (`native/engine/src/scene/scene_types.hpp:260,279`). A script that
  omits `background` keeps it (`coerce.ts:782`).
- `add_scene`'s schema example: `#0a1a3a → #1a0a2e → #0a2e1f` (`tools/compose.ts:343`).
- Look packs: 5 dark, 3 light (`packages/design-system/src/packs.ts`). `apple_keynote`, the first
  and default, is dark.
- The direct-loop prompt (`src/core/ai/buildContext.ts`) recommends "add_background → add_ambient_orbs →
  … → add_light_sweep → add_camera_move" for "a single scene from scratch", which yields dark orbs
  plus a sheen plus a push. It also says "A slow push-in adds production value to almost any hero shot",
  which explains why every camera is a push-in.

**C5. Nothing in review penalises sameness or flatness.** The design lint rules
(`FLAT_FILL, PRIMITIVE_ONLY, EVERYTHING_CENTERED, NO_TEXTURE_LAYER, …`) have no rule for
"camera over all-2D layers", "no lights", "no depth", "dark again", "same concept as last time" or
"no hero image or 3D object". `REVIEW_QUESTIONS` (`designTools.ts`) asks about depth only as
"background layers, grain, shadows". Nothing records what the last piece looked like, so nothing
pushes the next one away from it.

**C6. No concept step that forces divergence.** `designPrompt` asks for an approach (type-, image-,
shape- or 3D-led) but accepts any answer. With C1–C4 behind it, "type-led on dark" is always the
cheapest valid answer.

### P2 landed (2026-10-15): change 1 below

- **Primitives:** `create_layer { kind: 'primitive', primitive: sphere|cylinder|cone|torus|capsule|box|cube|plane, radius, height, width, depth, tube }`.
- **Materials and geometry (`update_layer`):** shading `phong|pbr|toon`, metal, roughness, reflection intensity and sharpness, transparency, IOR, light transmission, casts shadows `off|on|only`, accepts shadows, toon bands, extrusion depth, bevel depth and bevel style.
- **Lights (`set_light`):** type `point|spot|parallel|ambient|environment`, falloff and falloff distance, cone and cone feather, casts shadows, shadow darkness and diffusion, point of interest, and the environment `studio|sky|sunset` with visible and blur options.
- **Animatable:** extrusion, bevel, the material percentages, and the light's intensity, cone, cone feather, shadows and falloff distance. The point-of-interest tracks were already keyable.
- **Author scripts:** the `primitive` kind; a light spec with every field above; material props on a 2D layer turn its 3D switch on, with a repair note; primitive-only and light-only fields are dropped on other kinds.
- **Docs for the model:** the vocabulary card has a REAL 3D section with material recipes and a lit-set recipe, and the MCP instructions name the 3D vocabulary.
- **Test:** `src/core/ai/threeDTools.native.test.ts`, 25 cases. Each reads the engine's property tree back.
- **Not in P2:** comp-level SSAO and shadow-catcher settings, and glTF model import from the AI. Changes 2–7 (examples, motion register, divergence, lint rules) are P3–P5.

### P5 landed (2026-10-15): change 7 below

- `diversityOf` (`packages/author/src/variety.ts`) measures a set of piece fingerprints: distinct values, hue families, media and camera kinds, plus the 3D share, the dark share, and the most common look with its share.
- It fails the set when:
  - one look covers more than half the pieces;
  - more than 60% of the frames are dark;
  - there are fewer than 2 values, 3 hues, 3 media or 2 camera kinds;
  - fewer than one piece in ten uses 3D.
- Under five pieces it reports but never fails.
- The eval harness fingerprints every run: the authored script, or the built scene for library mode. A final `diversity · <mode>` case over the ten `DIVERSITY_CASES` writes `diversity.<mode>.json` and fails on those reasons. `scripts/ai-eval/compare.mjs` prints it.
- Checks: the audit's old ten-piece set fails (60% one look, 90% dark, 0% 3D), and the nine exemplars pass.

### P4 landed (2026-10-15): changes 4–5 below

- **Three concepts:** the in-app design call must sketch three concepts (idea, medium, value, palette, camera) that differ on at least two of value, medium and camera, then pick one and say why. The coercer flags concepts that are missing, too few, alike, or not chosen. The beat calls see only the chosen concept. For MCP, `get_author_guide` asks for the same step; `author_scene` scripts don't need concepts.
- **Fingerprints:** a finished piece's value, accent hue family, medium, camera and lighting (`variety.ts`). The last eight are kept in this machine's local storage (`src/stores/aiPieceHistory.ts`). They are listed in the design prompt and the author guide, with the instruction not to repeat value, medium and camera together.
- **Lint rules** (`lintVariety`): `CAMERA_OVER_FLAT` (error), `NO_LIGHTING_IN_3D` (warn for unlit geometry; error for lights that shade nothing), `DARK_DEFAULT` (warn, using the brief's cues and the composer's mode), `SAME_AS_LAST` (warn, against the last three pieces).
  - They run in `adviseScript`, so the critique, the revise calls and `author_scene`'s reply see them.
  - `review_design` runs them too, on a depth model read from the live document.
- **Tests:** `variety.test.ts`, prompt tests, and `mcpVariety.native.test.ts`. No exemplar trips the depth, lighting or dark rules.

### P3 landed (2026-10-15): changes 2–3 below

- **Exemplars:** nine of them, three dark: a lit 3D product in a pale studio, editorial serif on paper, flat Swiss red, dark 3D primitives under an orbit, image-led, ink ensō, product UI on white, dark neon type, and a dark cinematic title. The model is shown one at random among those the brief matches, weighted by keyword hits, or any when none match. `exemplarRandom` on the author run seeds it for eval.
- **Proven on the engine:** every exemplar coerces with zero repairs, compiles to calls every schema accepts, and builds on the engine (`authorExemplars.native.test.ts`). Stills of all nine were rendered and looked at.
- **Craft rules:** an ELEMENT register (short, precise) and a CINEMATIC register (3–10 s camera, light and plate moves, parallax, held frames). STAGING IN DEPTH is now a positive section. Two new NEVERs: a camera over flat layers, and defaulting to near-black.
- **Fixes found while building them:**
  - The coercer dropped `poiX/Y/Z` keys on lights.
  - The vocabulary card said to paint on a "transparent shape", which renders nothing; paint now goes on a solid.
  - The old exemplars named fonts that don't ship (Fraunces, Space Grotesk); the card now lists the fonts that ship.
- **Still open:**
  - Variable-font weight: Noto Serif and Inter at weight 800 render lighter than that weight. This is the known variable-font trap.
  - The engine harness renders without the font manifest unless `PREMATION_FONTS_MANIFEST` is set.

### Proposed changes

1. **3D vocabulary (largest lever).** Widen the AI surface to what the engine renders:
   - `update_layer` / author `props`: `extrusionDepth`, `bevelDepth`, `bevelStyle`, `castsShadows`,
     `acceptsShadows`, `metal`, `roughness`, `materialPreset` (glass / chrome / clay / plastic /
     paper), `toonBands`.
   - `LightSpec` / `set_light`: `type` (point | spot | parallel | ambient), `castsShadows`,
     `shadowDarkness`, `shadowSoftness`, `coneFeather`, `falloff`, plus a POI. Make the light
     props animatable.
   - Comp-level: `environment` (HDR sky preset), `ssao`, `shadowCatcher`, `groundY`.
   - Author `kind: 'model'`, a glTF from the asset library or a built-in primitive (sphere, torus,
     rounded box, cylinder).
   - The vocabulary-drift test then pins each prop to a native evaluate/render test, as M1 did.
2. **Replace the exemplars with 8–10 that differ on purpose**, chosen at random among the matches
   (seeded by the brief hash), not first-on-tie. At least: a light editorial piece (paper, serif,
   off-grid); a 3D product hero (extruded logo, chrome or glass, key/fill/rim lights, shadow
   catcher, DOF rack); an isometric or toy 3D scene (clay material, warm sun, long shadows); a
   bold flat-colour Swiss piece in saturated primaries; a photographic/image-led piece (generated
   plate + type in masks); a 3D type tunnel or camera fly-through; a data or UI piece on a light
   background; a hand-drawn ink or paint piece (the samurai short's techniques).
   No more than a third may be dark.
3. **Rewrite the motion rules by register.** Keep the UI rules for UI and product demos. Add a
   CINEMATIC register: long eased camera moves (3–8 s), real parallax across depths ≥ 1000 px,
   orbit and fly-through, rack focus, shutter-angle motion blur, a held hero frame. Move 3D out of
   `NEVER_RULES` into a positive section, "Staging in depth": a three-light setup recipe and
   z-spacing guidance.
4. **A concept step that forces divergence.** In `designPrompt`, ask for **three** distinct
   concepts (medium × palette temperature × light/dark × camera idea), have the model pick one and
   say why. Each concept gets a sentence, so the cost is small. Record the chosen concept's
   fingerprint (mode, hue family, medium, camera) per project in prefs. Pass "the last N pieces
   were: …, do something different unless the brief says otherwise" into the next run.
5. **Lint rules that fire.** `CAMERA_OVER_FLAT` (camera with no 3D layers, or z-spread < 300 px),
   `NO_LIGHTING_IN_3D` (≥ 2 lit 3D layers with no light, or only the ambient), `DARK_DEFAULT`
   (background luminance < 6% while the brief has no dark or night cue), `MONO_MEDIUM`
   (only text and primitive shapes in a piece ≥ 10 s), `SAME_AS_LAST` (fingerprint match).
   Feed them to the critique and to `review_design` (`designTools.ts REVIEW_QUESTIONS`).
6. **Defaults.** The new-comp background stays as it is for users. For AI runs, `coerce` should
   *require* a background decision (a repair message rather than a silent `#101014`). Add a light
   example to the `add_scene` schema. Reorder looks so a light pack is not last, and stop treating
   `apple_keynote` as the implied default.
7. **Eval.** The M4 harness (`src/core/ai/author/eval`) gets a diversity metric: over 10 briefs,
   count distinct modes, hue families, 3D use and camera types. A run where 9 of 10 are dark fails.

---

## 3. Capability ceiling: can it deliver premium 2D/3D motion?

Short answer: **2D, yes, near AE level. 3D, the engine is closer to a C4D-lite than the UI and AI
let anyone see. The ceiling for premium work is set by exposure, particles, expressions and
3D performance with shadows, not by core rendering.**

Ranked by impact on premium output (1 = fix first).

| # | Area | Solid | Weak | Missing |
|---|---|---|---|---|
| 1 | **3D materials & lights** | PBR metal/roughness + maps, toon, extruded meshes, typed lights with soft shadow maps, cone feather, falloff, SSAO, shadow catcher, HDR skies, glTF (model3d plugin) | Reachable only through the UI and plugins, not the AI (§2 C1). Shadows cost: two shadow lights p95 82 ms on the samurai comp (PROGRAM_3D_PERF_UX) | Area lights, IBL reflections on arbitrary meshes beyond the sky, a ray-traced mode (out of scope by decision) |
| 2 | **Particles** | Particle layer; CC Particle Systems / snowfall / rainfall / bubbles effects | The particle layer has an "engine default look" (`vocabulary.ts` says to prefer effects) | A Particular / Form-class emitter: 3D particles lit by comp lights, sprite and mesh particles, physics (turbulence, attractors), trails. This is the biggest gap for "premium" briefs |
| 3 | **Expressions** | Safe AE-style subset: wiggle, loopOut, valueAtTime, thisComp, cross-layer reads, sourceText; bit-exact with the old TS engine | **One expression only**: no `var`, `;`, `if`, functions (`native/libs/motion_expr`). Most AE expressions people paste (multi-line rigs) fail | Statements, local variables, user functions, `createPath`, ease()/linear() helpers to check |
| 4 | **Cameras / DOF** | Camera program done (shake, orient along path, rigs, stereo, iris DOF with blades, rack focus, fly-to, follow path) | AI uses the camera only as a push-in (§2) | — |
| 5 | **Performance at quality** | heavy3d p50 7 ms; VRAM frame cache; disk tier (after the §1 fix) | Shadow-lit 3D and first frames (3.8 s here) are slow; disk policy (§1) | Background render-ahead to disk while idle, as AE does with "Cache frames when idle" |
| 6 | **Text & shape animators** | Range selectors, per-char animators, trim paths, repeaters, path operators (zigzag, pucker, twist, roughen, wiggle), merge paths, 3D extruded text with bevels | — | Per-character 3D (AE "Enable Per-character 3D"): no field in the schema |
| 7 | **Effects breadth** | 278 catalog effects, all AI-exposed except `apply-color-lut`; Deep Glow, Lens Flare, keying, distort, stylize, transitions | Quality parity unverified effect by effect | — |
| 8 | **Compositing** | 38 blend modes, track mattes, masks with feather and expansion, adjustment layers, float colour + OCIO | — | — |
| 9 | **Motion blur** | Per-layer, shutter angle and phase, samples per frame | Cost on heavy 3D | — |
| 10 | **Export** | MP4, MOV ProRes 4444, WebM, PNG sequence, GIF, EXR | — | — |
| — | **Live test scene** | — | **Not run**: Premation was closed (`get_app_state` → "Premation is not open"), and I did not launch the owner's app | Rerun with the app open: an extruded chrome logo, three lights with shadows, DOF rack and a 3D particle burst, rendered at 0 / 1.5 / 3 s |

---

## 4. Proposed program (ordered)

| Step | What | Size | Why first |
|---|---|---|---|
| P1 | Disk cache: decide after the draw, lazy spill from VRAM, measured read seed, auto-policy test (§1 fix 1–3, 6) | S (engine, ~1 day) | Owner-visible bug; the probe gives before/after numbers |
| P2 | AI 3D vocabulary: materials, extrusion, light types and shadows, environment, model kind; animatable light props (§2 change 1) | M | Largest lever on sameness; the engine already renders all of it |
| P3 | Exemplars ×8–10, randomised, ≤ ⅓ dark; cinematic motion register; positive 3D staging section (§2 changes 2–3) | M | Second-largest lever; prompt-only, low risk |
| P4 | Divergent concept step + fingerprint memory + lint rules CAMERA_OVER_FLAT / NO_LIGHTING_IN_3D / DARK_DEFAULT / SAME_AS_LAST (§2 changes 4–5) | M | Stops regression to the mean |
| P5 | Eval diversity metric over 10 briefs (§2 change 7) | S | Measures P2–P4 |
| P6 | Expressions: statements, `var`, `if`, functions in `motion_expr` | M–L | Pro users paste AE expressions |
| P7 | 3D particle emitter (lit, sprite and mesh, turbulence, trails) as a native effect or layer | L | The biggest missing premium capability |
| P8 | Per-character 3D text; idle render-ahead to disk | M | Finishing |

Ask before starting P2 onwards; each changes the AI surface or engine scope.
