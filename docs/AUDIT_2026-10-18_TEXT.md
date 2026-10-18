# Text quality and text controls — audit, 2026-10-18

Owner's complaint (2026-10-18): "texts and paragraphs are very low quality:
spacing, fonts, families and weights are almost all broken, and controlling
them is poor. I want premium, perfect text that users can fully control like
After Effects."

This document records what was measured, what is wrong and where, and what was
changed. Stills: `docs/assets/text-audit-2026-10-18/` (`before/` from the
probe below, `after/` after the fixes), each 1920×1080 rendered by
`premation-engine` with the full renderer (Dawn) on the RTX box, downscaled to
1280 for the repo.

## 1. How it was measured

A temporary jest suite on the app's engine (`setupAppEngine({ gpu: true })`,
`PREMATION_GPU_TESTS=1`, `PREMATION_FONTS_MANIFEST` = the shipped
`resources/fonts/fonts.json`, exactly as `electron/engineHost.ts` passes it)
built eleven scenes through the same `create_layer` / `update_layer` tool
calls the AI uses, plus `setProperty text/<field>` writes for the fields the
tools do not reach, and read each frame back with `getThumbnail` at full size.
The suite was deleted once the findings were written; its scenes became the
regression suite in §5.

Scenes: A headline (Inter 700, Playfair 400, Arial 700 at 180 px) · B a
wrapped paragraph with mixed weights/italic/colour runs and a justified serif
column · C tracking −4 / 0 / 8 / 24 px, leading 0.9 / 1.2 / 1.8, metrics vs
optical kerning · D Inter (variable) and Poppins (nine static files) at every
hundred · D2 italics, system family weights, a missing family, 14 / 22 px text ·
E Japanese, Korean, Chinese, mixed script, an installed CJK family, Korean
leading 1.0 · F strokes (over/under fill, stroke only, 1 px, miter) · G 3D
extruded Inter and Playfair · H a 24 px layer scaled ×6 next to native 144 px,
four paragraph alignments · I superscript/subscript/baseline shift, caps, small
caps, horizontal/vertical scale, faux bold+italic, 10–28 px hinting ladder · J
italics of Arial / Segoe UI / Times / Georgia / Inter, layer small caps on Inter
and Arial, caps runs, 20 px tracking at 40 and 120 px, a miter-joined stroke.

Shaping/rasterisation reference: the engine's glyph pipeline (HarfBuzz +
Skia, `native/engine/src/raster/fonts_ffi.cpp`) was measured against
Chromium's canvas when it was built (`FontOptions::chromium_windows`,
`premation-raster --probe`); this audit did not repeat that measurement. A
browser render of the same fonts could not be captured in the app's browser
pane (local files render as static snapshots there), so "against a browser"
below means Blink's documented behaviour, not a pixel diff.

## 2. What is good

- **Rasterisation.** Glyph edges at Full are as crisp as Skia + DirectWrite
  produce; the 24 px layer scaled ×6 (H) re-rasterises through the tier
  ladder and is indistinguishable from native 144 px. 10–28 px text (I) is
  readable with no colour fringing. Subpixel positioning is on (fractional
  advances), so animated text does not snap to whole pixels.
- **Variable fonts.** Inter 100…900 draws nine distinct weights on the
  `wght` axis (D); the shipped families' `opsz` follows the font size. Static
  families (Poppins) pick the right file per weight.
- **Scripts.** Noto Sans JP/KR/SC render; an installed CJK family (Yu Gothic
  Bold) renders; mixed Latin + Hangul + Han in Inter falls through to the
  bundled Noto faces per character (E). (Known limit, unchanged: a family that
  is neither installed nor bundled is reported on `layerErrors` and drawn in a
  fallback face.)
- **Layout.** Justify (all seven AE modes), indents, paragraph spacing, box
  wrapping, superscript/subscript/baseline shift, horizontal/vertical scale,
  faux bold/italic, manual kerning in 1/1000 em, optical kerning (measurably
  tighter: 6 px over "AVAWAY To Ya LTA" at 96 px) all do what they say (B, H,
  I).
- **Strokes.** Over/under fill orders, stroke only (`noFill`), line joins,
  gradient stroke paint all render (F). Miter joins spike at acute corners
  exactly as a miter limit of 10 allows — the same as Illustrator's default
  and AE's.

## 3. What is wrong (before)

| # | Finding | Where | Severity |
|---|---------|-------|----------|
| T1 | **Italic of every installed family is drawn upright.** Arial, Segoe UI, Times New Roman, Georgia with `fontStyle: italic` render the upright face (J, D2). DirectWrite lists each family's faces *including its simulated obliques* ("Arial Normal Oblique" = ARIAL.TTF + italic simulation). `FontSet::add_system_family` registered those as `italic = true` with the upright file's bytes; CSS matching then picked the last italic face at the weight — the simulation — and, because the face claimed to be italic, no synthetic slant was applied either. Bundled families (Montserrat) and faux italic on Inter were unaffected. Simulated bolds hide the same way for single-weight families (the "bold" face is the regular file, drawn without embolden). | `native/engine/src/raster/fonts_ffi.cpp` `add_system_family` (Windows branch) | high — every system italic |
| T2 | **Small Caps does nothing unless the font has an `smcp` feature.** Inter (the default font) stays lowercase (J, I); Arial's small caps work only because Windows 11's Arial 7 ships `smcp`. AE and Blink synthesize small caps (capitals at ~70 %) when the font has none. | `fonts_ffi.cpp` `FontSet::shape` (features only), `canvas_ffi.cpp` `request()` | high — the Character panel button is a no-op for most fonts |
| T3 | **Tracking is in pixels; AE's is 1/1000 em.** 20 px tracking is half an em at 40 px and a sixth at 120 px (J bottom); changing the font size changes the look, and an AE/Illustrator value (e.g. 50 → 0.05 em) cannot be typed. The Source Text expression API already takes AE units and converts (`snapshot_build.cpp:1123`), so two unit systems met in one field. | `src/layout/Inspector/CharacterPanel.tsx` Tracking cell (`px`), `text/letterSpacing` field | high — "spacing broken" |
| T4 | **Leading is shown as a bare multiplier** (1.2, step 0.1) with "Auto"; AE shows leading in the size's units (px) with Auto = 120 %. The Leading, Size and Tracking cells are plain `<input type=number>` — no scrubbing, no arrow-key nudging, unlike every other numeric row in the app (`ValueField`). | `CharacterPanel.tsx` `sizeCell`, `leadingCell`, `trackingCell` | medium — "controlling them is poor" |
| T5 | **Point text ignores its alignment for anchoring.** A left-aligned single-line text is centred on its position exactly like a centred one (every "left" row in A–J is centred on x); alignment only re-flows lines inside the measured box. In AE the anchor sits at the alignment edge, so a typed-on or growing left-aligned title grows to the right. (Known as report #17.) | `native/engine/src/scene/snapshot_build.cpp` (anchor from `read_node_anchor`), `text_query.cpp` `line_block_anchor_x` | high — alignment buttons "do nothing" |
| T6 | **No italic control in the Character panel.** `fontStyle` is a real field, but the panel exposes it only through the font picker's face strip (and "Faux Italic", which is synthetic). AE's panel has a style menu per family. | `CharacterPanel.tsx` `fontRow` | medium |
| T7 | **The AI tools reject AE's justification modes and cannot set italic or tracking in AE units.** `update_layer { align: 'justify' }` fails with "must be one of: left, center, right"; there is no `fontStyle`; `letterSpacing` is pixels. | `src/core/ai/toolHandlers.ts`, the tool schema | medium — every AI-authored paragraph is ragged, no italics |
| T8 | **Per-range small caps and all caps indices.** With T2 fixed these work; noted because the panel applies them to the *grapheme* range of the selection, which is right. | — | — |
| T9 | **Weight menu is a native `<select>`** of the family's real weights (good: it now comes from the engine's list, 2026-10-16) but a weight the family lacks is only flagged with " — not in this font"; the nearest real weight is drawn by CSS matching (correct) — no silent regular. Verified: Segoe UI 900 → Black, 600 → Semibold, 300 → Light (D2). | `CharacterPanel.tsx`, `src/core/fonts/engineFontList.ts` | ok |
| T10 | **Test-port engines list no installed fonts** (`listFonts` → `[]` under `--test-ports`), so the font picker cannot be exercised on the headless harness. | `native/engine/src/engine_process.cpp` | low (tests only) |
| T11 | **Glyph profile.** The app rasterises with the "Chromium Windows" profile (DirectWrite backend, slight hinting, LCD-derived grey masks) — chosen for parity with the recorded TS rasters, not FreeType as CLAUDE.md's determinism rule says. Looks good on this machine; macOS/Linux use FreeType, so cross-OS renders of the same project differ by a hint. Left as is; noted. | `engine_frames.hpp` `chromiumProfile = true` | note |

Not reproduced: blurry text at Full, shimmer under scale (the tier ladder and
subpixel positioning are intact), broken weights of bundled families, CJK
boxes with a named or bundled font, 3D extrusion artefacts on Inter/Playfair
(G) beyond the known serif-cap issues already fixed on 2026-10-13.

## 4. Fixes

Engine (`native/engine`), each with a native test:

- **T1** `add_system_family` now derives a face's weight and italic from the
  file itself (OS/2 `usWeightClass` / `fsSelection`, `head.macStyle`) and
  registers each distinct (file bytes, collection index) once, so DirectWrite's
  simulated obliques/bolds collapse into their real file. A request for a
  style the family really lacks gets the engine's own synthesis (embolden /
  skew), as before for bundled faces. Test: `test_raster_canvas.cpp`
  "system family: simulated obliques do not shadow the real italic".
- **T2** `FontSet::shape` synthesizes small caps when the primary face has no
  `smcp`: lowercase code points are shaped as their capitals at 0.7× the size
  (Blink's `kSmallCapsFontSizeMultiplier`); a font with `smcp` still uses its
  own. `Glyph.sizeScale` carries the factor to every consumer (canvas draw,
  SVG text, ink bounds, metrics). Test: "small caps synthesize for a face
  without smcp, use the feature when present".
- **T3** New static Text field `tracking` (1/1000 em, AE's unit; keyframes
  stay on the px `letterSpacing`). The snapshot resolves it to px at the
  layer's font size (`letterSpacing += tracking × fontSize / 1000`) for both
  the measurer and the painter, so changing the size keeps the look. Both
  catalogs (`textFields.ts`, `catalog/fields.json`) carry it.
- **T5** New static Text field `anchor`: `center` (what every existing
  document does) or `alignment` (AE: the anchor at the alignment edge — left,
  centre or right of the content; vertical stays the box centre). The
  snapshot offsets the layer's anchor by half the content width when
  `alignment` is on; an explicit Anchor Point value adds to it, as in AE.
  New text layers made in the editor use `alignment`; documents and the AI
  tools keep `center` unless asked.

Editor (`src/layout/Inspector/CharacterPanel.tsx`, `src/layout/Text/textEdits.ts`):

- **T3/T4** Size, Leading and Tracking are `ValueField`s (scrub, arrows,
  Shift ×10) — one undo entry per drag or typing session, through the engine
  route as before. Tracking edits `text/tracking` in 1/1000 em (a legacy px
  `letterSpacing` is shown as its em equivalent and migrated on the first
  write). Leading shows px with Auto (= 120 %), stored as the multiplier the
  engine reads, so the timeline row is unchanged.
- **T6** A Style menu (Regular / Italic, plus the family's real faces) next to
  the weight menu, writing `text/fontStyle`.
- **T5** Paragraph panel: an Anchor row (Center / Alignment edge).
- **T7** `update_layer` accepts every `align` the engine does, `fontStyle`,
  and `tracking` (AE units); `letterSpacing` stays as the px escape hatch.

## 5. After

The same scenes re-rendered with the rebuilt engine are in
`docs/assets/text-audit-2026-10-18/after/`; `K-after-fixes.png` shows the four
fixes together (a red hairline marks x = 960):

- Arial, Segoe UI, Times New Roman and Georgia italics draw their italic faces
  (`J-italics-caps.png` after vs before); Georgia Bold Italic picks the bold
  italic file.
- "small caps on Inter now" draws capitals at 0.7 (Inter has no `smcp`);
  Arial's own small caps are unchanged.
- `tracking = 100` opens "Tracking 100 at 40px" and "…at 120px" by the same
  tenth of an em per gap (the before still `J` shows 20 px doing half an em at
  40 px and a sixth at 120 px).
- "Left anchored at 960" starts on the hairline, "Right anchored" ends on it,
  "Centre anchored" straddles it; the legacy row stays centred.

Gates run on this machine (RTX, Windows 11, 2026-10-19):

- `engine_raster_tests "[fonts]"`: 13 passed, 1 skipped (fontconfig), including
  the two new cases.
- `src/core/engine/textQuality.native.test.ts` (GPU): T1 system italic, T2
  small caps, T3 tracking at two sizes, T5 anchor edge, T7 `update_layer`
  justify/italic/tracking — 5 passed.
- Character panel suites on the engine (`TextPanel`, `TextSection`,
  `textViaEngine` `*.native.test.tsx`): 35 passed after the ValueField /
  tracking rewrites (a Tracking commit writes `text/tracking`; a legacy px
  `letterSpacing` folds into it on the first write as ONE entry).
- Native golden gate over the 25 text scenes: 24/24 gated frames match,
  26/26 ported (`node packages/render-tests/scripts/native-golden.mjs --only
  <text scenes>`), so no existing document renders differently: `tracking`
  and `textAnchor` default off, and no scene relied on a simulated system
  face or on small caps.
- `tsc --noEmit` clean; `npm run lint` within the warning budget.

Closed 2026-10-19 (the three anchoring gaps the first pass left):

- **First baseline.** With `textAnchor: alignment`, horizontal point text now
  anchors on its first baseline, not the box centre (AE's text origin).
  `point_text_anchor` (`text_query.cpp`) takes the first line's centre-origin
  y from `paragraph_line_stack` and adds the face's baseline-below-middle,
  which the measurer probes as the difference between the alphabetic and
  middle `fontBoundingBoxAscent` (`TextMeasurer::baseline_below_middle`); the
  Character panel's vertical scale and baseline shift apply as the painter
  does. A paragraph box keeps the centre (its lines sit against the box).
- **Vertical type.** The same anchor puts a vertical column's top edge (align
  left), centre, or bottom edge (align right) at the layer's position; x stays
  the column centre.
- **Per-range tracking.** A run now carries `tracking` (1/1000 em; the key is
  in both run-key lists), resolved at the RUN's font size: raster
  `TextStyle::merged` re-resolves the spacing when a run sets `tracking` or
  changes the size under a layer tracking (a legacy px `letterSpacing` run
  alone still replaces the spacing outright), and the scene measurer carries
  `spacingRuns` into point text's widths and glyph pens. The snapshot passes
  the layer's `tracking` beside its folded `letterSpacing` so a run can undo
  the fold; Source Text expression ranges store `tracking` on their runs
  instead of px. The Character panel's ranged Tracking writes `tracking` (and
  clears a legacy px on the run); a legacy px run still reads back at its
  size. A wrapped paragraph keeps the uniform spacing in the measurer (its
  soft breaks re-index the content) — the painter resolves it per glyph.

Gates (2026-10-19): `engine_scene_tests "[anchor],[tracking]"`
(`tests/test_text_anchor_tracking.cpp`: 7 cases), the GPU suite's T8 (first
baseline, one and two lines), T9 (vertical top / bottom), T10 (a tracking run
doubles its px when the size doubles), the native golden gate over the text
scenes, `tsc` and `npm run lint` — see the hand-over note for the counts.

Left open (not regressions):

- The Leading field shows px but the timeline row stays the multiple of the
  font size; the engine field is unchanged.
- A paragraph box with `textAnchor: alignment` anchors at its box edge and
  centre line, not AE's box top-left; a point text with size runs anchors on
  the layer size's baseline (the painter draws every size on the line's
  middle).
- The glyph profile (T11) and miter spikes (§2) are as noted; the test-port
  engine still lists no installed fonts (T10).
