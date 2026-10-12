# Premation native plugin SDK

Plan step G1 (`docs/NATIVE_CORE_PLAN.md` §5). The owner decided on 2026-09-22 (G2)
that the JavaScript/WGSL plugin system is **not** ported. Native plugins built
against this SDK are the C++ engine's plugin system. The API is modelled on the
After Effects effect API. The table below maps each part to its AE counterpart,
so an AE plugin author can find their way around.

| | |
|---|---|
| Headers | `native/sdk/include/premation_sdk/` (C, versioned ABI; `premation_sdk.h` includes all) |
| Samples | `native/sdk/samples/` — `ripple` (CPU), `rings` (generator + sequence data + button), `checkout` (Layer Displace, Time Echo), `grade` (GPU), `particles` (SDK 1.1: comp camera, lights, layer transforms; SDK 1.2: trails and its own motion blur through `checkout_time`, comp space, presets, a layer-time button); SDK 1.2 plugins that are not effects: `distribute` (a command), `ppmio` (an importer), `ppmseq` (an output module), `statspanel` (a panel + a command) |
| Host | `native/engine/src/plugins/` (runs inside `premation-engine`) |
| Tool | `premation-plugins` — list, render, crash-check a plugin folder without an editor |
| Tests | `engine_plugins_tests` (`tests/test_plugin_host.cpp`, `tests/test_plugin_session.cpp`, `tests/test_plugin_scene.cpp`, `tests/test_plugin_entitlement.cpp`, `tests/test_plugin_sdk12.cpp`, `tests/test_plugin_contrib.cpp`: commands, importers, output modules, panels), `engine_plugins_scene_tests` (`tests/test_plugin_finish.cpp`: the frame hook over a document), `engine_plugins_gpu_tests`, the golden scene `plugin-particles-orbit` (packages/render-tests) |

## Packaging

A plugin is a **bundle**: a folder that holds `premation-plugin.json` and the
binary it names for each platform.

```json
{
  "manifestVersion": 1,
  "id": "com.example.glow",
  "name": "Example Glow",
  "version": "1.2.0",
  "vendor": "Example",
  "sdk": { "major": 1, "minor": 0 },
  "binary": { "windows": "glow.dll", "macos": "libglow.dylib", "linux": "libglow.so" },
  "effects": [ { "matchName": "com.example.glow", "name": "Glow", "category": "Example" } ]
}
```

- The manifest is read and version-checked **before** the binary is loaded. A
  malformed manifest, a missing binary or an incompatible SDK leaves the plugin
  listed as `failed` with the reason, and none of its code has run.
- Ids are 1–100 characters from `[A-Za-z0-9._-]` and start with a letter. An
  effect's match name is `<id>` or `<id>.<name>`. That keeps match names unique
  across plugins and apart from built-in effect types.
- SDK compatibility: the plugin's major must equal the host's major, and its
  minor must be ≤ the host's minor.
- The engine scans every folder passed with `--plugins` (Electron passes
  `<userData>/native-plugins`) plus every folder in `PREMATION_PLUGIN_PATH`
  (`;`-separated). Each folder may be a bundle itself or a folder of bundles.
  Load order is sorted, so it is deterministic.

The module exports one symbol:

```c
PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void);
```

It lists the module's effects, each with its own entry point
`PrErr EffectMain(PrCmd, const PrInData*, PrOutData*, PrParamDef* const*, PrWorld*, void* extra)`.
The plugin id and the match names must match the manifest.

## Selectors (`pr_effect.h`)

| Premation | After Effects | What the plugin does |
|---|---|---|
| `ABOUT` | `PF_Cmd_ABOUT` | text into `return_msg` |
| `GLOBAL_SETUP` / `_SETDOWN` | same | out flags, version, `global_data` |
| `PARAMS_SETUP` | same | `add_param` for each parameter, in order |
| `SEQUENCE_SETUP` / `_RESETUP` / `_FLATTEN` / `_SETDOWN` | same | per-instance state; FLATTEN hands back the pointer-free bytes the project stores |
| `FRAME_SETUP` / `RENDER` / `FRAME_SETDOWN` | same | non-smart render: `params[0]->world` → `output` |
| `SMART_PRE_RENDER` / `SMART_RENDER` | same | `checkout_layer` in pre-render, `checkout_layer_pixels` / `checkout_output` in render |
| `USER_CHANGED_PARAM` | same | a button, or a param flagged `SUPERVISE`; may `set_param_value` / `set_arb_data` and change sequence data |
| `UPDATE_PARAMS_UI` | same | `set_param_ui` (enable / hide / rename) |
| `GPU_DEVICE_SETUP` / `_SETDOWN`, `SMART_RENDER_GPU` | `PF_Cmd_GPU_DEVICE_SETUP`, `PF_Cmd_SMART_RENDER_GPU` | Dawn/WebGPU on the engine's own device (see GPU) |
| `DRAW_OVERLAY` / `OVERLAY_DRAG` (1.1) | `PF_Cmd_EVENT` (draw / drag) | the viewer overlay (see Viewer overlays) |

Out flags (SDK 1.2 adds `SAMPLES_TIME`, `USES_SHUTTER`, `COMP_SPACE`, below): `DEEP_COLOR_AWARE` (16-bit), `FLOAT_COLOR_AWARE` (32-bit float),
`SMART_RENDER`, `GPU_RENDER`, `SEQUENCE_DATA`, `GENERATOR`, `WIDE_TIME_INPUT`,
`NON_PARAM_VARY`, `SEND_UPDATE_PARAMS_UI`, `THREADED_RENDER`.

## Parameters (`pr_params.h`)

Params are declared, and the engine keyframes and evaluates them. At every
render the plugin receives each param's value at the frame's time; it never
interpolates anything itself. In the document each param is an ordinary effect
property under `effects/<id>/p<paramId>`, so undo, keyframes, expressions,
copy/paste, save/open and change events all work as they do for a builtin.

| Param | Document property |
|---|---|
| `SLIDER`, `FLOAT_SLIDER`, `ANGLE` | number (angle in °, valid range → min/max) |
| `POINT`, `POINT_3D` | numbers `p<id>X`, `p<id>Y` (`p<id>Z`), layer px from the layer centre; the plugin gets layer pixels |
| `COLOR` | colour (straight RGBA 0..1 to the plugin) |
| `POPUP` | choice, 1-based |
| `CHECKBOX` | bool |
| `LAYER` | a layer reference (id, `""` = none) |
| `PATH` | a mask of the layer (its bezier at the frame time, 6 doubles per vertex) |
| `ARBITRARY_DATA` | bytes in the document (`fx.pluginData`), written by the plugin or `setPluginData` |
| `BUTTON` | an action (`invokeEffectAction`, `p<id>`) |
| `GROUP_START` / `GROUP_END` | a twirl-down section |
| `STRING` (1.1) | text (`text`; a multi-line field) |
| `CURVE` (1.1) | the Curves effect's point list `[[x, y]…]` in 0..255; the plugin gets `curve` / `curve_count`, x, y in 0..1 |
| `GRADIENT` (1.1) | stops `[[position, r, g, b, a]…]` in 0..1; the plugin gets `gradient` / `gradient_count` |
| `FILE` (1.1) | a project item id (`file_types` filters the picker); the plugin gets `file_name`, `file_missing` and the file through `get_asset_path` / `get_asset_bytes` |

Flags: `CANNOT_ANIMATE`, `SUPERVISE`, `HIDDEN`, `START_COLLAPSED`, `DISABLED`.

The SDK 1.1 types are never keyframed. Their defaults go in the fields at the end
of `PrParamDef` (`text`, `curve`, `gradient`, `file_types`); an SDK 1.0 struct
cannot declare them (the plugin fails to load with "needs SDK 1.1").

A `FILE` param's value is a **project item**: the editor's **Choose…** imports
the file as a `data` item (`importFiles` with `asData`: never probed as
footage), so Collect Files copies it, Relink re-points it, Remove Unused keeps
it while an effect uses it, and the project saves it. At render the engine
resolves the item to a file (`p.<key>.path`, `.missing` in the chain entry), so
a relink re-renders the effect. A missing file never fails the frame: the
plugin sees `file_missing = 1` and `get_asset_*` answer `PR_ERR_NOT_FOUND`,
and the layer reports "file '…' is missing" on `layerErrors`.
`get_asset_bytes` reads the file once per call (≤ 512 MiB). The `grademap`
sample uses all four types (a 1D `.cube` LUT as its FILE).

## Pixels (`pr_world.h`)

- Worlds are full-frame, premultiplied, in the linear working space, at the size
  of the chain's buffer. `in_data->layer_to_world` maps layer pixels to world
  pixels. Scale pixel-sized params by `pixel_scale_x/y`.
- Depth follows AE's down-conversion (`PluginHost::world_format`). A 32-bpc
  project gives `FLOAT_COLOR_AWARE` effects `RGBA32F`, `DEEP_COLOR_AWARE`
  effects `RGBA16` and every other effect `RGBA8`; 16-bpc and 8-bpc projects
  work the same way. The host converts with pure functions (`world_convert.hpp`):
  round-half-away for the integer depths and round-to-nearest-even for half
  floats. The same frame always converts to the same bytes.
- `iterate(count, fn)` runs `fn` for each row on the host's worker pool. Each job
  is crash-guarded.

## Time and checkouts

Times are integer ticks of `PR_TIME_SCALE` (705,600,000 per second, flicks).
`current_time` is the **layer** time; `comp_time` is the composition time
(SDK 1.2, see "Layer time": before 1.2 the engine passed the comp time in both).
`SMART_PRE_RENDER` may check out:

- the effect's input (param index 0) at the current time, which is the chain's
  buffer;
- another layer (a `LAYER` param), or its own layer at another time
  (`WIDE_TIME_INPUT`).

The engine resolves checkouts from the frame itself. For each checkout at
another time, `finish_native_frame` (`scene_finish.cpp`) builds that layer at
that time and adds it as a hidden renderable `<layer>@<flicks>`. A frame stays a
pure function of the document: preview, export and a restarted engine render
the same pixels.

## The comp camera and lights (SDK 1.1, `pr_scene.h`)

AE's `PF_Cmd`-era plugins read the comp camera and lights through
`AEGP_GetEffectCamera` / `AEGP_GetLayerToWorldXform`; Particular, Element 3D,
Plexus and Optical Flares are built on them. SDK 1.1 appends three host
callbacks to `PrHostSuite` (an SDK 1.0 plugin never reads past the old end; a
1.1 plugin checks `struct_size` first, see the `particles` sample):

| Callback | Gives |
|---|---|
| `get_comp_camera(host, time, PrCamera*)` | camera → world and world → camera matrices, the projection (camera → comp px), eye, zoom, vertical FOV, film size, depth of field (focus distance, aperture). `has_camera = 0`: the comp's default view (After Effects' default camera, centred). |
| `get_comp_lights(host, time, PrLight*, capacity, &count)` | every comp light: type, colour, intensity, position, direction, cone, falloff, shadows (≤ `PR_MAX_LIGHTS`). |
| `get_layer_transform(host, param_index, time, double m[16])` | a `LAYER` param's world matrix (layer px → comp world px; a 2D layer at z = 0). |

- **Declare what you read** in `GLOBAL_SETUP`: `PR_OUT_FLAG_USES_CAMERA`,
  `PR_OUT_FLAG_USES_LIGHTS`, `PR_OUT_FLAG_USES_LAYER_TRANSFORMS`. Without the
  flag the callback answers `PR_ERR_INVALID_CALLBACK`.
- **Evaluated at the frame time** (`time` = `current_time`) or, SDK 1.2, at
  a time the effect checked out (see "Other times"); any other time answers
  `PR_ERR_NOT_FOUND` (`PR_ERR_UNSUPPORTED` on an SDK 1.1 host). `finish_native_frame` writes them from the
  built frame into the effect's chain entry (`fx_wire.hpp`), so they are
  inputs of that effect's render: moving the camera re-renders an effect that
  reads it, and no other. The frame stays a pure function of the document.
- World space is After Effects': pixels, +x right, +y down, +z away from the
  viewer, matrices column-major.
- SDK 1.2: on a composition with no 3D layer (Particular on a 2D solid) the
  effect still gets the comp's camera and lights — the scene's own, evaluated
  off the document — instead of the default view.
- The manifest says `"sdk": { "major": 1, "minor": 1 }`; an engine with SDK
  1.0 lists such a plugin as failed ("needs SDK 1.1") instead of loading it.

## SDK 1.2 at a glance — the After Effects mapping

| Premation (SDK 1.2) | After Effects | For |
|---|---|---|
| `PR_OUT_FLAG_SAMPLES_TIME`, `checkout_time(host, time, what)` in `SMART_PRE_RENDER` | `PF_CHECKOUT_PARAM` / AEGP stream values at another time | params, camera, lights, layer transforms at other (layer) times |
| `checkout_param(host, index, time, PrParamDef*)` | `PF_CHECKOUT_PARAM` | a param's value at the frame or a checked-out time |
| `get_comp_camera` / `get_comp_lights` / `get_layer_transform` at a checked-out time | `AEGP_GetEffectCamera`, the light suites, `AEGP_GetLayerToWorldXform` at a time | trails, motion blur, simulations |
| `PrInData.shutter_angle`, `shutter_phase`, `motion_blur`, `motion_blur_samples`; `PR_OUT_FLAG_USES_SHUTTER` | `in_data->shutter_angle` / `shutter_phase`, `PF_OutFlag2_I_USE_SHUTTER_ANGLE` | the effect renders its own blur |
| `current_time` = layer time; `layer_start`, `comp_width` / `comp_height`, `layer_is_3d` | `in_data->current_time` (layer time) | start offset, Time Stretch, reverse, freeze |
| `PrPreRenderExtra.result_rect` past the layer; `PR_OUT_FLAG_COMP_SPACE`, `comp_to_world` | `max_result_rect` / `result_rect`, `PF_OutFlag_I_EXPAND_BUFFER` | a glow's halo, a flare off the layer, Element 3D on any solid |
| `get_asset_image` / `get_asset_image_gpu` / `get_asset_sibling_bytes` | the plugin's own loaders | images decoded by the engine; a glTF's `.bin` and textures |
| manifest `presets`, `presets/*.json` | `.ffx` animation presets | listed under the plugin in Effects & Presets |
| `PR_OUT_FLAG_USES_SCENE_DEPTH`, `checkout_scene_depth_gpu` / `checkout_scene_depth` | none (Element 3D renders the comp's 3D layers itself for "Composite with scene depth") | occlusion by the comp's own 3D layers |

Everything is appended: new `PrHostSuite` callbacks at the end (check
`struct_size >= offsetof(PrHostSuite, get_asset_sibling_bytes) + sizeof(void*)`),
new `PrInData` fields at the end (check
`struct_size >= offsetof(PrInData, comp_to_world) + sizeof(in_data->comp_to_world)`),
new flags in free bits. SDK 1.0 and 1.1 plugins load and render unchanged; a
plugin whose manifest says `"minor": 2` fails on an older engine with "needs SDK 1.2".

## Other times (SDK 1.2)

A trail, a plugin's own motion blur or a simulation's history reads the scene
at times other than the frame's. In After Effects that is `PF_CHECKOUT_PARAM`
and the AEGP stream suites at any time; here the effect says up front what it
will read, and the engine evaluates exactly that:

1. Declare `PR_OUT_FLAG_SAMPLES_TIME` (with `SMART_RENDER`) and the
   `USES_CAMERA` / `USES_LIGHTS` / `USES_LAYER_TRANSFORMS` flags of what it reads.
2. In `SMART_PRE_RENDER` call `checkout_time(host, time, what)` for each time —
   a **layer** time in ticks — with `what` any of `PR_SAMPLE_PARAMS`,
   `PR_SAMPLE_CAMERA`, `PR_SAMPLE_LIGHTS`, `PR_SAMPLE_LAYER_TRANSFORMS`
   (`PR_SAMPLE_ALL`). Asking again for a time adds bits; at most
   `PR_MAX_TIME_SAMPLES` (1024) times per instance and frame.
3. In any render selector, `checkout_param(host, index, time, &def)` (the caller
   sets `def.struct_size`) and `get_comp_camera` / `get_comp_lights` /
   `get_layer_transform` answer for the frame's time and every checked-out time.
   Another time is `PR_ERR_NOT_FOUND`: skip that sample, never fail the frame (a
   renderer that runs no frame hook, such as `premation-render` on a frame file,
   evaluates none).

`finish_native_frame` (`scene_finish.cpp`) runs the pre-render once per frame
and evaluates the requested values **off the document** — the effect's
animatable params (keyframes and expressions at that layer time), the scene
camera, the lights and the LAYER params' world matrices — never a whole frame
per time. Comp times between frames map to source times between frames, as a
layer's motion-blur samples do. Every evaluation is kept for the frame, so many
effects asking for the same shutter samples pay once. The values are written
into the effect's chain entry (`fx_wire.hpp`, `s<i>.*`), so a frame is still a
pure function of the document: preview, export and a restarted engine render
the same pixels. Static params (strings, curves, files, layers, paths) are the
frame's at every time.

When the viewer shows the comp through another camera than the scene's (a
custom or axis view, which never moves) the samples keep that view; when the
frame's lights are not the scene's (Draft 3D) they keep the frame's. A sample
at the frame's own time always equals the frame.

The `particles` sample uses it: Trail Length draws each particle again at the
past frames, where the camera, the emitter and Velocity put it then, and with
the comp's motion blur on it renders its own blur over the shutter.

## Layer time (SDK 1.2)

`current_time` is the layer's own time — its start offset, Time Stretch,
reverse and freeze, the mapping its keyframes use — and `comp_time` the
composition's. Every time an effect passes the host (`checkout_layer`,
`checkout_time`, the scene callbacks) is a layer time; the engine maps it back
to comp time where it builds or evaluates the composition. `layer_start` is the
comp time of layer time 0 (with no stretch, comp time = `layer_start` + layer
time). `comp_width`, `comp_height` and `layer_is_3d` describe the composition
and the layer. Buttons, overlays and the params UI get the layer time of the
playhead too (the `particles` sample's **Reseed From Playhead** writes it).
Inside a nested composition `comp_time` is the top composition's time (a known
limit).

## Motion blur (SDK 1.2)

`PrInData.shutter_angle` and `shutter_phase` (degrees) and `motion_blur_samples`
are the composition's settings; `motion_blur` is 1 when the render, the
composition's switch and the layer's switch are all on (the viewer's Draft
preview turns it off). An effect that declares `PR_OUT_FLAG_USES_SHUTTER`
renders its own blur — it checks out the shutter's times and draws each (AE's
`PF_OutFlag2_I_USE_SHUTTER_ANGLE`) — and the engine does **not** supersample its
layer through it: the layer is drawn once, at the frame. An effect without the
flag is rendered with its layer as before.

## Output beyond the layer (SDK 1.2)

Once per frame the engine runs `SMART_PRE_RENDER` with the world = the layer's
own pixels (`request_rect` = the layer, `layer_to_world` the identity). A
`result_rect` past the layer (a glow's halo, a flare off the layer's edge) grows
the layer's effect buffer by that much — the built-in effects' grow bounds
(`reachPx` in the chain entry) — capped at the engine's texture limit. On a 2D
layer the chain already runs in the frame's own buffer, so the output shows
anywhere in the frame; on a 3D layer the layer-space buffer grows.

`PR_OUT_FLAG_COMP_SPACE`: the effect's output covers the composition frame
(Element 3D, Optical Flares, Particular on a solid of any size). Draw with
`PrInData.comp_to_world` (composition px → world px, row-major like
`layer_to_world`): on a 2D layer it is the view of the composition the chain
renders in; on a 3D layer, whose chain runs in the layer's own plane,
composition pixels are taken as the layer's.

## Assets (SDK 1.2)

A `FILE` param's file, beyond `get_asset_path` / `get_asset_bytes`:

- `get_asset_image(host, index, &world)`: the image decoded by the engine — PNG,
  JPEG, WebP, GIF, BMP, TIFF (the engine's still decoders), OpenEXR, Radiance
  `.hdr`, binary `.ppm` / `.pfm` — as linear, premultiplied `RGBA32F` (8-bit
  footage is sRGB-decoded and straight alpha premultiplied). Kept per file, size
  and modification time: a re-saved file decodes again. `PR_ERR_UNSUPPORTED`: not
  an image the engine reads.
- `get_asset_image_gpu(host, index, &gpuWorld)` (`SMART_RENDER_GPU`): the same
  image as an `rgba32float` texture on the engine's device, uploaded once per
  file and modification time and dropped with the device.
- `get_asset_sibling_bytes(host, index, "textures/albedo.png", &data, &size)`: a
  file beside the asset (a glTF's `.bin` and textures, an `.obj`'s `.mtl`).
  `relative` uses `/` (or `\`); no `..`, no absolute path or drive, no symlink
  out of the asset's folder (`PR_ERR_INVALID_PARAM`); at most 512 MiB.

Collect Files copies the `FILE` param's own file. It does **not** carry the
siblings a plugin read: a collected project stores its files content-addressed
(`blobs/<hh>/<sha256>`), so there is no folder for a sibling to sit beside.
Ship self-contained assets (`.glb`, embedded textures) where you can; a `.gltf`
with external files needs its folder next to the collected project.

## Scene depth (SDK 1.2)

Element 3D's **Composite with scene depth**: a model passes behind the comp's
own 3D layers. After Effects gives a plugin no depth buffer (E3D rebuilds the
comp's 3D layers itself); Premation hands it one.

- Declare `PR_OUT_FLAG_USES_SCENE_DEPTH` in `GLOBAL_SETUP` (without it the
  callbacks answer `PR_ERR_INVALID_CALLBACK`).
- `checkout_scene_depth_gpu(host, &gpuWorld)` in `SMART_RENDER_GPU`: an
  `r32float` texture (`PR_GPU_FORMAT_R32_FLOAT`) on the engine's device. It is
  not filterable: read it with `textureLoad`.
- `checkout_scene_depth(host, &world)` in `SMART_RENDER` / `RENDER`: the same
  depth read back, a `PR_PIXEL_FORMAT_R32F` world (one float per pixel).
- `PR_ERR_UNSUPPORTED` when the render has no GPU to draw the depth with (the
  SDK's `premation-plugins` CPU host, the host tests): render without occlusion.

What a pixel holds:

| | |
|---|---|
| layers | the comp's 3D layers **other than the effect's own**, in the composition the layer is in (a sealed precomp's own camera and layers inside it) |
| view | the comp camera at the frame's time (not per motion-blur sample) |
| size | world-sized: pixel (x, y) is world pixel (x, y) of this render, so `layer_to_world` / `comp_to_world` line up with it |
| value | the **camera-space z** of the nearest surface: the distance from the eye along the view axis, in comp px — `(view · p).z` with `PrCamera.view`, positive in front. Not the straight-line distance to the eye. Compare a fragment's own `(view · p).z` with it. |
| empty | `+inf` where no 3D layer is drawn |
| transparency | a texel whose coverage (texture alpha × mask × opacity, or a solid's shape) is under 1/255 writes no depth — the engine's own 3D pass discards by the same rule; any other texel does (depth is not blended) |

It is an input of the frame: moving a 3D layer (or the camera) re-renders the
effect, and an effect that never asks never pays. The engine draws it in its
own pass over the 3D group's geometry (`render_graph/scene_depth.cpp`: the
quads and the extruded / model meshes, through the scope's camera and the
chain's `comp_to_world`) the first time an effect of the frame asks, and every
effect of the frame that asks with the same world size and placement shares it
(an effect on a 2D layer excludes no drawn layer, so all of them share one pass).
Call the checkouts from the selector's own thread, not from an `iterate()` job.

## Presets (SDK 1.2)

A bundle ships named starting points for its effects (AE's `.ffx`), in the manifest

```json
"presets": [
  { "name": "Warm Fountain", "category": "Fountains", "effect": "com.example.particles",
    "values": { "p2": 600, "p8": "#ffb347", "p5": 2, "p1": [0, -100] } }
]
```

and / or as `presets/*.json` in the bundle (one such object, or
`{ "presets": [ … ] }`). `effect` defaults to the plugin's first effect. Values
are by param key: numbers, angles and sliders (clamped to the valid range),
popups (a 1-based number or the choice's label), checkboxes, colours
(`"#rrggbb[aa]"` or `[r, g, b(, a)]` in 0..1), points (`[x, y(, z)]` or `p<id>X` …,
offsets from the layer centre as the document stores them), strings, curves and
gradients. A key the effect lacks, a `LAYER` / `FILE` / `PATH` param, or a value
of the wrong kind is dropped; a preset without a name, or naming an effect the
bundle does not list, is skipped and logged — never a failed plugin.

`listPlugins` returns them (`PluginInfo.presets`, values in the API's own
encoding); the editor lists them under their effect in Effects & Presets, and
applying one is **one** `addEffect` with the values as its `params` — one undo
entry, no plugin code beyond what adding the effect runs.

## Viewer overlays (SDK 1.1)

AE's `PF_Cmd_EVENT` draw / click / drag, without plugin code in the UI
process. Declare `PR_OUT_FLAG_CUSTOM_OVERLAY` in `GLOBAL_SETUP`, then:

- `PR_CMD_DRAW_OVERLAY` (`PrOverlayExtra`: the layer size): call
  `overlay_line`, `overlay_path` and `overlay_handle` with layer-pixel
  coordinates. The params are the effect's values at the viewer's time. The
  engine runs this when it builds overlay geometry (`overlay_geometry.cpp`);
  the editor maps the list with the layer, as it maps a mask. Limits: 256
  items, 2048 points per call, 192 per path; extra items are dropped.
- `PR_CMD_OVERLAY_DRAG` (`PrOverlayDragExtra`: handle id, phase
  `BEGIN`/`MOVE`/`END`, pointer and start in layer px): write params with
  `set_param_value` (an animated param keys at the current time) or
  `set_arb_data`. The editor sends `dragEffectOverlay`; begin → end is **one**
  undo entry.
- A plugin that crashes while drawing draws nothing; the frame still renders.

The `rings` sample draws its three rings and a crosshair at its centre; dragging
the crosshair moves `Center`.

## Plugin panels (SDK 1.1)

Optical Flares' editor or Element 3D's scene setup, without plugin code in the
editor: a bundle may ship `ui/index.html` (and its scripts, styles, images and
fonts beside it in `ui/`). The effect card then shows **Open Panel**, and the
editor shows the page in a frame:

- served by the app as `plugin-ui://<plugin id>/…` from the bundle's `ui/`
  folder only (no `..`, hidden files or symlinks out);
- `sandbox="allow-scripts"`: an opaque origin, no Node, no storage, no popups,
  no navigation out of the bundle;
- under its own policy: `default-src 'none'`, scripts/styles/images/fonts from
  the bundle, `connect-src 'none'` — no network at all.

The panel talks to the editor with `window.parent.postMessage({ premation: 1, … }, '*')`:

| Panel sends | What happens |
|---|---|
| `{ type: 'ready' }` | the editor answers with `state` |
| `{ id, type: 'setParam', key: 'p2', value }` | `setProperty` on the param (a number, a checkbox, `{ r, g, b, a }`; a point is `p<id>X` / `p<id>Y`); an animated param keys at the current time |
| `{ id, type: 'setArbitraryData', key: 'p3', data: '<base64>' }` | `setPluginData`: an ARBITRARY_DATA param's bytes (≤ 256 KiB) |
| `{ id, type: 'invokeButton', key: 'p9', payload? }` | `invokeEffectAction`: `USER_CHANGED_PARAM` with `PrUserChangedParamExtra.payload` (UTF-8, ≤ 64 KiB) — a hidden button (`PR_PARAM_FLAG_HIDDEN`) is how a panel hands the plugin data for its sequence data |
| `{ id, type: 'requestPreview', maxSize? }` | the engine renders the layer at the current time; the reply carries `image` (a PNG data URL). The panel never renders. |

The editor sends `{ type: 'state', effect, plugin, time, params, values, data }`
on `ready` and after every document change (undo and redo too): `params` as
the plugin shows them, `values` the effect's stored values, `data` the
sequence data (`sequence`) and arbitrary-data params, base64. Each request gets
`{ type: 'reply', id, ok, error?, image? }`. Every edit is an ordinary engine
command: one undo entry, saved with the project, in the command log.

The `rings` panel reads its palette from the sequence data and applies an
edited one through the hidden **Set Palette** button (`#rrggbb` colours as the
payload).

## Plugins that are not effects (SDK 1.2, P7)

After Effects has three plugin classes besides effects: AEGP (menu commands
that edit the project), AEIO (footage formats the app cannot read) and output
modules (formats the Render Queue writes), and AEGP plugins also dock panels.
Premation has all four. A bundle may list any of them in its manifest, with
or without effects (`effects` may then be empty or absent; docs/PLUGIN_STORE.md
§1 has the keys), and the module hands their entry points over in
`PrPluginInfo`'s SDK 1.2 trailing fields:

```c
const PrCommandEntry kCommands[] = {{"distribute", &distribute_main}};
const PrPluginInfo kInfo = {sizeof(PrPluginInfo), PR_SDK_VERSION, "com.example.tools",
                            0, NULL,            /* effects */
                            1, kCommands,       /* SDK 1.2: commands (pr_command.h) */
                            0, NULL,            /* importers (pr_io.h) */
                            0, NULL};           /* output modules (pr_io.h) */
```

A 1.0 / 1.1 module's struct ends at `effects` and keeps loading: the host reads
the new fields only when `struct_size` covers them. A manifest entry without
its entry point (or the other way round) fails the plugin before it is used.
A disabled, failed, quarantined or locked plugin contributes nothing: its
commands leave the Plugins menu, its formats the import picker and the
Render Queue, its panels the dock.

| | AE | Premation | Header | Sample |
|---|---|---|---|---|
| Command | AEGP `AEGP_InsertMenuCommand` + command hook | manifest `commands`, `PrCommandEntry` | `pr_command.h` | `distribute` (Distribute Layers) |
| Importer | AEIO `AEIO_GetInSpecInfo`, `AEIO_DrawSparseFrame` | manifest `importers`, `PrImporterEntry` | `pr_io.h` | `ppmio` (.ppm / .pfm) |
| Output module | AEIO output (`AEIO_StartAdding`, `AEIO_AddFrame`, `AEIO_EndAdding`) | manifest `outputModules`, `PrOutputModuleEntry` | `pr_io.h` | `ppmseq` (a .ppm sequence) |
| Panel | AEGP panels (`AEGP_RegisterCreatePanelHook`) | manifest `panels` (no code: an HTML page) | — | `statspanel` (Layer Stats) |

### Commands (`pr_command.h`)

A command is one selector, `PR_COMMAND_RUN`, with a `PrCommandContext`: the
active composition, the selected layers (top first), the playhead (comp time,
ticks), the composition's frame rate and `args_json` (runPluginCommand's
`args`). It reads and edits the document through the **engine API** — the
same API the editor speaks — as JSON, through `PrCommandSuite`:

```c
const char* json; uint32_t len;
ctx->engine->engine_query(ctx->host_ref, "{\"type\":\"getComposition\",\"comp\":\"comp_1\"}", &json, &len);
ctx->engine->engine_command(ctx->host_ref,
    "{\"type\":\"setProperty\",\"prop\":{\"layer\":\"l2\",\"path\":\"transform/position\"},"
    "\"value\":{\"kind\":\"vec2\",\"value\":{\"x\":100,\"y\":50}},\"time\":0}", &json, &len);
```

- The JSON is the API's TypeScript object form (packages/engine-api types):
  flat unions (Command, Query and their results) carry `type`; other unions
  `kind` and `value`; enums their names; bytes base64; times integer ticks.
  The engine translates it with the schema itself (`api_schema.inc`, generated
  with the codec), so every query and edit command the schema has is there.
- A result is host-owned JSON, valid until RUN returns. An engine error answers
  `PR_ERR_INVALID_PARAM` (`PR_ERR_NOT_FOUND` for `notFound`) with
  `{"code": "…", "message": "…"}`.
- Only **edit** commands: no undo / redo, open / save, transport, jobs, or
  another runPluginCommand.
- **One invocation = one undo entry**, labelled with the command's name, origin
  `plugin`. Every edit lands in the request's journal as it is made (the next
  query sees it). If RUN returns an error, or any edit failed, or the plugin
  crashes, **all** of it rolls back. The command log keeps the edits the plugin
  made (a batch, `LogRecord.job` = `plugin:<id>/<command>`), never the
  runPluginCommand, so a crash replay does not run the plugin again.
- It runs in premation-engine on the core thread, under the crash guard, the
  crash journal and the watchdog. A crash rolls back, the command is off for the
  session (listed `enabled: false` with why) and `setPluginEnabled(true)`
  re-arms it; a hang quarantines the plugin and restarts the engine.
- The editor: the **Plugins** menu (a submenu per manifest `menu`), the command
  palette ("Plugins: Distribute Layers"; Customize can bind a shortcut), and
  `runPluginCommand` from anywhere else (a plugin panel's `command`). The engine API:
  `listPluginCommands`, `runPluginCommand`.

### Importers (`pr_io.h`)

Files with an importer's extensions import and render through the plugin
instead of the engine's decoders:

| Selector | In | Out |
|---|---|---|
| `PR_IMPORT_PROBE` | `path` | `info`: size, `frame_rate` and `duration` (0 = a still), `has_alpha`, `linear`, `pixel_format`, audio format, `codec` |
| `PR_IMPORT_OPEN` | `path` | `file_data` (a handle the plugin owns) |
| `PR_IMPORT_READ_FRAME` | `time` (source time) | `frame`: a host world of `info.width × info.height` at `info.pixel_format` — straight RGBA, display-encoded unless `linear` |
| `PR_IMPORT_READ_AUDIO` | `audio_start`, `audio_frames` | `audio` (interleaved float32), `audio_frames_read` |
| `PR_IMPORT_CLOSE` | `file_data` | — |

- `importFiles` probes through the plugin (the Project panel shows its size,
  rate and codec); the media picker offers the extensions; Collect Files,
  Relink and Remove Unused treat the item like any footage.
- The texture feed reads frames through it (premultiplied there, encoded to
  sRGB when `linear`), cached by file, modification time and source time; at
  most 16 files stay open.
- A file the plugin refuses fails the import with "plugin failed to read …"
  (`io`). A failure at render time draws nothing for that layer and names it on
  `layerErrors`; the frame renders. A crash turns the importer off for the
  session (every read then fails with why) until the plugin is enabled again.
- Sound (`has_audio`, `READ_AUDIO`): the engine's audio decoders ask the
  plugin first (audio/external_audio.hpp), so the item's sound goes through
  the same down-mix and resampler as a decoded file — it plays in the
  playback mixer, is in the export mix (and an output module's
  `WRITE_AUDIO`) and is what the audio jobs analyse. A file with
  `width = height = 0` and `has_audio` is sound only (an audio item).
- Analysis jobs (tracker, stabilizer, scene detection, roto, …) read the
  item's frames through the importer too (jobs/media_input.cpp
  `open_plugin_frames`). The jobs that run in a child process (Object
  Matte, the face tracker; jobs/child_job.hpp) start a plugin host of their
  own from the engine's plugin folders, revocation list and entitlement
  token, with every plugin the engine does not run at that moment
  (disabled, quarantined, failed, revoked, locked, or with an importer that
  crashed this session) listed disabled: the same importer, the same frames,
  and no plugin code the engine would not run. A plugin crash there fails
  that job only.
- A job on footage whose importer's plugin does not run fails with why
  ("plugin failed to read 'x.ppm': plugin '…' is disabled"), rather than
  reading the file through another decoder.
- The `ppmio` sample reads a PPM holding several images back to back as
  moving footage (30 fps, or `# fps <n>` in the first header) and a second
  format, `.praw` (`PRAW <rate> <channels>` + interleaved float32), that is
  sound only.

### Output modules (`pr_io.h`)

An output module is an export format: `plugin:<plugin id>/<module id>` in the
Export dialog's **Plugins** category and in the Render Queue, with its declared
`options` drawn as controls (popup — the value a 1-based index —, number with
`min` / `max`, checkbox).

| Selector | What the module gets |
|---|---|
| `PR_OUTPUT_BEGIN` | `path` (what the user chose), size, frame rate, frame count, audio format (0 channels = none), `options_json` (`{ "<id>": value }`, defaults filled, clamped) → `job_data` |
| `PR_OUTPUT_WRITE_FRAME` | `frame_index` (0-based), `time`, `frame`: RGBA32F, straight alpha, display-encoded (the output space) — in order |
| `PR_OUTPUT_WRITE_AUDIO` | the mix, interleaved float32, after the frames |
| `PR_OUTPUT_END` | `cancelled` = 1 when the job did not finish |

The `ppmseq` sample writes `shot.wav` (32-bit float) beside `shot_00000.ppm` …
when the export carries sound.

The export job (`premation-engine --export`, job fields `sequence:
"plugin:…"`, `pluginPath`, `pluginOptions`) runs the module in its own
process with its own plugin host; the module writes its files itself (nothing
is moved afterwards). A crash or an error fails that job with the module's
message; the editor and the engine carry on.

### Panels (manifest `panels`)

A dockable panel with no effect behind it: `{ "id", "name", "page" }` shows
`ui/<page>` from the bundle in the P5 sandbox (`plugin-ui://<id>/<page>`,
`sandbox="allow-scripts"`, no Node, no storage, no network). The Plugins menu
▸ Panels opens it; it docks like any on-demand panel and pops out into its
own window (the window's route carries the id encoded, `#/popout/plugin%3A…%2F<panel>`). It talks to
the editor by `window.parent.postMessage({ premation: 1, … }, '*')`:

| Panel sends | What happens |
|---|---|
| `{ type: 'ready' }` | the editor answers `context` |
| `{ id, type: 'query', request }` | the engine API query (`{ type: 'getComposition', comp }`); the reply's `result` is its answer |
| `{ id, type: 'command', request, label? }` | one EDIT command, origin `plugin`: one undo entry (a `runPluginCommand` runs the plugin's own command) |
| `{ id, type: 'command', commands: [...], label }` | several edits as ONE undo entry |

The editor sends `{ type: 'context', plugin, comp, layers, time }` on `ready`
and after every document change (undo and redo too), selection or time change,
and `{ type: 'reply', id, ok, result?, error? }` to each request. Requests over
1 MiB, non-edit commands (undo, save, transport, jobs) and unknown types are
refused with an error reply; nothing changes.

## Sequence data

Per-instance state lives **in the document**, not only in the process:

- `addEffect` runs SEQUENCE_SETUP → FLATTEN → SETDOWN and stores the flat bytes
  with the effect, in the same undo entry.
- A render rebuilds the instance from those bytes (RESETUP) whenever they change.
- A button (`USER_CHANGED_PARAM`) produces new bytes plus param writes as **one**
  undo entry. Undo brings back the old bytes, and the old bytes render the old
  picture.

This is how `rings` keeps its palette: shuffle, undo and redo all render exactly.

## GPU (`pr_gpu.h`)

A `GPU_RENDER` effect records WebGPU commands into the **host's** command
encoder, on the engine's own Dawn device:

- The input is the chain's texture as is; the output is a texture the host owns
  (render attachment, storage, sampled, copy). Nothing is copied or read back.
- Call WebGPU through `device->procs` (Dawn's `DawnProcTable`). Never link a
  second copy of Dawn.
- The call runs inside a crash guard **and** a validation + out-of-memory error
  scope. A GPU error drops the command buffer unsubmitted, and the effect renders
  on its CPU path for that frame.
- `GPU_DEVICE_SETUP` runs once per device. If it fails, the effect uses its CPU
  path on that device. When the engine's device changes (a new renderer, a
  recovered device loss), the host sends `GPU_DEVICE_SETDOWN` for the old one
  first and sets up again on the next frame.
- Keep the GPU and CPU paths the same maths. At 16 bpc they can still differ on
  over-range values: the CPU world is integer 0..32768 and clips, the GPU buffer
  is half float and does not. `grade`'s *Debug ▸ GPU Fault* records invalid
  commands, so you can watch the error scope and the CPU fallback work
  (`engine_plugins_gpu_tests`).
- `premation-render --plugins <dir> [--plugin-gpu 0]` renders a FrameScene with
  native plugin entries outside the editor. Use `--plugin-gpu 0` to force the
  CPU path.

## Crash isolation

Every selector call runs through a guard (`guard_ffi.cpp`: SEH on Windows;
SIGSEGV/SIGBUS/SIGFPE/SIGILL on an alternate stack on POSIX) and the crash journal:

| What the plugin does | What happens |
|---|---|
| access violation, divide by zero, stack overflow*, illegal instruction, a C++ exception, in a render selector | That **instance** is disabled: the layer renders as if the effect were off, and the failure is on `layerErrors`. The process, the frame and every other layer and instance continue. |
| the same in setup, params or sequence selectors | The **plugin** fails to load; it is listed as `failed` with the reason |
| returns an error | The call fails and the frame renders without it; the instance stays enabled |
| hangs (longer than the watchdog, default 10 s) | The plugin is quarantined in the journal and the engine ends; the supervisor restarts it and replays the document |
| `abort()`, `exit()`, heap corruption that does not fault | The engine dies. The journal's in-flight slot survives in the mapped file, and the next start **quarantines** the plugin (AE's "this plugin crashed last time") |

\* On POSIX a stack overflow is reported as an access violation (both are SIGSEGV).

A quarantined plugin is listed but not loaded. `setPluginEnabled(true)` retries
it and clears the quarantine.

## Engine API

| | |
|---|---|
| `listPlugins` | every plugin found: loaded / disabled / failed (with why) / quarantined |
| `listEffects` | plugin effects beside the builtins, `provider` = the plugin id |
| `addEffect` | a plugin effect by match name (its initial sequence data lands in the same entry); a disabled plugin's effect is `notFound` |
| `invokeEffectAction` | a button or supervised param change: one undo entry |
| `getEffectUi` | the param UI state (UPDATE_PARAMS_UI) at a time |
| `setPluginEnabled` | enable / disable for this session; re-enabling retries a failed or quarantined plugin |
| `setPluginData` | write a plugin's document data (arbitrary-data params) |
| `listPluginCommands` / `runPluginCommand` | SDK 1.2 commands (see "Commands"): one undo entry per run |
| `PluginInfo.commands` / `importers` / `outputModules` / `panels` | what a plugin contributes besides effects, from its manifest |

The C++ engine is the only engine (the TypeScript one is deleted), so these
queries always answer from `premation-engine`. Native plugins render in the
engine viewport and in `premation-plugins` today. The editor surfaces that
expose them — installing from the plugin store, the Effects panel and Add
menu, the Properties effect cards built from `EffectInfo.params`, and export
with plugins — are AE parity step 2 (docs/AE_PARITY_PLAN.md). A project whose
plugin is missing keeps the effect untouched: it passes through, is recorded
on `layerErrors`, and one notice names the missing plugin
(`src/core/project/missingPluginContent.ts`).

## Distributing a plugin

Plugins are distributed through the plugin store (docs/PLUGIN_STORE.md): free,
public or private (private installs only for its publisher), and installed by
the editor with a signature check and no restart.

1. Build against the SDK from a release (`premation-sdk-<platform>.zip`):
   `find_package(PremationSdk)` and `premation_add_plugin(name SOURCES …
   MANIFEST premation-plugin.json)` lay the bundle out under
   `<build>/plugins/<name>/`.
2. List platform-specific binaries under `binary` with the keys
   `windows-x64`, `macos-universal` (or `macos-arm64` / `macos-x64`),
   `linux-x64` (the plain `windows` / `macos` / `linux` keys still work).
3. `node pack-plugin.mjs <bundle> --key plugin-key.json` (keygen once with
   `sign-plugin.mjs keygen`, and keep the key: it is the only thing that can
   ship an update) → `<id>-<version>.pplugin` (signed inside, so users can
   double-click it to install) and its detached `.sig` (for the store).
4. Publish from the editor (Dashboard ▸ Plugins ▸ Publish) or with
   `sign-plugin.mjs publish`. Public needs a verified publisher.

`examples/plugin-ci/` does all of this in GitHub Actions for three platforms.

## Building an Element 3D class plugin

The `model3d` sample (`native/sdk/samples/model3d`, open source) is the
walkthrough: a glTF model drawn through the comp camera and lights, anywhere in
the frame, with motion blur and occlusion by the comp's 3D layers, on the GPU
and on the CPU. What it does, step by step, and the After Effects call each
step replaces:

| Step | Premation | After Effects |
|---|---|---|
| Draw on a solid of any size, anywhere in the frame | `PR_OUT_FLAG_COMP_SPACE`; project with `PrInData.comp_to_world` | `PF_OutFlag_I_EXPAND_BUFFER`, `result_rect` = the comp |
| Load the model | a `FILE` param (`file_types` `"glb\|gltf"`), `get_asset_bytes`; a `.gltf`'s `.bin` through `get_asset_sibling_bytes` | the plugin opens the path itself |
| Textures | a `FILE` image param through `get_asset_image_gpu` / `get_asset_image` (decoded by the engine, linear premultiplied); a `LAYER` param through `checkout_layer_gpu` / `checkout_layer_pixels` | `PF_CHECKOUT_PARAM` on a layer param; the plugin's own image loaders |
| Camera and lights | `PR_OUT_FLAG_USES_CAMERA` / `_USES_LIGHTS`; `get_comp_camera`, `get_comp_lights` | `AEGP_GetEffectCamera`, the light suites |
| Follow a layer | a `LAYER` param, `PR_OUT_FLAG_USES_LAYER_TRANSFORMS`, `get_layer_transform` | `AEGP_GetLayerToWorldXform` |
| Render on the GPU | `PR_OUT_FLAG_GPU_RENDER`, `SMART_RENDER_GPU`: your own pipelines and depth buffer on the engine's Dawn device, through `device->procs` | the GPU suites (`PF_GPUDeviceSuite`) |
| Motion blur | `PR_OUT_FLAG_USES_SHUTTER` + `PR_OUT_FLAG_SAMPLES_TIME`: `checkout_time` at the shutter's sub-times with `PR_SAMPLE_PARAMS \| _CAMERA \| _LAYER_TRANSFORMS`, one render per sample, averaged | `PF_OutFlag2_I_USE_SHUTTER_ANGLE`, `PF_CHECKOUT_PARAM` at other times |
| Occlusion by the comp's 3D layers | `PR_OUT_FLAG_USES_SCENE_DEPTH`, `checkout_scene_depth_gpu` / `checkout_scene_depth` | none: E3D renders the comp's layers itself |
| A handle in the viewer | `PR_OUT_FLAG_CUSTOM_OVERLAY`: `DRAW_OVERLAY` / `OVERLAY_DRAG` | `PF_Cmd_EVENT` |
| A setup panel | `ui/index.html`, the `setParam` / `requestPreview` messages | E3D's Scene Setup window |
| Works without a GPU | `SMART_RENDER`: the same maths on the CPU | the CPU render path |

**1. Flags and params.** `GLOBAL_SETUP` declares `SMART_RENDER | GENERATOR |
GPU_RENDER | USES_CAMERA | USES_LIGHTS | USES_LAYER_TRANSFORMS | SAMPLES_TIME |
USES_SHUTTER | COMP_SPACE | USES_SCENE_DEPTH | CUSTOM_OVERLAY`. The params:
Model (`FILE`), Position (`POINT_3D`, comp world px), X / Y / Z Rotation,
Size (the model's largest extent in px), Transform Layer (`LAYER`), a Material
group (Base Color, Roughness, Specular, Base Color Map, Texture Layer),
Composite with Scene Depth, Motion Blur, Render Mode (Shaded / Scene Depth) and
the samples' Debug group. Keep param ids stable: the document stores values by
them, and the panel addresses them as `p<id>`.

**2. The model.** `gltf_lite.hpp` reads `.glb` and `.gltf` (+ `.bin` through
`get_asset_sibling_bytes`, or a `data:` URI): triangle primitives, the node
hierarchy, positions, normals, uvs, indices and the first material's
`baseColorFactor`. Parse once per file content (the sample keys a cache by the
bytes' hash) — never per frame. No model chosen: a built-in cube. A chosen file
that is missing or unreadable returns `PR_ERR_NOT_FOUND` with the reason in
`return_msg`: the host records it on `layerErrors` and the frame renders, and
the instance stays enabled (an error return is not a fault).

**3. Space.** World space is After Effects' (px, +y down, +z away). glTF is +y
up and +z toward the viewer, so the model is turned 180° about x, centred on its
bounds and scaled to Size. A vertex goes model → world (the placement: Position
× rotations × size, or the Transform Layer's matrix) → camera
(`PrCamera.view`) → comp px (`PrCamera.projection`, divide by w) → world px
(`comp_to_world`). On the GPU the last two are one matrix: comp_to_world and
the NDC mapping lifted to act on homogeneous x, y, w. Depth is camera-space z
everywhere — the same unit as the scene depth, so the occlusion test is one
comparison.

**4. Shading.** Lambert diffuse + Blinn-Phong specular (shininess from
Roughness), two-sided, over up to 8 comp lights: ambient adds `albedo ×
colour × intensity`, parallel lights along `direction`, point lights from
`position`, spot lights with a smoothstep over the cone and feather. With no
light in the comp a headlight from the camera keeps the model readable (AE lights
unlit layers fully). The WGSL and the C++ are the same function, line for line.

**5. The GPU path.** `GPU_DEVICE_SETUP` builds one WGSL module, an explicit bind
group layout (every texture `unfilterable-float` and read with `textureLoad`:
the `rgba32float` maps and the `r32float` depth are not filterable without a
device feature), a mesh pipeline into an `rgba16float` sample target with its
own `depth32float` buffer, an additive accumulation pipeline, and an output
pipeline per `PrGpuFormat`. `SMART_RENDER_GPU` uploads the model once per
content, writes one uniform slot per shutter sample, and records into the host's
encoder: per sample, the mesh pass then an additive pass (× 1/N) into the
accumulation; then the accumulation into the output. Never submit; never keep
the encoder. A GPU error is caught by the host's error scope and the frame
renders on the CPU path.

**6. Motion blur.** In `SMART_PRE_RENDER`, when `PrInData.motion_blur` is 1 and
`shutter_angle` > 0, call `checkout_time` for N = `motion_blur_samples`
(clamped to 2..16) sample times centred across `shutter_phase … shutter_phase +
shutter_angle`. In the render, read the camera (`get_comp_camera`), the
placement params (`checkout_param`) and the Transform Layer
(`get_layer_transform`) at each time; a time the host did not evaluate answers
`PR_ERR_NOT_FOUND` — skip that sample, never fail the frame. Lights are read at
the frame time.

**7. Scene depth.** With Composite with Scene Depth on, call
`checkout_scene_depth_gpu` and discard a fragment whose camera z is behind the
depth at its pixel (`z > depth + 0.5 + 0.001 z`: a small bias, so a model sitting
exactly on a card does not flicker). `PR_ERR_UNSUPPORTED` (no GPU): render
unoccluded. The CPU path does the same with `checkout_scene_depth`.

**8. Viewer handle and panel.** `DRAW_OVERLAY` draws a box and a crosshair handle
at Position; `OVERLAY_DRAG` writes Position's x / y (z kept) with
`set_param_value` — the whole drag is one undo entry. The overlay is drawn
without the camera (the scene callbacks answer in render selectors only), so
the handle sits at Position's x / y: exactly over the model under the comp's
default camera on a comp-sized layer at the comp's origin, offset when a camera
layer looks from elsewhere — a known limit. The panel (`ui/`) sets Base Color,
Roughness, Specular and the depth checkbox with `setParam` and shows a
`requestPreview`.

**9. The CPU path.** `SMART_RENDER` runs the same transform and shading in a
small rasteriser: per output row (`iterate`), every triangle over that row,
perspective-correct barycentrics, a z-buffer in camera z, nearest texels. It is
lower quality — no near-plane clipping (a triangle reaching behind the eye is
dropped), no filtering — but a machine without a GPU still gets the frame.

**10. Tests.** `engine_plugins_tests` (`tests/test_plugin_model3d.cpp`): the cube
through the camera, `.glb` and `.gltf` + `.bin` giving the same picture, a missing
model as a layer error, CPU occlusion against a depth, the Debug ▸ Fault popup in a
child process. `engine_plugins_gpu_tests`: the scene depth's values (camera z, +inf,
the effect's own layer excluded, one pass per frame), GPU vs CPU coverage, and
occlusion on both paths. Golden scenes (`packages/render-tests`):
`plugin-model3d-orbit` (camera orbit, a checker Base Color Map, point + ambient
light), `plugin-model3d-blur` (the sample's own motion blur under a camera pan),
`plugin-model3d-occlusion` (a 3D card in front of the model).
`models/make_models.mjs` regenerates the test assets (a 2 × 1 × 1 box as `.glb`
and as `.gltf` + `.bin`, an 8 × 8 checker), all made for the sample.

## Building and testing a plugin

```sh
# the samples build with the engine (native/sdk/CMakeLists.txt): <build>/plugins/<name>/
cmake --preset linux-clang-engine && cmake --build --preset linux-clang-engine
premation-plugins --plugins build/linux-clang-engine/plugins list
premation-plugins --plugins build/linux-clang-engine/plugins --bits 32 render com.premation.samples.ripple
premation-plugins --plugins build/linux-clang-engine/plugins crash-check com.premation.samples.ripple 2   # 2 = access violation
```

Each sample has a **Debug ▸ Fault** popup that injects each fault class. The
host tests use it to prove every isolation row above in a child process.
