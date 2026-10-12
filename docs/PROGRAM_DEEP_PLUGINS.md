# Program: deep plugins (Element 3D class) — SDK 1.2 and P7

Owner ask (2026-10-12): finish the plugin platform before anything is pushed or
deployed, so the editor carries plugins as deep as After Effects does —
Element 3D, Particular, Optical Flares, Plexus class. Builds on
docs/PLUGIN_PLATFORM_PLAN.md (P1–P6 built 2026-10-08) and docs/PLUGIN_SDK.md.
Everything stays local on `native-core`; nothing is pushed or released.

## 0. What "Element 3D class" needs, and where we stand

| Need (what E3D / Particular do in AE) | AE mechanism | Premation before this program |
|---|---|---|
| Render meshes through the comp camera and lights | `AEGP_GetEffectCamera`, light suites | SDK 1.1, frame time only |
| Camera / lights / emitter at other times (trails, motion blur, sims) | `PF_CHECKOUT_PARAM`, AEGP at any time | **missing** (`PR_ERR_UNSUPPORTED`) |
| Param values at other times (particle history) | `PF_CHECKOUT_PARAM` | **missing** |
| Motion blur matching the comp | `in_data->shutter_angle/phase`, `PF_OutFlag2_I_USE_SHUTTER_ANGLE` | **missing** |
| Layer time (layer offset, stretch, remap) | `in_data->current_time` is layer time | **bug**: layer time = comp time |
| Output larger than the layer | `max_result_rect` / `result_rect` | **ignored** (result = layer buffer) |
| Load models and textures | file params, own loaders | FILE + bytes (SDK 1.1); no image decode, no sibling files (glTF `.bin`, textures) |
| Occlude by the comp's own 3D layers | E3D "Composite with scene depth" | **missing** |
| GPU render with its own pipelines and depth buffers | GPU suites | done (Dawn device, plugin creates textures) |
| Scene setup UI, viewport handles | custom UI, `PF_Cmd_EVENT` | done (P5) |
| Presets shipped with the plugin | `.ffx` | **missing** |
| Same pixels in export | — | **bug**: export finishes frames with no host (no camera, no checkouts at other times) |
| Non-effect plugins: commands, importers, output modules, panels | AEGP, AEIO, output modules | **missing** (P7) |

## 1. Rows

Status: `[ ]` open · `[~]` in progress · `[x]` done (commit).

### V — verify what exists (GPU box)

- [x] V1 (2026-10-12, RTX 4060: plugin tests 364 + 322 green, then every later gate) Build P4–P6 into the real engine (`scene_finish.cpp`, `scene_native_fx.cpp`, `export_job.cpp`); run `engine_plugins_tests`, `engine_plugins_gpu_tests`, the headless `*plugin*.native.test`, golden renders.
- [x] V2 (baa1b807) Export passes the plugin host to `finish_native_frame` (camera, lights, transforms, checkouts at other times, disabled instances) — export = preview.
- [x] V3 Golden: `particles` applied to a comp-sized solid with an orbiting camera, 3 frames (P4 gate). (83f45afa: `plugin-particles-orbit`, 3 frames, with a trail through checkout_time; `premation-scene --plugins`)

### S — SDK 1.2 (effects)

ABI rule: everything is appended (callbacks at the end of `PrHostSuite`,
trailing `PrInData` fields, new flags and selectors). SDK 1.0 / 1.1 plugins
keep loading unchanged. `PR_SDK_VERSION_MINOR` = 2.

- [x] S1 **Times.** `PR_OUT_FLAG_SAMPLES_TIME`. In `SMART_PRE_RENDER` the plugin
  calls `checkout_time(host, time, what)` (`what` = `PR_SAMPLE_PARAMS |
  _CAMERA | _LIGHTS | _LAYER_TRANSFORMS`, layer time, ≤ 1024 per instance per
  frame). `finish_native_frame` evaluates the document at each requested time
  and writes the values into the chain entry, so the frame stays a pure function
  of the document. In every render selector `checkout_param(host, index, time,
  PrParamDef* out)`, `get_comp_camera`, `get_comp_lights` and
  `get_layer_transform` then answer for the frame time and any requested time
  (another time: `PR_ERR_NOT_FOUND`). Evaluation must not build a whole frame per
  time: params, camera, lights and layer matrices only. (1458aa41; sample + tests 83f45afa)
- [x] S2 **Motion blur.** Trailing `PrInData` fields: `shutter_angle`,
  `shutter_phase` (degrees), `motion_blur` (1 when the comp switch and the
  layer switch are on for this render), `motion_blur_samples`. An effect that
  declares `PR_OUT_FLAG_USES_SHUTTER` blurs itself (AE
  `PF_OutFlag2_I_USE_SHUTTER_ANGLE`): the engine does not supersample its layer
  through it. The others are rendered per sample like any layer. (1458aa41; the layer is drawn once, its motion samples dropped)
- [x] S3 **Layer time.** `current_time` is the layer's time (start offset,
  stretch, time remap), `comp_time` the comp's; checkouts at other times use
  layer time. Trailing `PrInData` field `layer_start` (the comp time of layer
  time 0) and `comp_width`, `comp_height`, `layer_is_3d`. (1458aa41; inside a nested comp, comp_time is the top comp's)
- [x] S4 **Output beyond the layer.** `result_rect` from `SMART_PRE_RENDER` grows
  the layer's buffer (as the built-in effects' grow bounds do), capped at the
  oversize limit; `PR_OUT_FLAG_COMP_SPACE`: the effect's output covers the comp
  frame (Element 3D, Optical Flares on a solid of any size). (1458aa41: `reachPx` from result_rect; `comp_to_world`)
- [x] S5 **Assets.** `get_asset_image(host, index, PrWorld**)` (png, jpg, exr,
  hdr, tiff → linear premultiplied RGBA float, through the engine's decoders),
  `get_asset_image_gpu(host, index, const PrGpuWorld**)` (uploaded once, kept
  by the host per file and modification time), and
  `get_asset_sibling_bytes(host, index, relative, data, size)` (a file beside
  the asset: glTF `.bin` and textures, `.mtl`; no `..`, no absolute paths, no
  symlinks out). Collect Files copies the siblings a plugin read. (1458aa41; Collect Files does NOT carry siblings — content-addressed bundle, documented in PLUGIN_SDK.md "Assets") 2026-10-13: NOT built — no clean design today (PLUGIN_SDK.md "Assets" lists why: siblings known only at render, content-addressed blobs, native_file_of has no bundle root and a collected item keeps no src, portable/cloud carry no FILE item bytes). Found on the way: Collect Files does not copy a FILE param's own file either (it keeps its outside path); the doc said it did — corrected.
- [x] S6 **Scene depth.** `PR_OUT_FLAG_USES_SCENE_DEPTH`;
  `checkout_scene_depth_gpu(host, const PrGpuWorld**)` in `SMART_RENDER_GPU`
  and `checkout_scene_depth(host, PrWorld**)` on the CPU path: the depth of the
  comp's 3D layers other than this one, from the comp camera, at the frame time
  (r32float, camera-space distance in px, `+inf` where empty). E3D's "composite
  with scene depth". Depends on the 3D renderer (render_graph/threed.cpp). (82c076f8: render_graph/scene_depth.cpp, its own pass over the 3D group's geometry, no edits to threed.cpp; one pass per frame shared, only when asked; CPU = read-back, PR_ERR_UNSUPPORTED without a GPU. GPU tests b1d32928)
- [x] S7 **Presets.** Manifest `presets: [{ "name", "effect", "values": { "p1": … } }]`
  (and `presets/*.json`); listed in Effects & Presets under the plugin; applying
  one is `addEffect` + the values in one undo entry. (28684395)
- [x] S8 **Proof: `model3d` sample** (Element 3D class, open, in
  `native/sdk/samples`): a `.glb`/`.gltf` FILE param (siblings via S5), GPU
  render with a depth buffer through the comp camera and lights, a layer as a
  texture map (`checkout_layer_gpu`), shutter motion blur through S1/S2, scene
  depth occlusion (S6), a position handle (overlay) and a material panel
  (`ui/`). CPU path renders the same picture at lower quality (no GPU = still a
  frame). Golden renders: camera orbit, motion blur, occlusion by a 3D solid. (b1d32928 sample + tests; a38cc63d goldens plugin-model3d-orbit / -blur / -occlusion; f6123695 PLUGIN_SDK.md walkthrough; 2f7f328d fixed the render glue sRGB-decoding every plugin's output — particles references re-blessed. Overlay handle has no camera: exact only under the default view)

### G — last gaps (2026-10-12)

- [x] G1 **Colours in linear light.** COLOR values (params[], checkout_param, overlays, USER_CHANGED_PARAM,
  UPDATE_PARAMS_UI, defaults) and GRADIENT stops' r, g, b reach a plugin decoded from the document's sRGB
  (the builtins' IEC transfer, host.cpp `param_defs`); `set_param_value` encodes back (round trip exact:
  rings' hidden Swap Colors + test_plugin_session). Re-blessed plugin-particles-orbit (×3) and
  plugin-model3d-orbit / -blur / -occlusion (Base Color resolves to the declared #cccccc default → 0.604 linear). (a5154862) 2026-10-13: those scenes stored Base Color as [1,1,1,1], not a document colour — now "#ffffff" (the model renders as intended, ~25 % brighter; re-blessed), and a COLOR param stored as anything but `#rgb` / `#rrggbb` / `#rrggbbaa` is reported on layerErrors once per instance and param ("parameter 'Base Color' is not a colour"), still rendering the default.
- [x] G2 **Overlay through the camera.** get_comp_camera / _lights / get_layer_transform answer in DRAW_OVERLAY /
  OVERLAY_DRAG at the viewer's time (doc::NativeScene in the request, plugins/scene_eval.cpp, also the
  Sampler's evaluator now); `overlay_set_space` (PR_OVERLAY_SPACE_COMP), PrOverlayExtra.comp_width/height,
  PrOverlayDragExtra.space; schema OverlayPluginItem.space / dragEffectOverlay.space; editor maps comp px
  through the viewer's comp → screen. model3d's handle is the projected Position; a drag moves it in the
  camera's view plane at its depth. (9fb58daa engine/ABI/schema, c853e35f editor, cb92b651 docs)
- [x] G3 **Scene depth: collapsed precomps + sub-times.** scene_depth.cpp draws the 3D layers of collapsed 3D
  precomps (no own camera, not a flat card; × the precomp's opacity). PR_SAMPLE_SCENE_DEPTH +
  `checkout_scene_depth_gpu_at` / `checkout_scene_depth_at`: finish_native_frame poses the comp camera and the
  drawn 3D layers at each sub-time (`s<i>.dp.*` in the entry); model3d occludes each blur sub-frame at its time.
  ~~Limits: a collapsed precomp's own layer motion is not re-evaluated per sub-time~~ — 2026-10-13: a collapsed
  precomp's layers are posed by the comp built at each sub-time (scene_finish.cpp built_model_at). No edit to threed.cpp. (9fb58daa)

### Close-out 2026-10-13

- Known red settled (11057941): test_fx_bounds expectations at 3.5σ; bevel-above/below-cap were a regression of S4 (blur taps
  spread past the texels) — fixed, references kept; blur-hard-edge and three-d-outer-glow ×2 re-blessed (S4's faded tail).
- model3d goldens store Base Color "#ffffff"; an invalid plugin COLOR is reported on layerErrors (f908c381).
- S3 in nested comps: comp_time / layer_start are the layer's own comp's; prefixed nested layers resolve their node (66f6bb68).
- G3: collapsed precomps' layers posed at scene-depth sub-times (1b61c244).
- S5 Collect Files + siblings: not built, reasons in PLUGIN_SDK.md "Assets" (7bb1175d).
- Gates: engine_plugins 49/49, plugins_scene 9/9, plugins_gpu 15/15, engine_tests 190/190 (green), audio 34/34, jobs 99/99;
  plugin jest 12 suites green (headless); typecheck, lint (0 errors), engine-api:check, native golden gate green
  (345/355 gated + ceilings), bench:check 0 regressions.

### P7 — plugins that are not effects

- [x] P7a **Commands (AEGP class).** `pr_command.h`: a module lists commands
  (`PrPluginInfo` trailing fields); manifest `commands: [{ id, name, menu }]`.
  The editor shows them in a Plugins menu and the command palette. The command
  runs in the engine (core thread, guarded, watchdog) with
  `engine_query(json)` / `engine_command(json)` on the engine API, origin
  `plugin`; one invocation = one undo entry. The selection and the current time
  come in the context. (46495836 ABI, 7ba0af7b engine API, 65a7d000 engine, 2ba579fb Plugins menu + palette)
- [x] P7b **Importers (AEIO class).** `pr_io.h`: manifest `importers: [{ extensions }]`;
  selectors `PROBE` (size, fps, duration, alpha, audio), `OPEN`, `READ_FRAME`
  (time → a world), `READ_AUDIO`, `CLOSE`. The engine's decode layer routes those
  extensions to the plugin; a crash fails that item ("plugin failed to read"),
  never the frame. (46495836, 65a7d000 probe / texture feed / layerErrors, 2ba579fb picker; 68aedec1 + 66b4f130: the sound reaches the playback mixer, the export mix / WRITE_AUDIO and the audio jobs (audio/external_audio.hpp), analysis jobs read frames through the importer (open_plugin_frames; child-process jobs — Object Matte, face track — still cannot); ppmio moving .ppm + `.praw` sound)
- [x] P7c **Output modules.** Manifest `outputModules: [{ id, name, extension, options }]`;
  selectors `BEGIN` (path, size, fps, audio, options), `WRITE_FRAME`,
  `WRITE_AUDIO`, `END`. The Render Queue lists them as formats; options are
  declared controls (popup, number, checkbox). (46495836, 65a7d000 export job, 2ba579fb Export form / Render Queue + options; 66b4f130 export with audio through ppmseq → .wav tested)
- [x] P7d **Panels without an effect.** Manifest `panels: [{ id, name, page }]`: a
  dockable panel with the P5 sandbox; the message API adds `query` and
  `command` (the engine API, origin `plugin`) and document-change events. (2ba579fb `plugin:<id>/<panel>` dock panels, the query / command / context message API; d2e4a1fb pop-out windows: the id travels encoded)
- [x] P7e Docs (`PLUGIN_SDK.md`), samples (a command, a `.ppm` importer, a
  `.ppm`-sequence output module, a panel) and tests for each. (953bc962 samples distribute / ppmio / ppmseq / statspanel, 171a4fc5 docs, 65a7d000 engine_plugins_tests [contrib], 2ba579fb pluginContrib.native.test.ts)

### B — backend

- [x] B1 Merge motion-back `plugin-platform` into `dev` locally (no push); the
  manifest reader learns `presets`, `commands`, `importers`, `outputModules`,
  `panels`; run the suite. (motion-back ae722fe on local dev, unpushed: contributions + presets validated as the engine does, stored on PluginVersion, `contributions.counts` in listings; 74 suites / 1374 tests; no route change, backend-routes.txt unchanged)

### Not in this program (owner decisions to make)

- Premation's own paid plugins (Saber, Particles, Flares): closed source, own
  repository (PLUGIN_PLATFORM_PLAN §3.4); they build on S1–S8.
- G3: loading real `.aex` binaries.
- A plugin writing depth into the comp's 3D scene (beyond AE).
