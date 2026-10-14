# Program: camera UX + the 3D shot-making gap with After Effects (started 2026-10-14)

Owner request (2026-10-14): "the camera is good but its UX and UI are not good
enough", then, after the After Effects comparison, "go implement them all".

The comparison (2026-10-14): Premation's camera OPTIONS are at AE parity or
ahead (motion blur from camera moves in 3D, DOF everywhere, bookmarks,
Distribute in Z, AI camera techniques). The gap is (a) UX — the good tools are
scattered, one value is shown four ways, nothing says what a viewport drag
edits — and (b) the shot-making workflows AE users get from rigs, scripts and
plugins: procedural shake, camera rigs, path follow, fly-to-target, depth
compositing, light-linked flares, photo→3D parallax, camera import/export,
camera expressions, stereo.

Out of scope (owner told): a ray-traced renderer and VR/360 output — each is a
program of its own.

Work lands as local commits on `native-core` (no push until the owner says so).

## How a resumed session continues

1. `git log --oneline -20`, read **Progress**; take the first task not `[x]`
   in your lane (UI lane = U, R2–R5; engine lane = R1, R3b, E*, D*).
2. Native builds: ONE engine worker at a time across all sessions — take the
   shared lock first: `mkdir native/build/.build-lock` (atomic; if it exists
   wait and retry; never remove another session's lock), `rmdir` when done.
   The dev app may hold `native/build/windows-clang-cl-engine/engine/premation-engine.exe`
   — rename it `*.in-use-<ts>.exe` before linking.
3. One task (or a tight group) = one commit (`camera(<id>): <what>`). Stage
   ONLY your own paths — another lane commits in the same checkout. Files are
   CRLF: use the Edit tool, never `sed -i`.
4. Green for what it touches: `npm run typecheck`, `npm run lint` (no new
   warnings), `npx jest <paths>`; engine `npm run native:build -- --engine` +
   `npm run native:test -- --engine`; shaders/passes `npm run native-golden`
   (goldens unchanged unless the task changes the picture on purpose).
5. Tick the row here in the same commit. Never push.

## Rules every row keeps

- Document changes go through the engine API (commands with inverses); one
  user action = one undo entry.
- Deterministic: shake/noise is seeded, never wall-clock or `Math.random`.
- New properties store nothing at their neutral value, so existing projects
  render byte-identically (goldens prove it).
- New camera properties are keyframable, appear in the timeline property
  tree, survive save/load and AEP import where AE has an equivalent.
- A bad input (missing target layer, deleted path, absent depth model) never
  blanks a frame: record on `layerErrors`, render without the feature.

## Tasks

### U — camera UX (UI lane)

| id | task | done when |
|---|---|---|
| [x] U1 | **Viewport "what a drag edits" badge.** When a camera tool is armed or Alt is held, the viewport shows a small badge: `Camera 1 · moves the shot` (plus `· keyframing` when the property is animated or Auto-Keyframe is on) in Active Camera / camera views, and `Custom View 1 · preview only` in custom/ortho views | component test for both modes + keyframing variant |
| [x] U2 | **One lens list.** `LENS_PRESETS` (Inspector) and `LENS_PRESETS_MM` (New Camera dialog) become one shared list in mm (15 20 24 28 35 50 80 135 200, labelled "35mm — Reportage" etc.) in `src/core/scene/` | both consumers import it; test the mm↔fov↔px round trip |
| [x] U3 | **"Shot" header in the camera Inspector.** Top of CameraSection: a lens picker (shared list, current lens ticked, "Custom" when off-list), the camera presets as one-click buttons (Push In, Pull Out, Orbit Sweep, Drift Parallax, Dolly Zoom, Handheld), and action buttons Focus on Layer (pick, U6), Distribute in Z, Create Orbit Null, Fly to Layer (R4), Add Rig (R2). The "No 3D layers — the camera moves nothing" warning + Make All 3D moves to the TOP when it applies | native component test: rows present, preset click = one undo entry |
| [x] U4 | **New Camera dialog, task-led.** App `Dropdown` lens picker (not a native `<select>`), live angle-of-view readout, segmented "Aim at a target (two-node) / Free (one-node)", and a "Make all layers 3D" checkbox (on by default when the comp has no 3D layers) — applied in the same undo entry as the insert | dialog test: create with checkbox → camera + 3D switches in one entry |
| [x] U5 | **Depth of Field, simplified.** Rows: On/Off, Focus Distance (with pick button, U6), a "Lens model" segmented `Classic / Physical` (Physical sets F-Stop to 2.8 if 0; Classic sets 0), F-Stop (Physical only), Blur Level, then "Bokeh" twirl (Iris Blades + the iris/highlight rows). Aperture moves into an "Advanced" twirl. No stored-value change for untouched cameras | rows test; goldens unchanged |
| [x] U6 | **Pick focus on canvas.** A crosshair button next to Focus Distance arms a one-shot pick: click a layer in the viewport → `setFocusDistanceToLayer`; Esc cancels; the cursor shows the mode | interaction test |
| [x] U7 | **Orbit vs Rotation clarity.** Twirl labels "Orbit around target" / "Turn on the spot"; the Orbit tool's tooltip names which one it writes | label test |

### R — rigs and motion

| id | lane | task | done when |
|---|---|---|---|
| R1 | engine | **Procedural camera shake.** Camera Transform props `shakeAmount` (px), `shakeRotation` (°), `shakeFrequency` (Hz, default 2), `shakeSeed` (int), `shakeOctaves`? (no — keep 2 fixed incommensurate octaves) evaluated in the C++ camera evaluation as seeded smooth noise added to position and orientation (after POI aim). Keyframable (amount can be ramped). Neutral = 0 amount → nothing stored, byte-identical. Camera motion blur sees the shake. UI: a "Shake" twirl in CameraSection (separate component file `CameraShakeRows.tsx`, mounted by the UI lane). Handheld preset becomes "set shake" instead of baked keys (keep the old preset id working) | engine test: deterministic for a seed, zero at amount 0, differs by seed; goldens unchanged |
| [x] R2 | UI | **Camera rigs.** Command "Add Camera Rig ▸ Crane / Dolly / Orbit": builds parented 3D nulls named `Rig · <kind> · <control>` above the selected camera (Crane: Base (track X/Z) → Boom (height + arm swing) → Arm length; Dolly: Track (X/Z) → Pedestal (Y); Orbit: Pivot (yaw/pitch) → Arm (distance)). One undo entry. Selecting the camera or any rig null shows a "Camera Rig" Inspector section with plain sliders (Truck, Pedestal, Dolly, Boom, Swing, Arm, Pan, Tilt) that write the right null's transform, keyframable | native test: rig built, slider moves camera world position as expected, undo removes all |
| [x] R3a | UI | **Follow a path.** Command "Camera ▸ Follow Path…" with a path (shape path or mask) selected and a camera: converts the path to camera Position keyframes over the work area (or chosen duration) with spatial bezier tangents and roving middle keys (AE's paste-path-into-position), one undo entry | test: keys lie on the path, roving, one entry |
| R3b | engine | **Orient along path for cameras.** Remove cameras from `AUTO_ORIENT_DEAD_KINDS`; the C++ camera evaluation supports Auto-Orient "Along Path" for one-node cameras (look along the position tangent) | engine test: camera faces travel direction; AutoOrientDialog offers it for cameras |
| [x] R4 | UI | **Fly to layer (shot sequencer).** Command "Fly to Selected Layers": with a camera and N selected layers, from the playhead keyframes the camera (position + POI, or position + rotation for one-node) to frame each layer in selection order, `travel` and `hold` seconds (dialog, defaults 1.0 / 1.0), eased (SMOOTH). Uses `framingFor`. One undo entry | test: keys at expected times, layer centred in frame at hold time |
| R5 | UI | **AI/MCP camera coverage.** MCP `add_camera_move` accepts every technique in `packages/technique-library/src/techniques/camera.ts` (15) + `shake` (R1), `rig` (R2), `fly_to` (R4), `follow_path` (R3a); `list_capabilities` lists them; tool truthfulness test | ai-tools tests |

### D — depth, lens, interchange (engine lane)

| id | task | done when |
|---|---|---|
| D1 | **Depth for compositing.** Scene depth (already sampled for SDK plugins, `render_graph/scene_depth.cpp`) becomes usable by ordinary effects on an adjustment layer above 3D layers: new effects **Depth Matte** (keep pixels within near/far, feather), **Depth Fog** (colour, start, end, density, optional gradient), **Depth Extract** (depth → grayscale, near/far/invert); and **Camera Lens Blur** gets "Blur Map: Scene Depth" with focus from the active camera's Focus Distance (or a value). Registry entries + WGSL + metadata, no React special-casing | GPU tests + new goldens for each effect; existing goldens unchanged |
| D2 | **Lens flare linked to a 3D light.** Lens Flare gets `Link to Light` (layer picker): centre = the light's position projected through the active camera; brightness fades to 0 behind the camera and is attenuated when scene depth in front of the light's screen point is closer than the light (occlusion, soft over a few px) | GPU test: flare follows an animated light; occluded → dim |
| D3 | **Photo → 3D parallax.** Command "Make 3D from Photo/Video…" on an image/video layer: depth source = (a) AI estimate with Depth Anything V2 Small (ONNX, Apache-2.0) via the existing ORT job pipeline (`native/engine/src/jobs/*_ort_ffi.cpp`), model fetched on demand like the face/Object Matte models (pinned URL + SHA-256, `electron/modelDownload.ts`); or (b) a user depth-map layer. Result: the layer renders as a camera-facing displaced grid mesh (existing height displacement) with depth scale, edge-stretch cut threshold and inpaint-free edge fill; a "Depth Parallax" Inspector section (Depth Scale, Edge Cut, Mesh Detail, depth source); video = per-frame depth job cached to disk. Offers a Push In / Orbit preset after creation | engine test with a synthetic depth map; ORT job test gated on the model being present; golden for a fixed depth map |
| D4 | **Camera import.** glTF/GLB (`KHR` perspective cameras, `yfov`, animated node TRS) and FBX (ufbx cameras, focal length + film back, animation) import as Premation camera layers alongside the model (Y-up → comp space conversion the model import already uses); AEP import maps camera options 1:1 where it does not yet | import tests with tiny fixture files |
| D5 | **Camera export.** "Export Camera…" on a camera layer: glTF 2.0 (`.gltf`, animated camera node, yfov from zoom, Blender/C4D-ready) and Nuke `.chan`; baked per frame over the work area, coordinate conversion documented | round-trip test: export → D4 import → same world matrix and fov per frame (tolerance) |
| D6 | **Camera expressions.** `motion_expr`: `lookAt(from, to)`, `thisComp.activeCamera`, `cameraOption.zoom / focusDistance / aperture / blurLevel` (+ AE match names), `pointOfInterest`, `toCompVec`, `fromCompToSurface`, `lightOption.intensity / color` | expression tests, AE semantics |
| D7 | **Stereo 3D rig.** Command "Create Stereo 3D Rig" (AE parity): duplicates the active camera into Left/Right children of a "Stereo Camera Controls" null (Interaxial Separation, Convergence: Off/To Camera POI/To Zero Z, Convergence Z Offset, Stereo Scene Depth), builds Left Eye / Right Eye comps and an output comp using the existing `3d-glasses` effect (anaglyph / side-by-side / over-under / interlaced) | test: eyes offset by interaxial; output comp renders |
| D8 | **Docs.** `docs/CAMERA_SYSTEM.md` rewritten for the native engine (names `native/engine/src/scene/camera3d_port.*`, `render_graph/threed.cpp`), every feature above, and the remaining gaps | reviewed |

## Progress

- 2026-10-14: program written.
- 2026-10-14 U2: one lens list in `src/core/scene/lensPresets.ts` (mm, nine presets, mm↔fov↔px helpers); the Inspector ≡ menu and New Camera dialog both import it; round-trip test `lensPresets.test.ts`.
- 2026-10-14 U1: `CameraNavBadge` (bottom centre of the viewport, pointer-transparent) while a camera tool is armed or Alt is held — "Camera 1 · moves the shot" (+ " · keyframing" when a nav track is animated or Auto-Keyframe is on) in Active Camera / camera views, "Custom View 1 · preview only" in custom / ortho views; `CameraNavBadge.native.test.tsx`.
- 2026-10-14 U4: New Camera is task-led — app `Dropdown` lens picker over the shared list, live angle-of-view readout, `Segmented` "Aim at a target / Free", and "Make all layers 3D" (on when the comp has no 3D layer) riding the insert's `pasteLayers` batch (`insertCameraEdit` `make3D`) so one Undo takes both back; `CameraDialog.native.test.tsx`.
- 2026-10-14 U3/U5/U6/U7: camera Inspector — `CameraShotHeader` leads the section (no-3D warning + Make All 3D when it applies, Lens `Dropdown` with "Custom · n mm" off-list, six camera moves as one-click `applyPreset` buttons = one entry each, Focus on Layer / Distribute in Z / Create Orbit Null); Depth of Field is On/Off · Focus Distance + crosshair · Lens Model Classic|Physical (Physical sets f/2.8 when 0, Classic writes 0) · F-Stop (Physical) · Blur Level · ▶ Bokeh · ▶ Advanced (Aperture), nothing stored until a pick; pick focus on canvas is a one-shot `focusPickStore` (useWorkspace takes the click, crosshair cursor, Esc cancels) → `setFocusDistanceToLayer`; twirls read "Orbit around target" / "Turn on the spot" and the camera tools' tooltips say what they write. Tests: `CameraShotHeader.native`, `CameraSection.rows.native`, `focusPick.native`, `cameraToolTitle`.
- 2026-10-14 R2: `src/core/scene/cameraRig.ts` — Layer ▸ Camera ▸ Add Camera Rig ▸ Crane / Dolly / Orbit (+ the Shot header's Add Rig ▾) builds `Rig · <Kind> · <Control>` 3D nulls (Crane Base→Boom→Arm, Dolly Track→Pedestal, Orbit Pivot→Arm) in ONE gesture, the camera re-based under the last null so nothing moves (`rebaseUnder`, shared with Create Orbit Null); `rigOf` reads the rig back from the camera or any null by its name chain; the `CameraRigSection` Inspector section draws Truck / Pedestal / Dolly / Boom / Swing / Arm / Pan / Tilt as keyframable rows on the right null (Arm = the arm null's length; Pan / Tilt = the camera's own Turn on the spot). Note: a camera resolves its parents by lifting eye + POI only, so a rotating rig null (Swing) turns a TWO-node camera's aim but only arcs a one-node camera's eye — engine-lane follow-up if one-node cameras should inherit parent rotation. `cameraRig.native.test.tsx`.
- 2026-10-14 R3a/R4: Layer ▸ Camera ▸ Follow Path… (`cameraFollowPath.ts`: the selected shape path or first mask → the camera's Position keys, one per vertex in world → parent space, the path's handles as spatial tangents, ends fixed and the keys between roving, times by arc length over the work area or a chosen Start / Duration; a 2D path keeps the camera's Z) and Fly to Selected Layers… (`cameraFlyTo.ts`: from the playhead, travel / hold (1.0 / 1.0 s) per layer in selection order, `framingFor` scaled to this camera's Zoom along its current view direction; two-node keys Position + POI, one-node Position with rotation kept; orbit angles solved back through `unorbit`; SMOOTH travel, linear spatial) — each ONE entry; dialogs + commands in `layout/Composition/CameraShotDialogs.tsx`, Fly to Layers also in the Shot header. Tests: `cameraFollowPath.native`, `cameraFlyTo.native`.
- 2026-10-14 R5 (all but `shake`'s verification): `add_camera_move` (`src/core/ai/cameraMoveTool.ts`) takes kind push_in / pull_out (the recipe), any of the 15 `camera.*` techniques by short name (run through `applyTechnique`, role targets inferred from the comp when omitted), and the verbs rig (`buildCameraRig`), fly_to (`planFlyTo`), follow_path (`planFollowPath`) — the verbs write through the AI turn's session, so the turn stays ONE undo entry — and shake (R1's props; refuses honestly on an engine without them). `list_capabilities('camera')` lists every kind. Test `cameraMoveTool.native.test.ts`. Not ticked yet: `shake` waits for `camera(R1)` to land so it can be verified on the engine.
