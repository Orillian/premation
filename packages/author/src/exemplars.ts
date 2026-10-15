/**
 * Nine scene scripts the author prompt shows as a REFERENCE: one, picked at
 * random among the ones whose keywords match the brief (weighted by how many
 * match), else at random among all of them.
 *
 * They are what a finished script looks like, not templates: every colour,
 * size, time and ease in them is a decision for THAT brief. They differ on
 * purpose — light and dark (at most a third dark), type-led, image-led,
 * shape-led, ink, product UI and lit 3D — because a model copies the palette,
 * the staging and the medium of the one example it is shown. The last three
 * it was shown were all near-black, centred and flat, and so was its work
 * (docs/AUDIT_2026-10-15_CACHE_AI_CEILING.md §2).
 *
 * All are written for 1920×1080 and must coerce with zero repairs and compile
 * to calls every tool schema accepts (`compile.test.ts`); the native suite
 * builds each one on the engine (`authorExemplars.native.test.ts`).
 */

import type { SceneScript } from './types';

export interface AuthorExemplar {
  id: string;
  /** Lowercase keywords matched against the prompt. */
  keywords: readonly string[];
  /** What it demonstrates, in a sentence. */
  lesson: string;
  /** The background is dark (a third of the set at most). */
  dark: boolean;
  script: SceneScript;
}

/** Points on an arc (layer px), pen pressure swelling mid-stroke — a brush circle. */
function brushArc(cx: number, cy: number, r: number, fromDeg: number, toDeg: number, steps: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = ((fromDeg + (toDeg - fromDeg) * t) * Math.PI) / 180;
    // A hand's circle is not a circle: the radius breathes a little.
    const rr = r * (1 + 0.04 * Math.sin(t * Math.PI * 3));
    const pressure = Math.round((0.35 + 0.65 * Math.sin(t * Math.PI) ** 0.7) * 100) / 100;
    out.push([Math.round(cx + rr * Math.cos(a)), Math.round(cy + rr * Math.sin(a)), pressure]);
  }
  return out;
}

// ── 1. Lit 3D product, light studio ─────────────────────────────────────

const productReveal: SceneScript = {
  title: 'Halo One — studio reveal',
  intent: '3D-led. An anodized cobalt slab sits in a pale studio; a warm key light finds it while the camera pushes in for the whole piece, and the name arrives as real extruded type in the same light. Signature: the light moving across anodized metal.',
  durationSec: 8,
  background: '$studio',
  palette: { studio: '#e7eaef', floor: '#dde1e8', cobalt: '#2f56b0', ink: '#14181f', mute: '#626b78', ember: '#ff5a1f' },
  grid: { columns: 12, gutter: 24, margin: 144, baseline: 8 },
  type: {
    display: { family: 'Inter', weight: 800, size: 128, tracking: -4, leading: 0.95 },
    body: { family: 'Inter', weight: 500, size: 30, tracking: 1, leading: 1.4 },
  },
  globals: [
    { id: 'floor', kind: 'solid', name: 'Floor', role: 'background', props: { x: 960, y: 760, width: 12000, height: 12000, fill: '$floor', threeD: true, rotationX: 90, acceptsLights: true, acceptsShadows: true } },
    {
      id: 'slab', kind: 'shape', shape: 'rect', name: 'Halo slab', role: 'hero',
      props: { x: 960, y: 560, width: 540, height: 330, cornerRadius: 56, fill: '$cobalt', threeD: true, extrusionDepth: 70, bevelDepth: 10, bevelStyle: 'convex', shading: 'pbr', metal: 70, roughness: 28, acceptsLights: true, castsShadows: 'on' },
      keys: {
        rotationY: [{ t: 0, v: -38, ease: 'easeInOut' }, { t: 8, v: -8 }],
        opacity: [{ t: 0, v: 0, ease: 'easeOut' }, { t: 0.8, v: 100 }],
        roughness: [{ t: 1, v: 45, ease: 'easeInOut' }, { t: 4, v: 22 }],
      },
    },
    { id: 'sky', kind: 'light', name: 'Studio environment', light: { type: 'environment', environment: 'studio', intensity: 110 } },
    {
      id: 'key', kind: 'light', name: 'Key', props: { x: 520, y: 140, z: -900 },
      light: { type: 'spot', color: '#ffd8b0', intensity: 135, coneAngle: 58, coneFeather: 70, castsShadows: true, shadowDarkness: 55, shadowDiffusion: 45, pointOfInterest: { x: 960, y: 560, z: 0 } },
      keys: { intensity: [{ t: 0, v: 0, ease: 'easeOut' }, { t: 2.2, v: 135 }], poiX: [{ t: 0, v: 760, ease: 'easeInOut' }, { t: 8, v: 1080 }] },
    },
    { id: 'rim', kind: 'light', name: 'Cool rim', props: { x: 1500, y: 260, z: 700 }, light: { type: 'point', color: '#a9c8ff', intensity: 70 } },
    {
      id: 'cam', kind: 'camera', name: 'Slow push', props: { focalLength: 1800 },
      keys: { z: [{ t: 0, v: -2700, ease: 'easeInOut' }, { t: 8, v: -1900 }], x: [{ t: 0, v: 860, ease: 'easeInOut' }, { t: 8, v: 1000 }] },
    },
    { id: 'grade', kind: 'adjustment', name: 'Vignette', role: 'ambient', stack: 'front', props: { x: 960, y: 540, width: 1920, height: 1080 }, effects: [{ type: 'vignette', params: { amount: 14, size: 120, feather: 160 } }] },
  ],
  beats: [
    {
      name: 'Light finds it', purpose: 'The object before its name: light rakes across the metal.', startSec: 0, endSec: 2.6,
      layers: [
        {
          id: 'line', kind: 'text', name: 'Machined line', role: 'support', text: 'Machined from a single block.', typeStyle: 'body',
          props: { x: 560, y: 196, fill: '$mute', align: 'left', width: 760 },
          keys: { opacity: [{ t: 0.9, v: 0, ease: 'easeOut' }, { t: 1.4, v: 100 }, { t: 2.2, v: 100, ease: 'easeIn' }, { t: 2.6, v: 0 }], y: [{ t: 0.9, v: 220, ease: 'easeOut' }, { t: 1.6, v: 196 }] },
        },
      ],
    },
    {
      name: 'The name', purpose: 'The name lands in the same light, as real type with depth.', startSec: 2.6, endSec: 5.6,
      layers: [
        {
          id: 'name', kind: 'text', name: 'Halo One', role: 'hero', text: 'Halo One', typeStyle: 'display',
          props: { x: 960, y: 250, z: -160, fill: '$ink', align: 'center', width: 1400, threeD: true, extrusionDepth: 18, bevelDepth: 3, shading: 'pbr', metal: 0, roughness: 35, acceptsLights: true },
          textAnimators: [{ basedOn: 'characters', opacity: 0, y: 40, blur: 10, sweep: { from: 0.1, to: 1.0, ease: 'bezier', bezier: [0.22, 1, 0.36, 1] } }],
          keys: { extrusionDepth: [{ t: 0.4, v: 0, ease: 'easeOut' }, { t: 1.6, v: 18 }] },
        },
        {
          id: 'tick', kind: 'shape', shape: 'line', name: 'Ember rule', role: 'support',
          props: { x: 960, y: 336, z: -160, threeD: true, width: 220, height: 4, stroke: '$ember', strokeWidth: 4 },
          trim: { end: 0, keys: { end: [{ t: 1.0, v: 0, ease: 'bezier', bezier: [0.65, 0, 0.35, 1] }, { t: 1.7, v: 100 }] } },
        },
      ],
    },
    {
      name: 'Availability', purpose: 'One quiet line while the push finishes; the light settles.', startSec: 5.6, endSec: 8,
      layers: [
        {
          id: 'date', kind: 'text', name: 'Date', role: 'support', text: 'Available October 24', typeStyle: 'body',
          props: { x: 960, y: 900, fill: '$ink', align: 'center', width: 900 },
          keys: { opacity: [{ t: 0.2, v: 0, ease: 'easeOut' }, { t: 0.7, v: 100 }], letterSpacing: [{ t: 0.2, v: 8, ease: 'easeOut' }, { t: 2.2, v: 1 }] },
        },
      ],
    },
  ],
};

// ── 2. Editorial type on paper ──────────────────────────────────────────

const kineticQuote: SceneScript = {
  title: 'Make it move like it means it',
  intent: 'Type-led editorial: warm paper, a heavy serif set off-centre on a hanging left edge, words arriving on a breathing beat, one red word that keeps living and a rule that draws the reading line.',
  durationSec: 8,
  background: '$paper',
  palette: { paper: '#f2ede3', ink: '#1c1a17', red: '#d6402b', dim: '#8a8478' },
  grid: { columns: 8, gutter: 32, margin: 180, baseline: 12 },
  type: {
    quote: { family: 'Noto Serif', weight: 800, size: 124, tracking: -3, leading: 0.98 },
    credit: { family: 'Inter', weight: 500, size: 24, tracking: 4, leading: 1.3 },
  },
  globals: [
    { id: 'paper_grain', kind: 'adjustment', name: 'Paper grain', role: 'ambient', stack: 'front', props: { x: 960, y: 540, width: 1920, height: 1080 }, effects: [{ type: 'add-grain', params: { intensity: 5, size: 1.4, saturation: 0 } }] },
  ],
  beats: [
    {
      name: 'The line', purpose: 'Read the phrase on a breathing beat down a hanging left edge.', startSec: 0, endSec: 5.8,
      layers: [
        {
          id: 'rule', kind: 'shape', shape: 'line', name: 'Margin rule', role: 'support',
          props: { x: 180, y: 540, width: 4, height: 520, stroke: '$red', strokeWidth: 3 },
          trim: { end: 0, keys: { end: [{ t: 0, v: 0, ease: 'bezier', bezier: [0.65, 0, 0.35, 1] }, { t: 1.4, v: 100 }] } },
        },
        {
          id: 'line_a', kind: 'text', name: 'Make it move', role: 'support', text: 'Make it move', typeStyle: 'quote',
          props: { x: 840, y: 400, fill: '$ink', align: 'left', width: 1240 },
          textAnimators: [{ basedOn: 'words', opacity: 0, y: 46, skew: 10, sweep: { from: 0.3, to: 1.2, ease: 'bezier', bezier: [0.22, 1, 0.36, 1] } }],
        },
        {
          id: 'line_b', kind: 'text', name: 'like it', role: 'support', text: 'like it', typeStyle: 'quote',
          props: { x: 640, y: 540, fill: '$ink', align: 'left', width: 840 },
          textAnimators: [{ basedOn: 'words', opacity: 0, y: 46, sweep: { from: 1.4, to: 1.9, ease: 'easeOut' } }],
        },
        {
          id: 'means', kind: 'text', name: 'means', role: 'hero', text: 'means', typeStyle: 'quote',
          props: { x: 1210, y: 540, fontSize: 168, fill: '$red', align: 'left', width: 900, anchorX: -300 },
          keys: {
            scale: [{ t: 2.1, v: 0.4, ease: 'bezier', bezier: [0.34, 1.56, 0.64, 1] }, { t: 2.6, v: 1 }],
            opacity: [{ t: 2.1, v: 0, ease: 'easeOut' }, { t: 2.25, v: 100 }],
          },
          expressions: { rotation: 'time > 2.6 ? Math.sin((time - 2.6) * 2.2) * 2 : 0' },
        },
        {
          id: 'it_means', kind: 'text', name: 'it', role: 'support', text: 'it', typeStyle: 'quote',
          props: { x: 640, y: 680, fill: '$ink', align: 'left', width: 600 },
          keys: { opacity: [{ t: 3.0, v: 0, ease: 'easeOut' }, { t: 3.3, v: 100 }], x: [{ t: 3.0, v: 600, ease: 'easeOut' }, { t: 3.5, v: 640 }] },
        },
      ],
    },
    {
      name: 'Credit', purpose: 'A quiet attribution under the held quote.', startSec: 5.8, endSec: 8,
      layers: [
        {
          id: 'credit', kind: 'text', name: 'Credit', role: 'support', text: '— EVERY GOOD ANIMATOR', typeStyle: 'credit',
          props: { x: 560, y: 880, fill: '$dim', align: 'left', width: 760 },
          keys: { opacity: [{ t: 0.2, v: 0, ease: 'easeOut' }, { t: 0.8, v: 100 }], letterSpacing: [{ t: 0.2, v: 14, ease: 'easeOut' }, { t: 1.8, v: 4 }] },
        },
      ],
    },
  ],
};

// ── 3. Flat Swiss ident ────────────────────────────────────────────────

const logoSting: SceneScript = {
  title: 'NOVA — Swiss ident',
  intent: 'Shape-led and flat: a saturated red field, black bars on a strict grid that slide in on hard eases, a white disc that pops, a heavy grotesk name set big and tight, and a black panel that wipes the frame shut.',
  durationSec: 5,
  background: '$red',
  palette: { red: '#e5372a', black: '#121212', white: '#f6f3ec' },
  grid: { columns: 12, gutter: 20, margin: 120, baseline: 8 },
  type: { word: { family: 'Inter', weight: 900, size: 230, tracking: -10, leading: 0.9 } },
  globals: [],
  beats: [
    {
      name: 'Build', purpose: 'Grid bars, disc, name — each move timed off the last.', startSec: 0, endSec: 4.2,
      layers: [
        {
          id: 'bar_a', kind: 'shape', shape: 'rect', name: 'Bar A', role: 'support',
          props: { x: 560, y: 300, width: 880, height: 64, fill: '$black' },
          keys: { x: [{ t: 0, v: -500, ease: 'bezier', bezier: [0.7, 0, 0.2, 1] }, { t: 0.55, v: 560 }] },
        },
        {
          id: 'bar_b', kind: 'shape', shape: 'rect', name: 'Bar B', role: 'support',
          props: { x: 440, y: 392, width: 640, height: 64, fill: '$black' },
          keys: { x: [{ t: 0.12, v: -500, ease: 'bezier', bezier: [0.7, 0, 0.2, 1] }, { t: 0.62, v: 440 }] },
        },
        {
          id: 'disc', kind: 'shape', shape: 'ellipse', name: 'Disc', role: 'support',
          props: { x: 1500, y: 346, width: 156, height: 156, fill: '$white' },
          keys: { scale: [{ t: 0.7, v: 0, ease: 'bezier', bezier: [0.34, 1.56, 0.64, 1] }, { t: 1.05, v: 1 }] },
        },
        {
          id: 'word', kind: 'text', name: 'NOVA', role: 'hero', text: 'NOVA', typeStyle: 'word',
          props: { x: 760, y: 700, fill: '$black', align: 'left', width: 1300 },
          textAnimators: [{ basedOn: 'characters', y: 160, opacity: 0, sweep: { from: 1.0, to: 1.6, ease: 'bezier', bezier: [0.16, 1, 0.3, 1] } }],
        },
        {
          id: 'credit', kind: 'text', name: 'Studio', role: 'support', text: 'Studio for sound', typeStyle: 'word',
          props: { x: 1450, y: 860, fontSize: 34, fontWeight: 600, letterSpacing: 0, fill: '$white', align: 'left', width: 520 },
          keys: { opacity: [{ t: 1.7, v: 0, ease: 'easeOut' }, { t: 2.0, v: 100 }] },
        },
      ],
    },
    {
      name: 'Shut', purpose: 'A black panel wipes the frame closed — a sting ends.', startSec: 4.2, endSec: 5,
      layers: [
        {
          id: 'panel', kind: 'solid', name: 'Black panel', props: { x: 960, y: 540, width: 1920, height: 1080, fill: '$black' },
          keys: { x: [{ t: 0, v: -960, ease: 'bezier', bezier: [0.7, 0, 0.2, 1] }, { t: 0.45, v: 960 }] },
        },
      ],
    },
  ],
};

// ── 4. Dark 3D — primitives under an orbit ─────────────────────────────

const cosmic3d: SceneScript = {
  title: 'Saturn Season',
  intent: '3D-led and dark: a real sphere and a chrome ring lit from behind by a cold rim and a warm key, the camera orbiting slowly so the ring sweeps across the planet; a small title holds the corner.',
  durationSec: 6,
  background: '$space',
  palette: { space: '#07080d', deep: '#101a33', planet: '#3d5bd9', gold: '#e8c47a', bone: '#ece6da' },
  grid: { columns: 12, gutter: 24, margin: 120, baseline: 8 },
  type: { title: { family: 'Noto Sans', weight: 500, size: 60, tracking: 6, leading: 1 } },
  globals: [
    { id: 'haze', kind: 'gradient', name: 'Deep haze', role: 'background', gradient: { stops: ['$deep', '$space'], kind: 'radial', centerX: 62, centerY: 45, radius: 90 } },
    {
      id: 'planet', kind: 'primitive', name: 'Planet', role: 'hero',
      props: { primitive: 'sphere', radius: 300, x: 1150, y: 520, fill: '$planet', shading: 'pbr', metal: 10, roughness: 62 },
      keys: { rotationY: [{ t: 0, v: 0 }, { t: 6, v: 40 }] },
    },
    {
      id: 'ring', kind: 'primitive', name: 'Ring', role: 'support',
      props: { primitive: 'torus', radius: 480, tube: 11, x: 1150, y: 520, rotationX: 72, fill: '$gold', shading: 'pbr', metal: 100, roughness: 10 },
      keys: { rotationY: [{ t: 0, v: -12, ease: 'easeInOut' }, { t: 6, v: 12 }] },
    },
    { id: 'env', kind: 'light', name: 'Sunset environment', light: { type: 'environment', environment: 'sunset', intensity: 80 } },
    { id: 'key', kind: 'light', name: 'Warm key', props: { x: 400, y: 200, z: -700 }, light: { type: 'point', color: '#ffcf9e', intensity: 120, falloff: 'smooth', falloffDistance: 2600 } },
    { id: 'rim', kind: 'light', name: 'Cold rim', props: { x: 1700, y: 300, z: 900 }, light: { type: 'spot', color: '#8fb8ff', intensity: 160, coneAngle: 50, coneFeather: 80, pointOfInterest: { x: 1150, y: 520, z: 0 } } },
    {
      id: 'cam', kind: 'camera', name: 'Orbit', props: { focalLength: 2100 },
      keys: { orbitYaw: [{ t: 0, v: -22, ease: 'easeInOut' }, { t: 6, v: 14 }], orbitPitch: [{ t: 0, v: 6, ease: 'easeInOut' }, { t: 6, v: -4 }] },
    },
  ],
  beats: [
    {
      name: 'Approach', purpose: 'Only the light on the forms; the orbit reveals the ring.', startSec: 0, endSec: 2.8,
      layers: [
        {
          id: 'veil', kind: 'solid', name: 'Fade from black', props: { x: 960, y: 540, width: 1920, height: 1080, fill: '$space' },
          keys: { opacity: [{ t: 0, v: 100, ease: 'easeInOut' }, { t: 1.6, v: 0 }] },
        },
      ],
    },
    {
      name: 'Title', purpose: 'A small title in the corner while the orbit carries on.', startSec: 2.8, endSec: 6,
      layers: [
        {
          id: 'title', kind: 'text', name: 'Saturn Season', role: 'support', text: 'Saturn Season', typeStyle: 'title',
          props: { x: 470, y: 900, fill: '$bone', align: 'left', width: 700 },
          textAnimators: [{ basedOn: 'characters', opacity: 0, blur: 12, sweep: { from: 0.2, to: 1.2, ease: 'easeOut' } }],
          keys: { letterSpacing: [{ t: 0.2, v: 14, ease: 'easeOut' }, { t: 3.0, v: 2 }] },
        },
      ],
    },
  ],
};

// ── 5. Image-led ───────────────────────────────────────────────────────

const imageLed: SceneScript = {
  title: 'Still Water — retreat',
  intent: 'Image-led: one generated photograph carries the mood; it drifts in a slow push the whole time, and light serif type sits in its calm upper third with a hairline that draws under it.',
  durationSec: 7,
  background: '$mist',
  palette: { mist: '#d9d3cb', cream: '#fbf7f1', shade: '#3a3530' },
  grid: { columns: 12, gutter: 24, margin: 160, baseline: 8 },
  type: {
    title: { family: 'Noto Serif', weight: 300, size: 132, tracking: -2, leading: 1 },
    small: { family: 'Inter', weight: 500, size: 24, tracking: 5, leading: 1.3 },
  },
  globals: [
    {
      id: 'plate', kind: 'image', name: 'Lake plate', role: 'background',
      image: { prompt: 'Misty alpine lake at dawn, soft pink and grey light, still water, distant pines, wide calm composition with empty sky in the upper third, photographic, no text', aspect: 'landscape' },
      props: { x: 960, y: 540, scale: 1.12 },
      keys: { scale: [{ t: 0, v: 1.12, ease: 'easeOut' }, { t: 7, v: 1.0 }], x: [{ t: 0, v: 1000, ease: 'easeOut' }, { t: 7, v: 960 }] },
    },
    { id: 'soften', kind: 'adjustment', name: 'Soft grade', role: 'ambient', stack: 'front', props: { x: 960, y: 540, width: 1920, height: 1080 }, effects: [{ type: 'vignette', params: { amount: 18, size: 110, feather: 180 } }, { type: 'add-grain', params: { intensity: 4, size: 1.2, saturation: 0 } }] },
  ],
  beats: [
    {
      name: 'Arrive', purpose: 'The image alone, then the name in the sky.', startSec: 0, endSec: 4.4,
      layers: [
        {
          id: 'title', kind: 'text', name: 'Still water', role: 'hero', text: 'Still water', typeStyle: 'title',
          props: { x: 960, y: 290, fill: '$cream', align: 'center', width: 1400 },
          effects: [{ type: 'drop-shadow', params: { distance: 0, softness: 60, opacity: 30, color: '$shade' } }],
          textAnimators: [{ basedOn: 'characters', opacity: 0, blur: 16, sweep: { from: 1.0, to: 2.6, ease: 'easeOut' } }],
        },
        {
          id: 'hair', kind: 'shape', shape: 'line', name: 'Hairline', role: 'support',
          props: { x: 960, y: 392, width: 240, height: 2, stroke: '$cream', strokeWidth: 2 },
          trim: { start: 50, end: 50, keys: { start: [{ t: 2.4, v: 50, ease: 'easeInOut' }, { t: 3.4, v: 0 }], end: [{ t: 2.4, v: 50, ease: 'easeInOut' }, { t: 3.4, v: 100 }] } },
        },
      ],
    },
    {
      name: 'Place', purpose: 'Where it is, small, while the push finishes.', startSec: 4.4, endSec: 7,
      layers: [
        {
          id: 'place', kind: 'text', name: 'Place', role: 'support', text: 'LAKE ORTA  ·  WINTER RETREATS', typeStyle: 'small',
          props: { x: 960, y: 446, fill: '$cream', align: 'center', width: 1000 },
          keys: { opacity: [{ t: 0.1, v: 0, ease: 'easeOut' }, { t: 0.8, v: 100 }], y: [{ t: 0.1, v: 462, ease: 'easeOut' }, { t: 0.9, v: 446 }] },
        },
      ],
    },
  ],
};

// ── 6. Ink ─────────────────────────────────────────────────────────────

const inkEnso: SceneScript = {
  title: 'Begin again — ensō',
  intent: 'Ink-led: one brush circle drawn on rice paper with real pressure, a second flick, a red seal that presses in, and a quiet line of type set low and to the left.',
  durationSec: 6,
  background: '$rice',
  palette: { rice: '#efe6d3', ink: '#161412', seal: '#b3261e', grey: '#7d7568' },
  grid: { columns: 8, gutter: 32, margin: 160, baseline: 12 },
  type: { line: { family: 'Noto Serif', weight: 400, size: 46, tracking: 1, leading: 1.2 } },
  globals: [
    { id: 'fibre', kind: 'adjustment', name: 'Paper fibre', role: 'ambient', stack: 'front', props: { x: 960, y: 540, width: 1920, height: 1080 }, effects: [{ type: 'noise', params: { amount: 4, monochrome: true }, keys: { evolution: [{ t: 0, v: 0 }, { t: 6, v: 300 }] } }] },
  ],
  beats: [
    {
      name: 'The circle', purpose: 'The brush draws the ensō in one breath; the flick answers it.', startSec: 0, endSec: 3.6,
      layers: [
        {
          id: 'enso', kind: 'solid', name: 'Ensō', role: 'hero', outSec: 6,
          props: { x: 1080, y: 500, width: 760, height: 760, fill: '$rice' },
          paint: [
            { points: brushArc(380, 380, 270, 205, 520, 36), color: '$ink', size: 60, hardness: 65, minSize: 10, reveal: { from: 0.2, to: 2.2 } },
            { points: [[600, 600, 0.9], [640, 650, 0.6], [690, 690, 0.25]], color: '$ink', size: 30, hardness: 80, minSize: 10, reveal: { from: 2.3, to: 2.6 } },
          ],
        },
      ],
    },
    {
      name: 'Seal and line', purpose: 'The seal presses in; the line settles below.', startSec: 3.6, endSec: 6,
      layers: [
        {
          id: 'seal', kind: 'shape', shape: 'rect', name: 'Seal', role: 'support',
          props: { x: 1420, y: 820, width: 84, height: 84, cornerRadius: 10, fill: '$seal', rotation: -4 },
          keys: { scale: [{ t: 0, v: 1.6, ease: 'bezier', bezier: [0.2, 0, 0.1, 1] }, { t: 0.35, v: 1 }], opacity: [{ t: 0, v: 0 }, { t: 0.12, v: 100 }] },
        },
        {
          id: 'line', kind: 'text', name: 'Begin again', role: 'support', text: 'Begin again.', typeStyle: 'line',
          props: { x: 520, y: 860, fill: '$grey', align: 'left', width: 700 },
          keys: { opacity: [{ t: 0.5, v: 0, ease: 'easeOut' }, { t: 1.2, v: 100 }] },
        },
      ],
    },
  ],
};

// ── 7. Product UI on white ─────────────────────────────────────────────

const dataUi: SceneScript = {
  title: 'Ledger — weekly growth',
  intent: 'Product UI on a white canvas: one card with real depth (a layered soft shadow), a number that lands with overshoot, bars that grow from their base in a stagger, and a trend line that draws through them.',
  durationSec: 7,
  background: '$canvas',
  palette: { canvas: '#f5f7fa', card: '#ffffff', ink: '#111827', mute: '#6b7280', blue: '#2f6bff', green: '#12a466' },
  grid: { columns: 12, gutter: 24, margin: 160, baseline: 8 },
  type: {
    figure: { family: 'Inter', weight: 700, size: 112, tracking: -4, leading: 1 },
    label: { family: 'Inter', weight: 500, size: 26, tracking: 0.2, leading: 1.3 },
  },
  globals: [],
  beats: [
    {
      name: 'Card', purpose: 'The card rises onto the canvas; the figure lands.', startSec: 0, endSec: 3.4,
      layers: [
        {
          id: 'card', kind: 'shape', shape: 'rect', name: 'Card', role: 'ui', outSec: 7,
          props: { x: 960, y: 540, width: 1040, height: 600, cornerRadius: 32, fill: '$card' },
          effects: [{ type: 'drop-shadow', params: { distance: 28, angle: 90, softness: 70, opacity: 14, color: '#1b2a4a' } }],
          keys: { y: [{ t: 0, v: 590, ease: 'bezier', bezier: [0.22, 1, 0.36, 1] }, { t: 0.7, v: 540 }], opacity: [{ t: 0, v: 0, ease: 'easeOut' }, { t: 0.4, v: 100 }] },
        },
        {
          id: 'label', kind: 'text', name: 'Label', role: 'ui', text: 'Weekly revenue', typeStyle: 'label', outSec: 7,
          props: { x: 760, y: 320, fill: '$mute', align: 'left', width: 560 },
          keys: { opacity: [{ t: 0.4, v: 0, ease: 'easeOut' }, { t: 0.8, v: 100 }] },
        },
        {
          id: 'figure', kind: 'text', name: 'Figure', role: 'hero', text: '+38%', typeStyle: 'figure', outSec: 7,
          props: { x: 760, y: 410, fill: '$green', align: 'left', width: 560 },
          keys: {
            scale: [{ t: 0.6, v: 0.85, ease: 'bezier', bezier: [0.34, 1.56, 0.64, 1] }, { t: 1.1, v: 1 }],
            opacity: [{ t: 0.6, v: 0, ease: 'easeOut' }, { t: 0.8, v: 100 }],
          },
        },
      ],
    },
    {
      name: 'Bars', purpose: 'The week grows bar by bar; the trend draws through it.', startSec: 3.4, endSec: 7,
      layers: [
        {
          id: 'bars', kind: 'shape', shape: 'rect', name: 'Bars', role: 'ui',
          props: { x: 780, y: 700, width: 56, height: 160, cornerRadius: 10, fill: '$blue', anchorY: 80 },
          repeaters: [{ copies: 5, positionX: 96, startOpacity: 55, endOpacity: 100 }],
          keys: { scaleY: [{ t: 0, v: 0, ease: 'bezier', bezier: [0.22, 1, 0.36, 1] }, { t: 0.9, v: 1 }] },
        },
        {
          id: 'trend', kind: 'shape', shape: 'line', name: 'Trend', role: 'ui',
          props: { x: 975, y: 640, width: 420, height: 120, rotation: -14, stroke: '$ink', strokeWidth: 4 },
          trim: { end: 0, keys: { end: [{ t: 0.8, v: 0, ease: 'easeInOut' }, { t: 1.8, v: 100 }] } },
        },
      ],
    },
  ],
};

// ── 8. Dark neon type ──────────────────────────────────────────────────

const neonType: SceneScript = {
  title: 'AFTER HOURS',
  intent: 'Type-led and dark for a club night: a scanline grid draws itself, the wide-tracked name hits with chromatic split that resolves, a magenta glow breathes on the beat.',
  durationSec: 5,
  background: '$night',
  palette: { night: '#07060b', magenta: '#ff2e88', cyan: '#2ee6ff', white: '#f5f3ff' },
  grid: { columns: 12, gutter: 20, margin: 120, baseline: 8 },
  type: { name: { family: 'Noto Sans', weight: 900, size: 176, tracking: 18, leading: 1 } },
  globals: [
    {
      id: 'scan', kind: 'shape', shape: 'line', name: 'Scanlines', role: 'ambient',
      props: { x: 960, y: 120, width: 1920, height: 2, stroke: '$cyan', strokeWidth: 1, opacity: 22 },
      repeaters: [{ copies: 20, positionY: 46 }],
      trim: { end: 0, keys: { end: [{ t: 0, v: 0, ease: 'easeOut' }, { t: 1.2, v: 100 }] } },
    },
  ],
  beats: [
    {
      name: 'Hit', purpose: 'The name lands split, resolves, and breathes.', startSec: 0, endSec: 4.4,
      layers: [
        {
          id: 'name', kind: 'text', name: 'AFTER HOURS', role: 'hero', text: 'AFTER HOURS', typeStyle: 'name',
          props: { x: 960, y: 540, fill: '$white', align: 'center', width: 1800 },
          effects: [
            { type: 'chromatic-aberration', params: { amount: 24 }, keys: { amount: [{ t: 0.8, v: 24, ease: 'easeOut' }, { t: 1.6, v: 2 }] } },
            {
              type: 'glow', params: { radius: 40, color: '$magenta', intensity: 30 },
              // Breathing on the beat (124 bpm ≈ 0.48s).
              keys: { intensity: [{ t: 1.6, v: 30, ease: 'easeInOut' }, { t: 1.84, v: 75, ease: 'easeInOut' }, { t: 2.08, v: 30, ease: 'easeInOut' }, { t: 2.32, v: 75, ease: 'easeInOut' }, { t: 2.56, v: 30, ease: 'easeInOut' }, { t: 2.8, v: 75, ease: 'easeInOut' }, { t: 3.04, v: 30 }] },
            },
          ],
          textAnimators: [{ basedOn: 'characters', opacity: 0, characterOffset: 20, sweep: { from: 0.8, to: 1.3, ease: 'easeOut' } }],
          keys: { letterSpacing: [{ t: 0.8, v: 60, ease: 'easeOut' }, { t: 2.4, v: 18 }] },
        },
        {
          id: 'date', kind: 'text', name: 'Date', role: 'support', text: 'FRI 23:00 — DAWN', typeStyle: 'name',
          props: { x: 960, y: 700, fontSize: 30, fontWeight: 600, letterSpacing: 10, fill: '$cyan', align: 'center', width: 900 },
          keys: { opacity: [{ t: 1.8, v: 0, ease: 'easeOut' }, { t: 2.1, v: 100 }] },
        },
      ],
    },
    {
      name: 'Cut', purpose: 'Out on a flash and black.', startSec: 4.4, endSec: 5,
      layers: [
        { id: 'flash', kind: 'solid', name: 'Flash', props: { x: 960, y: 540, width: 1920, height: 1080, fill: '$magenta', blendMode: 'add' }, keys: { opacity: [{ t: 0, v: 0, ease: 'easeOut' }, { t: 0.1, v: 70 }, { t: 0.6, v: 0 }] } },
      ],
    },
  ],
};

// ── 9. Dark cinematic title ────────────────────────────────────────────

const filmTitle: SceneScript = {
  title: 'The Long Road — main title',
  intent: 'Cinematic title: layers staged in real depth (haze far, title mid, drifting dust near) under a nine-second camera drift that never stops; an amber light sweep crosses the title and the tracking opens slowly.',
  durationSec: 9,
  background: '$dark',
  palette: { dark: '#0d0b09', amber: '#e0a458', bone: '#efe6d8', smoke: '#3a2e22' },
  grid: { columns: 12, gutter: 24, margin: 160, baseline: 8 },
  type: { title: { family: 'Noto Serif', weight: 500, size: 120, tracking: 6, leading: 1 } },
  globals: [
    {
      id: 'haze', kind: 'shape', shape: 'ellipse', name: 'Haze', role: 'background',
      props: { x: 1100, y: 500, z: 900, width: 1600, height: 900, fill: '$smoke', threeD: true, opacity: 70 },
      effects: [{ type: 'gaussian-blur', params: { blurriness: 220 } }],
    },
    {
      id: 'dust', kind: 'shape', shape: 'ellipse', name: 'Dust', role: 'ambient',
      props: { x: 300, y: 260, z: -500, width: 6, height: 6, fill: '$bone', threeD: true, opacity: 45 },
      repeaters: [{ copies: 14, positionX: 117, positionY: 43, rotation: 23, startOpacity: 30, endOpacity: 90 }],
      effects: [{ type: 'gaussian-blur', params: { blurriness: 3 } }],
      expressions: { y: 'value + Math.sin(time * 0.6) * 12' },
    },
    {
      id: 'cam', kind: 'camera', name: 'Drift', props: { focalLength: 1700 },
      keys: { x: [{ t: 0, v: 860, ease: 'easeInOut' }, { t: 9, v: 1060 }], z: [{ t: 0, v: -2100, ease: 'easeInOut' }, { t: 9, v: -1800 }] },
    },
    { id: 'grain', kind: 'adjustment', name: 'Film grain', role: 'ambient', stack: 'front', props: { x: 960, y: 540, width: 1920, height: 1080 }, effects: [{ type: 'add-grain', params: { intensity: 9, size: 1.6, saturation: 0 } }, { type: 'vignette', params: { amount: 30, size: 100, feather: 140 } }] },
  ],
  beats: [
    {
      name: 'Dark', purpose: 'Only depth and dust: the drift establishes the space.', startSec: 0, endSec: 2.5,
      layers: [
        { id: 'veil', kind: 'solid', name: 'From black', props: { x: 960, y: 540, width: 1920, height: 1080, fill: '$dark' }, keys: { opacity: [{ t: 0, v: 100, ease: 'easeInOut' }, { t: 2.2, v: 0 }] } },
      ],
    },
    {
      name: 'Title', purpose: 'The title resolves out of blur; light crosses it; tracking opens.', startSec: 2.5, endSec: 9,
      layers: [
        {
          id: 'title', kind: 'text', name: 'The Long Road', role: 'hero', text: 'THE LONG ROAD', typeStyle: 'title',
          props: { x: 960, y: 520, fill: '$bone', align: 'center', width: 1700, threeD: true },
          effects: [{ type: 'light-sweep', params: { sweepWidth: 260, angle: 20, color: '$amber', intensity: 60, softness: 70 }, keys: { position: [{ t: 1.2, v: -20, ease: 'easeInOut' }, { t: 3.6, v: 120 }] } }],
          textAnimators: [{ basedOn: 'characters', opacity: 0, blur: 24, sweep: { from: 0, to: 2.2, ease: 'easeOut' } }],
          keys: { letterSpacing: [{ t: 0, v: 6 }, { t: 6.5, v: 30 }] },
        },
      ],
    },
  ],
};

export const AUTHOR_EXEMPLARS: readonly AuthorExemplar[] = [
  {
    id: 'product_reveal',
    keywords: ['product', 'reveal', 'launch', 'promo', 'unveil', 'showcase', 'device', 'hardware', '3d', 'render', 'premium', 'luxury', 'brand', 'tech'],
    lesson: 'Lit 3D in a light studio: extruded PBR geometry, a floor that catches the key light\'s soft shadow, an environment light for reflections, a camera push and a moving light across the whole piece — the cinematic register.',
    dark: false,
    script: productReveal,
  },
  {
    id: 'kinetic_quote',
    keywords: ['quote', 'typography', 'kinetic', 'words', 'lyric', 'text', 'phrase', 'saying', 'poem', 'editorial', 'magazine', 'essay', 'manifesto'],
    lesson: 'Editorial type on paper: an off-centre hanging edge, a heavy serif with negative tracking, words on a breathing beat, one accent word that breaks the pattern, a rule that draws the reading line.',
    dark: false,
    script: kineticQuote,
  },
  {
    id: 'logo_sting',
    keywords: ['logo', 'sting', 'ident', 'intro', 'outro', 'bumper', 'mark', 'badge', 'brand', 'bold', 'swiss', 'graphic', 'poster', 'flat'],
    lesson: 'Flat Swiss on a saturated field: a strict grid, hard eases, moves timed off each other, oversized tight type, and a real ending.',
    dark: false,
    script: logoSting,
  },
  {
    id: 'cosmic_3d',
    keywords: ['space', 'planet', 'cosmic', 'science', 'orbit', 'galaxy', 'astronomy', 'futuristic', '3d', 'sci-fi', 'universe', 'satellite'],
    lesson: 'Real 3D primitives (a PBR sphere, a chrome torus) lit by a warm key, a cold rim and an environment, under a slow camera orbit.',
    dark: true,
    script: cosmic3d,
  },
  {
    id: 'image_led',
    keywords: ['travel', 'nature', 'photo', 'landscape', 'hotel', 'retreat', 'real estate', 'wellness', 'calm', 'destination', 'image', 'food', 'fashion', 'lifestyle'],
    lesson: 'Image-led: one generated photograph drifting in a slow push carries the mood; light type sits in its empty space.',
    dark: false,
    script: imageLed,
  },
  {
    id: 'ink_enso',
    keywords: ['ink', 'calligraphy', 'brush', 'zen', 'japanese', 'tea', 'handmade', 'craft', 'art', 'mindful', 'traditional', 'painting', 'meditation'],
    lesson: 'Ink-led: brush strokes with real pressure drawn on in time, paper texture, a seal that presses in, type kept quiet and low.',
    dark: false,
    script: inkEnso,
  },
  {
    id: 'data_ui',
    keywords: ['app', 'saas', 'dashboard', 'data', 'stats', 'feature', 'demo', 'fintech', 'startup', 'chart', 'metrics', 'explainer', 'ui', 'software'],
    lesson: 'Product UI on white: a card with layered soft depth, a figure that lands with overshoot, bars growing from their base in a stagger, a line that draws.',
    dark: false,
    script: dataUi,
  },
  {
    id: 'neon_type',
    keywords: ['music', 'party', 'club', 'event', 'nightlife', 'festival', 'gaming', 'esports', 'dj', 'neon', 'energetic', 'hype', 'concert'],
    lesson: 'Dark kinetic type for the night: a drawn scanline grid, a chromatic split that resolves, a glow breathing on the beat, a flash-cut ending.',
    dark: true,
    script: neonType,
  },
  {
    id: 'film_title',
    keywords: ['film', 'movie', 'trailer', 'cinematic', 'title', 'documentary', 'story', 'drama', 'opening', 'credits', 'epic', 'series'],
    lesson: 'Cinematic title: layers at real depths under a nine-second camera drift that never stops, dust in the foreground, a light sweep crossing the type, tracking opening slowly.',
    dark: true,
    script: filmTitle,
  },
];

/** How many of an exemplar's keywords the prompt contains. */
function matchScore(e: AuthorExemplar, p: string): number {
  return e.keywords.reduce((n, k) => n + (p.includes(k) ? 1 : 0), 0);
}

/**
 * A reference for the prompt: one of the exemplars whose keywords it matches,
 * at random, weighted by how many match; any exemplar at random when none
 * does. Random on purpose — the same kind of brief must not always be shown
 * the same piece. `random` is injectable (tests, a seeded eval run).
 */
export function selectAuthorExemplar(prompt: string, random: () => number = Math.random): AuthorExemplar {
  const p = prompt.toLowerCase();
  const scored = AUTHOR_EXEMPLARS.map((e) => ({ e, w: matchScore(e, p) }));
  const matched = scored.filter((s) => s.w > 0);
  const pool = matched.length ? matched : scored.map((s) => ({ e: s.e, w: 1 }));
  const total = pool.reduce((n, s) => n + s.w, 0);
  let r = Math.min(Math.max(random(), 0), 0.999999) * total;
  for (const s of pool) {
    if (r < s.w) return s.e;
    r -= s.w;
  }
  return pool[pool.length - 1]!.e;
}
