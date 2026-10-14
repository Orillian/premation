# The camera, end to end

**Audience:** an agent or engineer with no prior context who has to reason about,
drive, or extend the camera, and who may need to answer "how does this compare
to After Effects?" without opening AE.

**Last checked against source: 2026-10-14** (after the camera program,
`docs/PROGRAM_CAMERA.md`). When this file and the code disagree, the code
decides. Every claim names the file it came from so it can be re-verified.

The engine is the C++ `premation-engine` process (`docs/NATIVE_CORE_PLAN.md`).
The page does not evaluate cameras; it writes camera props through the engine
API and reads the document mirror. TypeScript files named below are either UI
(commands, Inspector, dialogs) or pure helpers the C++ port was made from and
is pinned against (`tests/data/threed_parity.json`).

---

## 1. The shape of it, in one paragraph

A camera is an ordinary layer: a node of kind `camera` whose Transform
component carries extra numeric props (§2.1). It is keyframed by the same
animation engine, parented by the same parent chain, trimmed by the same clip
bar and inspected by the same property rows as any layer. At render time the
engine resolves the one active camera into a plain `motion::xf::Camera` (eye,
focal length, principal point, optional orientation) and projects every
3D-enabled layer through it. 3D layers are oriented planes plus real meshes
(extrusions, primitives, imported models, depth-parallax grids); the camera
model is After Effects'.

---

## 2. Data model

### 2.1 Where the numbers live

All camera props are scalars on the node's **Transform component**: no
matrices, no nested objects, so every generic mechanism (keyframes,
expressions, save/load, timeline tree) works on them unchanged. A prop at its
neutral value is not stored, so a project that never touched a feature renders
byte-identically.

| Prop | Unit | Meaning | AE name |
|---|---|---|---|
| `x`, `y`, `z` | comp px | Eye position. `z` is negative when pulled back from the comp plane. | Position |
| `focalLength` | comp px | Distance from eye to the plane that renders 1:1. | Zoom |
| `filmSize` | mm | Virtual sensor width. Label only (§4.2). | Film Size |
| `orbitYaw`, `orbitPitch` | deg | Swing about the point of interest ("Orbit around target"). Pitch clamped ±89. | (orbit tool) |
| `orientationX/Y/Z` | deg | In-place tilt / pan / roll ("Turn on the spot"). | X / Y / Z Rotation |
| `poiX/Y/Z` | comp px | Point of Interest. ANY of the three makes it a two-node camera. | Point of Interest |
| `dofStrength` | px | Maximum defocus. 0 / absent = DOF off. | Blur Level |
| `focusDistance` | px | Distance that is sharp. | Focus Distance |
| `dofAperture` | px | Slope of the Classic blur ramp. | Aperture |
| `fStop` | — | Present = the Physical (thin-lens) model; absent = Classic. | F-Stop |
| `irisBlades` … `diffractionFringe` | — | Bokeh shape and highlights (§7). | Iris / Highlight options |
| `shakeAmount` | px | Procedural shake: eye offset. 0 / absent = no shake. | (Wiggle rig) |
| `shakeRotation` | deg | Procedural shake: turn. | — |
| `shakeFrequency` | Hz | Shake rate, default 2. | — |
| `shakeSeed` | int | Shake pattern. | — |

Auto-Orient lives on the layer's `fx` component (`autoOrient`: `off` / `path`
/ `camera`; `src/core/scene/autoOrient.ts`).

### 2.2 One-node vs two-node cameras

The engine branches on one test (`motion::xf::camera_from_props`,
`native/libs/motion_transform/transform.cpp`): any of `poiX/Y/Z` present.

- **One-node (free).** No POI. Orbit swings the eye about the comp centre. It
  turns with a rotating parent (§2.3) and can Auto-Orient Along Path (§4.5).
- **Two-node (targeted).** POI present. The eye orbits the POI and then
  always re-aims at it (`look_at_orientation`). Choosing Orient Along Path
  drops the POI in the same command (AE's exclusivity).

### 2.3 The camera is a layer, so it has a parent

The parent chain lifts both the eye and the POI into world space (lifting only
the eye would slide the shot off its subject as the rig moves). Since the
camera program a **one-node camera also turns with its parents' rotation**
(`rotate_camera_with_parent`, `native/engine/src/core/worldxf.cpp`; scale and
shear normalised away; byte-identical when no parent rotates), which is what
makes a Swing / Pan rig null work on a free camera. A two-node camera keeps
aiming at its lifted POI.

---

## 3. Which camera is active

`Scene3D::view_camera_node` (`native/engine/src/scene/threed_port.cpp`) is the
rule, matching AE: the **topmost** camera that is **enabled** and **live at
this time** (clip bar), scoped to the composition being rendered. A
composition layer can override it with `fx.viewCamera` (a camera layer id in
the nested comp; `comp_instance.cpp`), which the Stereo 3D rig uses to give
each eye comp its own camera (§9). DOF, scene-depth focus and camera motion
blur read the same node, so they can never come from a different camera than
the one projecting.

---

## 4. The projection and the camera evaluation

### 4.1 The pinhole divide

```
dist   = p.z - cam.position.z          // > 0 when in front of the camera
scale  = cam.focalLength / max(dist, NEAR)
screen = cam.principal + (p.xy - cam.position.xy) * scale
```

- The camera looks down **+z** at the comp plane `z = 0`; comp space is
  **y-down**. The default camera sits at `z = -focalLength`, so a layer at
  `z = 0` renders at scale 1.
- The principal point does not track the camera (otherwise X/Y panning cancels
  at `z = 0`).
- `NEAR = 1` is a clamp, not a reject: a clamped point is flagged `clipped`,
  and geometry callers drop the layer.

The maths lives once in `motion_transform` (C++). Its TypeScript twin
`packages/scene/src/utils/project3d.ts` serves UI overlays and gizmos and is
pinned to the C++ by the parity fixture.

### 4.2 Zoom, angle of view, film size, lens list

Zoom and Angle of View are two views of one value (exact inverses). Film size
only converts the angle of view into a millimetre reading, as a real sensor
label does. **One lens list** (`src/core/scene/lensPresets.ts`, mm: 15 20 24 28
35 50 80 135 200) feeds the Inspector's Shot header and the New Camera dialog;
an off-list zoom reads "Custom · n mm".

### 4.3 Order of evaluation

`camera_from_node` (`worldxf.cpp` for queries/expressions; its render twin
`Scene3D::camera_from_node` in `threed_port.cpp`) builds the view in this
order; each step is identity at its neutral value:

1. **Base aim**: orbit angles on a one-node camera, `look_at(eye, poi)` on a
   two-node one; `orientationY` / `orientationX` added as offsets (so a
   targeted camera can be turned off its subject and keep tracking);
   `orientationZ` as roll, applied last so it spins the frame.
2. **Parent**: eye and POI lifted; a one-node camera's view rotated (§2.3).
3. **Auto-Orient Along Path** (one-node only, §4.5).
4. **Shake** (§4.6), after the aim, so a POI or path never cancels it.

World → camera is `Rz(−roll) · Rx(−pitch) · Ry(−yaw) · T(−eye)`.

### 4.4 Orbit

`orbitCamera(base, poi, yaw, pitch)` keeps the eye's distance from the POI,
swings it, and returns the orientation that keeps the POI centred. The
Inspector labels the two rotation families "Orbit around target" and "Turn on
the spot"; the Orbit tool's tooltip names which it writes.

### 4.5 Auto-Orient Along Path (R3b)

`camera_path_direction` (`worldxf.cpp`): the world direction of travel of the
position tracks at the camera's key time (forward difference over 1/120 s,
backward at the last key, end tangents held outside the keyed span, as AE).
The camera looks along it with its own X/Y/Z Rotation composed on top. Not
moving, or two-node, = no change. The Auto-Orient dialog offers it for cameras
(`AUTO_ORIENT_DEAD_KINDS` no longer contains `camera`).

### 4.6 Procedural shake (R1)

`apply_camera_shake` (`transform.cpp`): per channel, seeded value noise
(splitmix64 lattice, quintic fade), two fixed octaves at 1× and 2.17× (half
weight). `shakeAmount` moves the eye along its own right / down / forward axes
(forward at half weight); `shakeRotation` adds yaw / pitch / half-weight roll.
Time is the camera's own key time × `shakeFrequency`. Pure in (seed, time), so
renders are deterministic and export matches preview. A shaking camera counts
as animated for camera motion blur. UI: the "Shake" twirl
(`src/layout/Inspector/CameraShakeRows.tsx`); the Handheld preset now sets
shake instead of baking keys (the old preset id still works,
`src/core/animation/cameraPresets.ts`).

---

## 5. Views: what you are looking through

| Mode | Projection | Reads the scene camera? | Writes to the scene? |
|---|---|---|---|
| Active Camera / a named camera | Perspective | Yes | Yes: nav writes camera props |
| Front / Back / Left / Right / Top / Bottom | Orthographic | No | Never |
| Custom View 1–3 | Perspective, from stored view params | No | No: writes the view's params |

Custom views store `{yaw, pitch, distance, poi}` in `guidesStore`
(`src/core/workspace/customViews.ts`) and never move the shot camera; orbiting
an axis view promotes it to Custom View 1. 1 / 2 / 4-view layouts as in AE.

While a camera tool is armed or Alt is held, the viewport shows what a drag
edits (`CameraNavBadge`): "Camera 1 · moves the shot" (+ "· keyframing" when
the property is animated or Auto-Keyframe is on), or "Custom View 1 · preview
only".

---

## 6. Navigation

`src/core/workspace/cameraNav.ts` is the one home for orbit / track / dolly
writes. Alt+drag orbits, Shift+Alt+drag (or Alt+middle-drag) tracks XY,
Alt+wheel dollies; the C-key tool cycles Unified → Orbit → Pan → Dolly (Unified
maps left / middle / right to orbit / track / dolly). Orbit pivots: Around
Cursor / Scene / Camera POI (`guidesStore.cameraOrbitPivot`).

| Gesture | Writes |
|---|---|
| Orbit | `orbitYaw += dx·0.4`, `orbitPitch += dy·0.4` |
| Track XY | `x`, `y` and the POI with them (framing follows the cursor) |
| Dolly | `z -= delta·2` |

Nav writes are keyframe-aware (static base + a key when animated or
Auto-Keyframe is on) and one gesture is one undo entry. A camera moves only
3D layers, so with none the Shot header leads with "No 3D layers" and a
one-click Make All 3D (`describeNavUnavailable()` gives the next step).

---

## 7. Depth of field

Rows (camera program U5): On/Off · Focus Distance (with a crosshair that arms
a one-shot pick on the canvas, `focusPickStore` → `setFocusDistanceToLayer`) ·
Lens Model **Classic | Physical** · F-Stop (Physical) · Blur Level · ▶ Bokeh
(iris and highlight rows) · ▶ Advanced (Aperture).

- **Classic:** `blur = min(strength, |depth − focus| / max(1, focus) · aperture)`.
- **Physical:** the thin-lens circle of confusion from `fStop` and the zoom
  (`dof_blur_px`, `native/engine/src/scene/camera3d_port.cpp`).

3D depth groups render into a colour + depth pair and run the `dof-gather`
pass (`native/engine/src/render_graph/threed.cpp`): per-pixel CoC from the real
depth buffer. Layers off the depth path use per-corner CoC across their own
quad (`plan_dof_coc_corners`). Polygonal bokeh and the highlight trio run in the
`bokeh` / `coc-blur` / `dof-gather` passes. DOF is off in orthographic and
custom views and under Draft 3D.

**Camera moves blur.** An animated (or shaking) active camera motion-blurs
every 3D layer: each sub-frame sample projects through the camera's pose at
that sample time (`Scene3D::matrix_at`, cached per sample time).

---

## 8. Shot-making tools

All of these are one undo entry each and go through the engine API.

| Tool | Where | Implementation |
|---|---|---|
| Shot header: lens, six camera moves (Push In, Pull Out, Orbit Sweep, Drift Parallax, Dolly Zoom, Handheld), Focus on Layer, Distribute in Z, Create Orbit Null, Fly to Layers, Add Rig | top of the camera Inspector | `src/layout/Inspector/CameraShotHeader.tsx` |
| New Camera dialog: lens, live angle of view, Aim at a target / Free, Make all layers 3D | Layer ▸ New ▸ Camera | `src/layout/Workspace/SceneInsertDialogs.tsx` |
| Camera rigs: Crane (Base → Boom → Arm), Dolly (Track → Pedestal), Orbit (Pivot → Arm) as `Rig · <Kind> · <Control>` 3D nulls; Inspector sliders Truck / Pedestal / Dolly / Boom / Swing / Arm / Pan / Tilt | Layer ▸ Camera ▸ Add Camera Rig | `src/core/scene/cameraRig.ts`, `CameraRigSection.tsx` |
| Follow Path: a shape path or mask → Position keys with spatial tangents, roving middle keys, timed by arc length | Layer ▸ Camera ▸ Follow Path… | `src/core/scene/cameraFollowPath.ts` |
| Fly to Selected Layers: travel / hold per layer in selection order, framed with `framingFor` | Layer ▸ Camera ▸ Fly to Selected Layers… | `src/core/scene/cameraFlyTo.ts` |
| Shake | camera Inspector ▸ Shake | §4.6 |
| Stereo 3D rig | Layer ▸ Camera ▸ Create Stereo 3D Rig | §9 |

---

## 9. Depth compositing, flares, parallax, stereo

**Scene depth for ordinary effects (D1).** An effect on an adjustment layer
above 3D layers can read the scene depth (`render_graph/scene_depth.cpp`, the
same depth SDK plugins sample):

- **Depth Matte**: keep pixels between Near and Far, Feather, Invert.
- **Depth Fog**: Fog Color, Start, End, Density, optional Gradient to a Far
  Color, Fog Background.
- **Depth Extract**: depth as greyscale between a Black Point (Near) and White
  Point (Far), Invert.
- **Camera Lens Blur ▸ Blur Map: Scene Depth**: focus from the active camera's
  Focus Distance (else its Zoom) when Focus From Camera is on, else Blur Focal
  Distance.

Shaders: `fx60-depth-matte.wgsl`, `fx60-depth-fog.wgsl`,
`fx60-depth-extract.wgsl`, `camera-lens-blur-depth.wgsl`. With no 3D layers
below, the effects see "infinitely far" and pass through.

**Lens flare linked to a 3D light (D2).** Lens Flare ▸ Link to Light: the
flare centre is the light's comp point through the active camera
(`snapshot_build.cpp`, placed by `effect_chain.cpp` through the visible world
rect, not the Centre X / Y offset); it fades out behind the camera
and dims where scene depth in front of the light's screen point is nearer than
the light (soft occlusion, `lens-flare-depth.wgsl`). A missing light is
recorded on `layerErrors` and the flare renders as authored.

**Photo → 3D parallax (D3).** Layer ▸ Camera ▸ Make 3D from Photo/Video…
(`src/layout/Menu/depthParallaxCommands.ts`, `src/core/scene/depthParallax.ts`):
the engine's `depthEstimate` job (`native/engine/src/jobs/kind_depth_estimate.cpp`,
Depth Anything V2 Small, ONNX Runtime via `depth_ort_ffi.cpp`) writes greyscale
depth PNGs (white = near) next to the project, once for a still and per source
frame for footage (an on-disk cache a re-run reuses), then sets the layer 3D,
`layer/depthSource` and `geometry/depthScale` in one entry. The model (99 MB,
Apache-2.0) is downloaded on first use from a pinned Hugging Face revision and
checked against a pinned SHA-256 (`electron/depthModel.ts`). Instead of the AI
estimate, the Depth Parallax Inspector section can use a depth-map layer
(hidden, it is data). The engine renders the layer as a camera-facing
displaced grid (`depth_parallax_mesh`, `threed_port.cpp`) with Depth Scale,
Edge Cut (stretch threshold) and Mesh Detail.

**Stereo 3D rig (D7).** Layer ▸ Camera ▸ Create Stereo 3D Rig
(`src/core/scene/stereoRig.ts`): a "Stereo Camera Controls" null (Interaxial
Separation, Convergence Of: Off / Camera POI / Z = 0, Convergence Z Offset,
Stereo Scene Depth), Left / Right cameras that follow the master by
expression, Left Eye / Right Eye comps that look through them (`fx.viewCamera`),
and a Stereo 3D output comp with 3D Glasses (anaglyph by default; side-by-side,
over-under, interlaced). The rig assumes an unparented master camera, as AE's
does.

---

## 10. Interchange and expressions

**Camera import (D4).** glTF / GLB perspective cameras (`yfov`, animated node
TRS) and FBX cameras (ufbx: focal length + film back, animation) import as
Premation camera layers alongside the model, converted through the model
importer's Y-up → comp-space basis (`model_convert.cpp`, `model_fbx_ffi.cpp`,
`src/core/scene/modelImport.ts`). AEP import maps camera options 1:1
(`aep_plan.cpp`).

**Camera export (D5).** Export Camera… (`src/core/scene/cameraExport.ts`)
samples the evaluated camera with the engine query `sampleCamera` (shake,
Auto-Orient, POI, parents and expressions included) per frame over the work
area and writes glTF 2.0 (an animated camera node, `yfov` from Zoom) or Nuke
`.chan` (`frame tx ty tz rx ry rz vfov`, ZXY). Conversion
(`src/core/scene/cameraInterchange.ts`): `C = diag(1, −1, −1)` about the comp
centre, 1 px = 1 cm (`PX_PER_UNIT = 100`, stored in
`asset.extras.premationPxPerUnit` so a Premation file comes back in place);
`yfov = 2·atan(h / 2 / f)`. Round-trip export → import is tested.

**Camera expressions (D6).** `motion_expr` (`native/libs/motion_expr`):
`thisComp.activeCamera`, a camera's `position` / `pointOfInterest` /
`cameraOption.zoom | focusDistance | aperture | blurLevel | depthOfField |
iris* | highlight*`, a light's `lightOption.intensity | color | coneAngle |
coneFeather | shadowDarkness | shadowDiffusion | falloffDistance | radius`,
`lookAt(from, to)`, `toCompVec`, `fromCompToSurface`, and the AE match names
(`ADBE Camera Zoom`, `ADBE Light Intensity`, …).

---

## 11. Comparison with After Effects

### 11.1 What matches

| Behaviour | Here | AE |
|---|---|---|
| Camera is a keyframeable layer; one- / two-node | Yes | Yes |
| Topmost enabled live camera wins | Yes | Yes |
| Follows its parent chain, one-node turns with the parent | Yes | Yes |
| Zoom ↔ Angle of View, Film Size as a label | Yes | Yes |
| Unified / Orbit / Track XY / Track Z tools, three orbit pivots | Yes | Yes |
| In-place X/Y/Z rotation on a targeted camera without losing tracking | Yes (offsets) | Yes |
| 1 / 2 / 4 views, six ortho views, three custom views | Yes | Yes |
| Auto-Orient Towards Camera / Along Path (cameras too) | Yes | Yes |
| DOF with Classic or physical F-Stop, iris and highlights | Yes, per-pixel on the depth path | Yes |
| Camera moves motion-blur the scene | Yes | Yes |
| Stereo 3D rig | Yes | Yes |
| Camera expressions (`activeCamera`, `cameraOption`, `lookAt`, …) | Yes | Yes |

### 11.2 Where Premation goes further

Procedural seeded shake, crane / dolly / orbit rigs with plain sliders,
Follow Path, Fly to Layers, depth matte / fog / extract and scene-depth lens
blur without plugins, light-linked flares, AI photo → 3D parallax, glTF / FBX
camera import and glTF / `.chan` export, and AI / MCP coverage of every camera
move (`add_camera_move`, §12).

### 11.3 Remaining gaps

- **Ray-traced renderer and VR / 360 output**: out of scope; each would be a
  program of its own.
- **Camera tracking.** The engine's tracking jobs solve a one-node camera from
  tracked planes; a full automatic-feature 3D camera tracker is still open.
- **One rotation set on cameras.** Layers have Orientation plus X/Y/Z
  Rotation; a camera has the single `orientationX/Y/Z` set, so an AE project
  that uses both groups on a camera does not round-trip that split.
- **Stereo rig with a parented master camera** is not supported (AE has the
  same limit).
- **Photo → 3D** fills edges by stretching, not inpainting; Edge Cut hides
  the worst stretch.

Canonical gap list: `docs/EDITOR_REFERENCE.md` §4.

---

## 12. Programmatic surface (for an agent driving the editor)

- **Create:** `insertCamera({ name?, focalLength?, twoNode? })`
  (`src/core/scene/sceneInsert.ts`) centres the camera and pulls it back by
  its focal length, so the comp plane renders 1:1 for any lens.
- **AI / MCP:** `add_camera_move` (`src/core/ai/cameraMoveTool.ts`) takes
  `push_in` / `pull_out`, any of the 15 `camera.*` techniques by short name,
  and the verbs `rig`, `fly_to`, `follow_path`, `shake`;
  `list_capabilities('camera')` lists them. `CAMERA_PROPS`
  (`src/core/ai/toolContext.ts`) whitelists raw camera props; writing one to a
  non-camera fails loudly.
- **Rules:**
  1. A camera moves nothing until a content layer is 3D. Check first.
  2. Set `z` relative to `focalLength` (`z = -focalLength` is the 1:1 plane).
  3. Animate by keyframing props. Animated values win over static ones, so
     write through the keyframe-aware path.
  4. Orthographic and custom views ignore the scene camera.
  5. Use `orientationY` for a pan and `orbitYaw` for an arc: different shots.

---

## 13. Files

| Concern | File |
|---|---|
| Camera evaluation (shake, along-path, parent rotation) | `native/libs/motion_transform/transform.cpp`, `native/engine/src/core/worldxf.cpp` |
| Render-time camera, active camera, camera motion blur, depth parallax mesh | `native/engine/src/scene/threed_port.cpp` |
| DOF maths | `native/engine/src/scene/camera3d_port.cpp` |
| Depth buffer, DOF gather, scene depth | `native/engine/src/render_graph/threed.cpp`, `render_graph/scene_depth.cpp` |
| Depth effects, linked flare | `native/engine/catalog/effects.json`, `native/engine/shaders/wgsl/fx60-depth-*.wgsl`, `lens-flare-depth.wgsl`, `camera-lens-blur-depth.wgsl`, `native/engine/src/scene/snapshot_build.cpp` |
| Depth estimate job | `native/engine/src/jobs/kind_depth_estimate.cpp`, `depth_ort_ffi.cpp`, `depth_prep.cpp`, `electron/depthModel.ts` |
| Camera expressions | `native/libs/motion_expr/` |
| Camera import | `native/engine/src/scene/model_convert.cpp`, `model_fbx_ffi.cpp`, `native/engine/src/core/aep/aep_plan.cpp` |
| Interchange maths, export | `src/core/scene/cameraInterchange.ts`, `cameraExport.ts` |
| Projection helpers for UI | `packages/scene/src/utils/project3d.ts`, `src/core/scene/camera3d.ts` |
| Navigation, views | `src/core/workspace/cameraNav.ts`, `customViews.ts`, `src/stores/guidesStore.ts` |
| Inspector | `src/layout/Inspector/CameraSection.tsx`, `CameraShotHeader.tsx`, `CameraShakeRows.tsx`, `CameraRigSection.tsx`, `DepthParallaxSection.tsx` |
| Rigs, path, fly-to, stereo | `src/core/scene/cameraRig.ts`, `cameraFollowPath.ts`, `cameraFlyTo.ts`, `stereoRig.ts` |
| Lens list, presets | `src/core/scene/lensPresets.ts`, `src/core/animation/cameraPresets.ts` |
| AI | `src/core/ai/cameraMoveTool.ts`, `src/core/ai/toolContext.ts` |
| Tracker | `docs/PROGRAM_CAMERA.md` |
