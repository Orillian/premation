# Plan: Performance animation — keyframe by showing, not by placing (drafted 2026-10-23)

Owner idea (2026-10-23, from `Premation_Physical_Animation_Plan.md` and the
discussion after it): keyframing today is a loop — move the playhead, move the
object, set a key, repeat every second. Let the user **show** the motion with
the mouse, a hand or the body, and let Premation write the keys. The same
system drives rigs: the user decides which part of their body (or hand) drives
which part of the character.

> Don't make users tell the computer where every keyframe should go.
> Let them show the computer how they want things to move.

Status: **approved 2026-10-23** — the owner accepted every recommendation in
§0 and §6 and asked for the edge cases (§8), settings (§9) and UI (§10) to be
settled before building. Existing behaviour stays available: every new
behaviour that changes an existing feature is a setting, and the old
behaviour is one of its choices.

---

## 0. Decisions (proposed — confirm before code)

1. **One system, not five.** Mouse, hand, body, face, MIDI and gamepad are all
   *input sources*. Moving a ball with your hand and puppeteering a character
   are the same feature with different mappings.
2. **The output is ordinary Premation animation.** Takes become keyframes on
   existing properties, bones and IK targets — timeline, graph editor, undo,
   render and export unchanged. Rendering stays deterministic because only
   baked keys are rendered.
3. **Few clean keys, not one key per frame.** A take that leaves 600 keys is
   harder to edit than doing it by hand; the feature then fails its purpose.
   Key fitting (§3.4) is the core of the program, not a polish pass.
4. **Mouse first.** Every mode works with the mouse; hand/body tracking is a
   second source on the same pipeline. Users without a webcam (or who don't
   want to wave their arms) still get the speed-up.
5. **Cleanup is deterministic.** Jitter filtering, key reduction and foot lock
   are signal processing (One-Euro, curve fitting, contact detection), not AI.
   Models are reserved for things that need them (tracking, later style).
6. **On-device only.** Camera frames never leave the machine; nothing is
   recorded except the landmarks of a take the user keeps.

---

## 1. What already exists (build on it, don't rebuild it)

| piece | where | relevance |
|---|---|---|
| Motion Sketch (mouse → Position keys while playing, capture speed) | `src/core/animation/motionSketch.ts`, `src/providers/commands/motionSketchEdits.ts` | Perform mode v0 already exists for one property and one source |
| Puppet Sketch (record pin motion, Douglas–Peucker, easing) | `src/core/rig/puppetSketch.ts` | the current sample → key reduction |
| Bones, FK/IK (two-bone + FABRIK), pole vectors, IK/FK switch, controllers, weight painting, biped/quadruped presets | engine `native/engine/src/core/rig.*`, `src/core/rig/rigPresets.ts`, `BoneOverlay.tsx`, `RigPanel.tsx`; see `docs/BONE_AND_PUPPET_RIGGING.md` | rig *targets* for body/hand mapping — Phase 1 of the original plan is largely done |
| 3D IK pose / bake | `native/engine/src/core/handlers_dynamics.*` | target for 3D characters later |
| On-device ONNX landmark inference + One-Euro smoothing | `native/engine/src/jobs/kind_face_track.cpp` (MediaPipe-class face mesh, model downloaded on first use) | the pattern for hand/pose models: same runtime, same download flow |
| SAM segmentation (Object Matte) | bundled | input for smart PNG rigging (Phase 6) |
| Spring / secondary motion | `set_spring` (MCP), engine springs | automatic follow-through after a take (§4.3) |
| Audio analysis (beats) | `analyse_audio` | tap-timing snap (§4.4) |
| AI tools `create_skeleton_rig`, `pose_skeleton` | MCP | the assistant can rig and map for the user |

Known limit to fix (stated in `motionSketch.ts`): the reduction is **spatial
only** — a hold on a straight path is dropped and a one-second wait becomes a
slow drift. That is why Motion Sketch keeps every sample today, and why §3.4
replaces the reduction with a time-aware fit.

---

## 2. The user-facing modes

### 2.1 Perform — record live motion
Select a layer (or a rig control), press Record. The work area plays; the
target follows the input. Pinch (hand) or press (mouse) grabs, release lets go.

- **Slow-motion capture:** playback at 1×, ½×, ¼× while recording; keys land
  at real speed. Precision for free.
- **Relative grab (clutch):** grabbing starts from wherever the target is;
  releasing and re-grabbing repositions the hand without moving the target —
  like lifting a mouse. Nobody holds an arm in the air.
- **Gain:** a small hand movement can mean a big or a small target movement.
- **Count-in and pre-roll:** a short pre-roll so the user is moving before
  the first recorded frame.

### 2.2 Pose — tap to key (pose-to-pose with the hand)
For control instead of performance. Place the target by hand (or drag), make a
**set** gesture (tap / closed fist / a key press) → a key at the current time,
and the playhead **auto-advances** by a step the user chooses (frames or
seconds). The loop *move time → move object → set key* becomes *move hand → tap*.

### 2.3 Two hands — object and time
One hand moves the target, the other scrubs time (swipe or twist = jog
wheel). Fast for fixing one section of a take.

### 2.4 Puppeteer — body / hand drives a rig
A **mapping panel**: a silhouette of the performer (body, two hands, head,
face) on the left, the character's rig tree on the right, links between them.

- **Presets:** Full body · Upper body · Arms only · Head only · One hand —
  auto-matched by bone names (the rig presets already name hips, chest, head,
  upper/lower limbs, IK controllers).
- **Move to link (MIDI-learn style):** click a bone or control, then move the
  body part you want to use; the part that moved most gets linked. ~2 s per
  link, no menus.
- **Calibration pose:** hold a T-pose (or an open hand) for one second;
  Premation measures the performer's proportions against the character and
  sets the rest pose. Tall user, short character — no hand tuning.
- **Link to IK controls by default:** your hand moves the character's hand IK
  target and the elbow solves itself. More stable than copying every joint
  angle and leaves one editable track instead of three. Bone-angle (FK) links
  are available for spines, heads, tails.
- **Per link:** strength (0–200 %, exaggeration), smoothing, mirror (my right →
  character's left), foot lock.
- **Hand as puppet:** fingers drive things that are not hands — a spider's
  legs, a tail, tentacles; the wrist drives a creature's head.

---

## 3. Architecture

### 3.1 The pipeline

```
Source (mouse · hand · body · face · MIDI · gamepad)
  → Channels        named scalar/vector signals at the source's rate
  → Mapping         channel → target, range remap, gain, mirror, smoothing,
                    relative/absolute, calibration
  → Target          any keyframable property · bone rotation · IK target / pole
  → Live preview    transient values in the engine — NOT document writes
  → Take            raw samples with timestamps, kept per recording pass
  → Fit             time-aware key fitting (§3.4)
  → ONE engine batch command → ordinary keyframes (one undo step)
```

### 3.2 Where things run (decision D1 — needs owner confirmation)

Recommendation: **camera capture and inference run in the `premation-engine`
process** (a live-input service on its own thread), reusing the ONNX runtime
and model-download flow of Face Tracking. The page receives only landmarks
(a few hundred floats, 30–60 Hz) for the mapping UI and overlay. This keeps
"no engine code in the page" and means a model crash restarts the engine, not
the app.

Alternative: `getUserMedia` + a WASM pose model in the page. Faster to
prototype, but it puts ML inference in the UI process and duplicates the
runtime the engine already has. Use it only for a throwaway latency spike if
at all.

Risks to measure before committing: camera access from a helper process on
macOS (TCC attributes to the app bundle — needs `NSCameraUsageDescription`
and verification), and end-to-end latency (target ≤ 80 ms camera → preview).

### 3.3 Live preview without writing the document

During a take the target must move on screen every frame without 60
commands per second entering the undo stack. **Checked 2026-10-23: the engine
already has this.** An engine gesture (`beginGesture` / `endGesture`,
`GestureSession` in `src/core/engine/uiEdits.ts`) applies every write live,
coalesces latest-wins, commits as ONE undo entry and reverts everything on
cancel. A take is therefore one gesture: live writes key the target at the
playhead (what a drag already does), and at the end the same gesture carries
one `setKeyframes` per track — the track as it was before the take outside
the recorded span, plus the fitted keys inside it. No engine change.

Today's Motion Sketch writes the drag as one entry ("Move") and the take as a
second ("Motion Sketch"); one Undo leaves the per-frame drag keys behind.
Routing the take through its own gesture fixes that.

Recording is timestamped by the **recording clock**, not by rendered frames —
heavy comps do not play in real time — then resampled to the comp frame rate.
Tracking latency (~50–100 ms) is measured once per source and the take is
shifted back by it, or every take feels late.

### 3.4 Key fitting (the core)

Replace spatial-only Douglas–Peucker with a **time-aware fit** per track,
written for the model the engine evaluates (`motion_eval` `sample`): a
segment is `value(t) = cubic(a, a+spatialOut, b+spatialIn, b; ease(u))` per
dimension, where `ease` is the CSS cubic-bézier `[x1,y1,x2,y2]` of the key
that starts the segment. So:

- resample the take onto the composition's frame grid (keys land on frames;
  a 240 Hz pointer and a 30 Hz camera give the same result);
- detect holds (motion under half the tolerance for ≥ the hold time) → a
  `hold` key where the hold starts, a key where motion resumes;
- split at turning points: a scalar's extrema, a path's reversals and stops —
  velocity there is zero, which yields the natural ease in / ease out;
- fit each span: a path gets a cubic Bézier (Schneider's method, tangents
  shared across a split so the path stays smooth) plus an ease; a scalar
  gets an ease. Eases are fitted AE-style: the **speed** at each key is the
  measured velocity, shared by both sides (no velocity jump at a key), and
  only the two **influences** are searched;
- if the worst sample is further than the tolerance, split there and recurse;
- a single **Detail** control (few keys ↔ faithful) sets the tolerance as a
  fraction of the take's range; it can be moved after the take — re-fitting
  from the kept raw samples (§4.1), not from the keys.

Pure TypeScript in `src/core/performance/` (UI-side document helper, no
engine state), deterministic: fixed iteration counts, no clock, no RNG.

Golden tests: a hold on a straight path survives; a bounce keeps its contact
frames; a recorded circle comes back as ~4–8 keys with smooth tangents.

### 3.5 Rules every row keeps

- Document changes go through the engine API (commands with inverses); one
  take = one undo entry.
- Deterministic render: only baked keys are rendered; raw takes never feed
  evaluation.
- New properties store nothing at their neutral value; existing projects
  render byte-identically.
- A missing model, camera or bad landmark frame never blanks a frame or
  crashes: record the error, show it, keep the editor usable.
- Editor state (mapping panel layout, camera choice, preview overlay) stays
  out of the document; mappings that belong to a rig live on the rig.

---

## 4. Beyond the original plan (the "more advanced" version)

### 4.1 Takes are kept, keys are derived
Each recording pass is stored as a **take** (raw samples + mapping + latency)
in the project, linked to the keys it produced. The user can re-fit (more or
fewer keys), re-time, or re-apply the take to a different rig later without
performing again. Keys stay the only thing rendered, so this is not a second
animation format — it is source material, like footage.

### 4.2 Loop + overdub recording
Loop the work area and record in passes, like a music looper:
pass 1 arms, pass 2 head, pass 3 legs — each pass only touches its links,
the rest plays back. Pass modes: **replace**, **add** (an offset on top of
existing animation, e.g. add a wobble to a keyed move), **blend**. This is how
professional performance capture is done and it makes mistakes cheap.

### 4.3 Automatic secondary motion
After a take, optionally add follow-through on tails, hair, antennae and
loose parts with the engine's springs. The performer does the primary
motion; physics does the overlap animators normally key by hand.

### 4.4 Tap timing
Tap a key (or tap fingers) in rhythm while the comp plays to place timing
marks; optionally snap to beats from `analyse_audio`. Then pose the marks.
Timing first, poses second — the classic animation workflow, made physical.

### 4.5 Phone as a virtual camera (later)
A phone on the local network streams its gyro/accelerometer as a source:
handheld camera moves recorded into the comp camera. Same pipeline, new
source.

### 4.6 What we deliberately do NOT build
**Gesture commands for the editor** (swipe to undo, pinch to zoom the
timeline). They are slower and less reliable than the keyboard and add false
triggers during takes. Gestures are for *animating*, not for operating the UI.

---

## 5. Phases

Each phase ships something usable on its own. Rows are sized to one commit or
a tight group.

### P0 — Foundations (mouse only)
| id | task | done when |
|---|---|---|
| [x] P0.1 | Time-aware key fitting (§3.4) with Detail control; Motion Sketch uses it when Keyframe reduction = Smart (§9); Every frame and Smooth keep today's behaviour | fitting tests (hold, bounce, circle) pass; a circle take → ≤ 8 keys |
| [x] P0.2 | A take is ONE engine gesture (§3.3) — no engine change needed | Motion Sketch = one undo entry; Esc reverts the live keys |
| [x] P0.3 | Perform on Rotation / Scale / Opacity (drag left / right, Shift = fine); capture speed; pre-roll | one undo per take; values clamped to the property's range |
| [x] P0.4 | Pose mode with mouse: set key + auto-advance | Set Key = one entry, playhead steps |
| [x] P0.5 | Re-fit from raw samples (§4.1) | moving Detail after the take re-fits without re-recording; the take is STORED IN THE PROJECT (D5): `setPerformanceTake` / `clearPerformanceTakes` / `getPerformanceTakes` (engine API 1950–1952, the layer's `fx.performanceTakes` keyed by property path — samples, source, fit, key span; ≤ 36,000 samples = 10 min at 60 Hz, `outOfRange` above), sent in the SAME gesture as the keys (still one undo entry), gone with its layer; Detail re-fits the stored take after save / reopen and after undo / redo (`providers/commands/performanceTakes.ts`). Evidence 2026-10-26: `engine_tests [performance]` 5 cases / 115 assertions (set / query / clear with inverses, cap, save → reopen, layer time axis, delete layer + undo); `performanceTakes.native.test.ts` 4 cases on `premation-engine-headless` (one entry for keys + take, undo / redo in step, save → newProject → open → re-fit, scrub take); the 6 performance native suites 32 / 32; `takeRecord.test.ts` 7 unit cases; codec round trip + ENGINE_API.md gates green. |

#### Progress (2026-10-23)

Built (uncommitted, branch `native-core`):

- `src/core/performance/fitTake.ts` — the fitter (frame grid, holds, Schneider
  path + AE speed/influence eases, split at worst-or-midpoint); a circle fits
  as four quarter-arcs with the textbook 0.552·r handles.
- Motion Sketch (`core/animation/motionSketch.ts`,
  `providers/commands/motionSketchEdits.ts`) — Smart / Every frame / Smooth;
  the drag and the take are ONE gesture; tracks rebuilt from the armed-time
  snapshot with `setKeyframes`; engine-restart fallback; re-fit.
- `providers/commands/performanceScrub.ts` — P0.3 scrub takes.
- `providers/commands/performanceSession.ts` + `stores/performanceStore.ts` +
  `layout/Workspace/PerformanceBar.tsx` — the bar (§10): Perform / Pose,
  target menu, speed, Detail (re-fits the last take), Record again, ⋯ settings,
  Esc semantics; capture-phase listeners; clock-tick sampling.
- `layout/Settings/PerformanceSettingsSection.tsx` — §9, nine preferences.

Existing defects found and fixed on the way:

- `ports.ts` stamped Motion Sketch samples (and every write "at the playhead"
  during playback) with the project store's playhead, which is mirrored at
  4 Hz while playing — takes had up to 250 ms staircase timing. Now the
  transient clock (`playbackClockStore.getTime`).
- Motion Sketch made two undo entries (the drag's "Move" with per-frame keys,
  then "Motion Sketch"); one Undo left the drag keys behind.
- A pause with the pointer resting produced no samples, so even "Every frame"
  interpolated across it. Playback ticks now sample the held value.
- Motion Sketch started playback at arming, so the comp ran away before the
  user reached the layer; recording now starts at the press (AE).

Verified: 13 fitter tests; 7 Motion Sketch + 4 scrub + 4 session + 6 bar
tests on `premation-engine-headless`, including engine-evaluated playback of
a smart take within the tolerance on every frame. Not yet verified in the
running app (agents do not start the dev server).

### P1 — Hand tracking as a source
| id | task | done when |
|---|---|---|
| [x] P1.0 | Latency spike: camera → landmarks → preview, measured on Windows and macOS (decides D1) | numbers written here; macOS camera permission verified — **Windows done 2026-10-23** (`premation-live-spike`, ASUS FHD webcam, NV12 1080p30 scaled by MF to 640×360, CPU ORT): sensor → frame 38.9 ms p50, frame → landmarks 19.9 ms, **total 58.7 ms p50 / 65.4 p95**; palm 11.7 ms, hand 3.5 ms; 30 fps kept, 1 drop in 10 s. In the engine's `--live` child: 53 / 62 ms. First run without a capture thread queued frames → 244 ms: latest-frame mailbox is mandatory. D1 = engine child process, CPU. macOS not measured (no capture yet). |
| [x] P1.1 | Live-input service: engine `src/live/*` (pipeline, tracker, MF camera, ORT, One Euro, `--live` child, LiveHost) + schema `97_live.eapi` (startLiveInput / stopLiveInput / listCameras / `liveInput` event) + Session relay; Electron `handModel.ts` (two PINNED files: OpenCV Zoo HF revisions 233e619d / 4b2a0b44, SHA-256 = their LFS oids) → `PREMATION_HAND_USER_DIR`; page `core/live/liveInput.ts` (per-frame `onLiveFrame`, status `liveInputStore` ≤ 4 Hz); Settings ▸ Performance Recording: Hand Tracking Model + Camera Test | engine_live_tests 11, engine_live_host_tests 4, handModel 4, liveInput 3 + 2 native — green. **Not yet verified:** detection with a real hand in front of the camera; the Settings rows in the running app; macOS (no capture) |
| [x] P1.1 | Live-input service in the engine: camera capture, hand landmark model (21 points/hand, two hands), One-Euro smoothing, model download like Face Tracking | landmarks stream to the page at ≥ 30 Hz; no camera → clear message, editor unaffected — the row above; the Performance bar shows the camera's state and the reason when it fails |
| [x] P1.2 | Gesture recogniser: pinch grab/release, tap, fist; relative clutch; gain | `src/core/live/gestures.ts` (pure, deterministic): grab ≤ 0.25 / release ≥ 0.40 pinch with 2 confirming frames, tap ≤ 300 ms and ≤ 0.04 frame-width travel, fist = four tips folded below their PIPs, lost ≥ 0.3 s releases, clutch + gain, mirror, Left / Right / Either. **False grabs measured: 0 in a 20 s, 600-frame open-hand clip with pinch jitter ±0.12 and ±1 % palm shake** (`gestures.test.ts`, 15 tests) |
| [x] P1.3 | Hand → property mapping (position, rotation from wrist roll, pinch distance → scale/opacity) | `providers/commands/performanceHandSource.ts` + the bar's Mouse / Hand toggle: Position ← clutch deltas × gain × comp width (Motion Sketch's gesture and fit), Rotation ← wrist roll (continuous), Scale / Opacity ← pinch distance from the take's start (200 % per pinch unit, clamped to the range); a pinch grabs Position / Rotation, Record (Enter) starts and stops the pinch-driven targets; Pose: tap or fist = Set Key. `performanceHandSource.native.test.ts` (4): one undo entry per take, Undo restores the static value, lost hand finishes the take |
| [x] P1.4 | Viewport overlay: skeleton of the hand, grab state, recording state | `layout/Workspace/HandOverlay.tsx`: a top-right inset drawn from the frame listener (rAF-coalesced, no React render per frame) — 21-point skeleton, palm, state dot (grey / accent while grabbed / red while recording). Page-side DOM in the viewport stage: the engine renders exports from the document, so it is never in one. `HandOverlay.test.tsx` (3), `PerformanceBar.native.test.tsx` (+2) |

#### Progress (2026-10-26, P1.2–P1.4)

Built (uncommitted, branch `native-core`), on top of P1.1:

- the hand is a second SOURCE on the P0 pipeline, not a second recorder:
  Position goes through Motion Sketch (`recordMotionSketchSample` + the take's
  gesture), the other targets through the scrub recorder (`moveScrubBy`), so
  the fit, the splice of keys outside the span, the engine-restart fallback
  and the Detail re-fit are the P0 ones;
- what starts a take: a confirmed pinch for Position and Rotation (the hand
  is the mouse button); Record / Enter for Scale and Opacity, because their
  pinch IS the value — a pinch cannot both grab and vary. A tap in Perform
  mode writes nothing and shows no toast;
- each frame's measured latency shifts its sample back (plan §3.3 / §8.5);
- new preferences (§9, in the bar's ⋯ popover): Input (Mouse / Hand), Hand
  gain 0.25–4, Hand (Either / Left / Right), Mirror (on).

Position deltas are WORLD (comp px) and go through the parent's inverse
(the parent's layer-to-comp matrix from the engine's `getLayerTransforms`, the
same matrix the pointer's move uses; fetched with the start values in one
round trip at the grab), so a child of a
scaled or turned null travels the distance the hand did (test: a parent
turned 90°, same travel, same comp-space distance). Known limit:
two-hands-two-roles (§2.3) is not built.

**Not yet verified:** a real hand in front of a real camera (the thresholds
are set on the hand model's documented pinch scale and the P1.0 spike
footage, and measured only on synthetic clips); the bar, inset and camera
status in the running app (agents do not start the dev server); macOS (no
capture there yet).

### P2 — Hand → rig
| id | task | done when |
|---|---|---|
| P2.1 | Mapping panel (performer silhouette ↔ rig tree), links stored on the rig | create/edit/delete links, undoable |
| P2.2 | Move to link | linking a bone by moving a finger/hand works in ≤ 2 s |
| P2.3 | Targets: IK target, pole, bone rotation, controller | hand drives an arm by IK target |
| P2.4 | Hand as puppet (fingers → limbs/tail), per-link strength/mirror/smoothing | spider-leg demo comp |

### P3 — Body → rig
| id | task | done when |
|---|---|---|
| P3.1 | Body pose model (33-point class) in the live-input service | full-body landmarks at ≥ 30 Hz |
| P3.2 | Presets (full / upper / arms / head) with name matching against rig presets | one click maps the biped preset |
| P3.3 | Calibration pose + proportion retargeting (angles for FK links, normalised targets for IK links) | short and tall performers drive the same rig correctly |
| P3.4 | Loop + overdub passes (replace / add / blend) | arms pass then legs pass, each its own undo entry |
| P3.5 | Foot lock (contact detection) | feet don't slide in a walk-in-place take |

### P4 — Finishing the take
| id | task | done when |
|---|---|---|
| P4.1 | Clean Motion panel: smoothing, key reduction, foot lock, exaggeration (amplify deviation from a smoothed base) | each control re-fits from the take |
| P4.2 | Automatic secondary motion (springs on chosen bones) | tail follow-through after a body take |
| P4.3 | Tap timing + beat snap | timing marks from taps, snapped to beats |

### P5 — Face, 3D characters, other sources
Face landmarks (model already exists) → head/eyes/mouth controls; 3D
skeletons (FBX/USD) through the 3D IK path; MIDI, gamepad, phone virtual
camera as sources.

### P6 — Smart PNG rigging (research track, parallel, not blocking)
**Layered PSD/PNG import first** (each part its own layer → reliable rig, no
holes). Then single-image rigging (Animated-Drawings approach: detect → SAM
segment → pose estimate → bone proposal with confidence → user correction →
ARAP mesh). Known limit: a flat image has no pixels behind an arm, so large
poses tear; stylised characters defeat human-pose models — the confidence and
correction step is mandatory, not optional.

### P7 — Model-based motion (later)
Style transfer ("make it snappier / cartoony"), pose correction, timing
suggestions — only after P4's deterministic tools exist to compare against.

---

## 6. Open decisions for the owner

| id | question | recommendation |
|---|---|---|
| D1 | Inference in the engine process or the page | engine (§3.2), confirmed by the P1.0 spike |
| D2 | Which models (hand, pose) | MediaPipe-class / RTMPose — Apache-licensed; **not** OpenPose (non-commercial) |
| D3 | Ship order | P0 → P1 → P2 → P3; P6 as a research track alongside |
| D4 | Free or paid | to decide; tracking models downloaded on first use either way |
| D5 | Do takes ship in the project file by default | yes, with "Discard takes" to shrink files |

## 7. Risks

- **Fatigue and precision** of mid-air hands — mitigated by clutch, gain,
  slow-motion capture and Pose mode; validated with real users in P1.
- **Latency** makes takes feel late — measured offset correction (§3.3).
- **Lighting / webcam quality** — tracking confidence shown live; low
  confidence holds the last good value instead of jumping.
- **Scope creep** into a second animation system — prevented by §0.2: the
  only output is keys on existing properties.

---

## 8. Edge cases — decided

Each row is the behaviour the implementation and its tests must have.

### 8.1 Targets
| case | behaviour |
|---|---|
| Nothing selected / more than one layer | Record is disabled with the reason in its tooltip (P0 records one target; multi-target is P3 overdub) |
| Locked layer | Disabled: "Layer is locked" |
| Hidden or shy layer | Allowed — hiding is a view choice |
| Property driven by an expression | Refused with "Driven by an expression — disable it to record"; keys under an expression would record but never show |
| Separated Position (X / Y apart) | Each dimension gets its own track, same key times |
| 3D layer | X/Y recorded, Z kept at its value at the take's start (today's rule) |
| Parented layer | Recorded in the parent's space (the drag path already converts) |
| Property with no keys (static) | Becomes animated; Undo restores the static value |
| Time-remapped / stretched layer | Keys are written in comp time; the engine maps them onto the layer's keyframe axis (today's rule) |
| Bounded property (opacity 0–100, scale ≥ 0) | Eases never overshoot (ease handles stay in 0–1), so a fit never leaves the recorded range |
| Rotation past ±180° | Recorded continuously (no wrap): two turns stay two turns |

### 8.2 Recording
| case | behaviour |
|---|---|
| Existing keys inside the recorded span | Replaced; keys outside are kept exactly (ids, eases) |
| Recording against a stopped playhead | Perform starts playback; Pose mode is the mode for a parked playhead |
| Comp too heavy to play in real time | Samples are stamped with the playhead time, not the rendered frame; the take is correct even when the preview drops frames |
| Playhead reaches the work-area end | The take finishes there (no wrap); loop recording is P3 |
| Playhead goes backwards (user scrubs, loop wraps) | The take finishes at the last forward sample |
| Esc during the take | Everything the take wrote is reverted (gesture cancel); nothing in the undo stack |
| Window loses focus / pointer cancelled | The take finishes and keeps what was recorded |
| Engine restarts mid-take | The gesture is dead; the raw samples are still in the page, so the fitted keys are written as one fresh edit after the restart; if that fails the take is reported, not silently lost |
| Project closed / switched mid-take | Take discarded, no write |
| Undo / Redo pressed during a take | Ignored until the take ends (one gesture open at a time) |
| Take shorter than one frame or with no movement | Nothing written; "Nothing recorded" |
| Very long take (minutes, 240 Hz pointer) | Resampled to the frame grid before fitting; fitting is linear-ish in frames; samples capped at 1 hour of frames |
| Several pointer samples in one frame | Resampled — the last state of the frame wins |
| Pointer pauses mid-take | A hold (see §3.4), not a drift — the bug in today's spatial-only reduction |
| Capture speed ≠ 100 % | Times stretched around the take's first sample (today's rule), then fitted |
| Settings changed during a take | Read once when the take starts |
| Snap to pixel on | The live preview snaps as today; the fit runs on the unsnapped samples, so a slow drag does not become a staircase |

### 8.3 Fitting
| case | behaviour |
|---|---|
| Straight constant-speed move | 2 keys, linear |
| Hold in the middle of a straight move | Hold kept (keys at hold start and end) |
| Bounce / back-and-forth | A key at each turning point with zero velocity (ease) |
| Circle | ≤ 8 keys, smooth path (shared tangents at splits) |
| Noise smaller than the tolerance | Absorbed — no keys for jitter |
| Detail at maximum | Faithful within ¼ px (or ¼ unit) |
| Same input twice | Identical keys (determinism test) |

### 8.4 Pose mode
| case | behaviour |
|---|---|
| Set Key with nothing changed | Writes the key anyway — an explicit request |
| Auto-advance past the comp end | Stops at the last frame and says so |
| Step size | Frames or seconds, set in the Performance bar; remembered per user |
| Pose mode and Auto-Keyframe | Independent: Pose writes keys only on Set Key |

### 8.5 Hand / body input (P1+, recorded here so P0 does not block them)
| case | behaviour |
|---|---|
| No camera / camera in use by another app / permission denied | Input menu shows the reason and a fix ("Allow camera in System Settings ▸ Privacy"); mouse stays available |
| Model not installed | One-click download like Face Tracking; offline → clear message |
| Hand lost for < 0.3 s | Hold the last value |
| Hand lost for ≥ 0.3 s | Release the grab (as if the pinch opened) |
| Low tracking confidence | Hold the last good value; confidence shown live |
| Two hands, one mapping | The nearer (larger) hand drives; a setting picks Left / Right / Either |
| Mirror | On by default (moving right moves right on screen) |
| Tracker latency | Measured once per source, the take shifted back by it |

---

## 9. Settings

New section **Performance Recording** in Settings ▸ Appearance & Behaviour,
under "Editor Behaviors". Preferences, not document state.

| setting | choices | default | why this default |
|---|---|---|---|
| Keyframe reduction | **Smart** (time-aware fit) · **Every frame** (After Effects' Motion Sketch) · **Smooth** (today's path simplification) | Smart | the point of the feature; the other two keep today's behaviour one click away |
| Detail | 0–100 | 50 | ~2 px on a 1080p move |
| Keys on whole frames | on / off | on | keys AE users can edit |
| Capture speed | 25 · 50 · 100 · 200 % | 100 % | today's |
| Pre-roll | off · 1 s · 2 s | off | today's behaviour |
| Hold detection | 0.1–1 s | 0.25 s | |
| Pose step | frames / seconds | 10 frames | |

The Performance bar (§10) changes the same preferences, so the two never
disagree.

---

## 10. UI / UX

Direction: AE-grade, quiet, panel typography roles (`--panel-*`), no new
visual language. One surface while recording, nothing modal.

**Performance bar** — a slim bar docked at the bottom of the viewport, shown
when Motion Sketch / Perform is armed (Animation ▸ Perform…, or its
shortcut):

```
● Record   Shape 1 · Position ▾   Perform | Pose   Speed 100% ▾   Detail ━━●━━   ⋯   ✕
```

- the target chip names the layer and property; its menu lists the
  recordable properties of the selection;
- **Perform | Pose** is a segmented control; Pose shows `Set Key ⏎` and
  `Step 10f ▾` in place of Speed;
- while recording: the dot pulses, the time counts, the hint reads
  `Release to finish · Esc to cancel`; every other control is disabled;
- after a take: `7 keys` with **Undo** and the Detail control live — moving
  it re-fits the last take (one undo entry per adjustment);
- `⋯` opens the remaining settings (§9) as a popover; ✕ disarms.

Feedback rules: one toast per take at most; errors say what to do; nothing
blocks the viewport; keyboard path for everything (Record, Set Key, Esc).
