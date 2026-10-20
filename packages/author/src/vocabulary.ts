/**
 * The engine vocabulary an author may use — derived, wherever it can be, from
 * the sources that already define it, so the card a model reads and the
 * schema a handler enforces cannot disagree.
 *
 * - Static properties come from the `create_layer` / `update_layer` schemas.
 * - Effects come from the engine catalog (`EFFECT_CATALOG`), filtered to the
 *   types `add_effect` admits.
 * - Text animator fields come from the `text_animator` schema.
 *
 * The animatable property list is the one hand-written part, because the gate
 * it mirrors (`isAnimatableProp`) lives in the app and a package cannot import
 * it. `src/core/ai/author/vocabularyDrift.test.ts` holds the two in step.
 */

import type { JsonSchema } from '@motion/ai-tools';
import { addEffectDef, createLayerDef, textAnimatorDef, updateLayerDef } from '@motion/ai-tools';
import { EFFECT_CATALOG, type CatalogEffect } from '@motion/engine-api';
import { EASES, LAYER_KINDS } from './types';

// ── Static properties ──────────────────────────────────────────────────

/** A static field's constraints, read off the tool schema. */
export interface FieldSpec {
  type: 'number' | 'string' | 'boolean';
  minimum?: number;
  maximum?: number;
  enum?: readonly string[];
  /** Which tool sets it. */
  via: 'create' | 'update';
}

/** Fields that are structure, not static look — handled by name elsewhere. */
const NOT_STATIC = new Set(['id', 'kind', 'name', 'parent', 'shape', 'text', 'nodeId', 'visible', 'locked', 'matte', 'removeMatte']);

function fieldsOf(schema: JsonSchema, via: FieldSpec['via']): Record<string, FieldSpec> {
  const out: Record<string, FieldSpec> = {};
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  for (const [k, p] of Object.entries(props)) {
    if (NOT_STATIC.has(k)) continue;
    const t = p.type === 'integer' ? 'number' : p.type;
    if (t !== 'number' && t !== 'string' && t !== 'boolean') continue;
    out[k] = {
      type: t,
      ...(typeof p.minimum === 'number' ? { minimum: p.minimum } : {}),
      ...(typeof p.maximum === 'number' ? { maximum: p.maximum } : {}),
      ...(Array.isArray(p.enum) ? { enum: p.enum as string[] } : {}),
      via,
    };
  }
  return out;
}

/**
 * Every static property a layer's `props` may carry, with its constraints.
 *
 * `update_layer` wins where both tools take a name (x / y / width / height /
 * fill), because the compiler sends the create-time ones on `create_layer` and
 * that is a placement detail, not a different property.
 */
export const STATIC_FIELDS: Readonly<Record<string, FieldSpec>> = {
  ...fieldsOf(updateLayerDef.inputSchema, 'update'),
  ...fieldsOf(createLayerDef.inputSchema, 'create'),
  // A uniform scale is how people say it; the tool takes the two axes.
  scale: { type: 'number', via: 'update' },
};

/**
 * Static fields whose value is a structure, passed whole and checked against
 * the `update_layer` schema: the stroke's dash list and its Taper and Wave
 * groups (AE's shape Stroke). Without them a script could not ask for a
 * dotted line or a brush-tapered one, though the engine draws both.
 */
export const STRUCT_FIELDS: Readonly<Record<string, JsonSchema>> = Object.fromEntries(
  ['strokeDash', 'strokeTaper', 'strokeWave'].map((k) => [k, (updateLayerDef.inputSchema.properties as Record<string, JsonSchema>)[k]!]),
);

/** Fields `create_layer` takes directly (the rest go on one `update_layer`). */
export const CREATE_FIELDS: ReadonlySet<string> = new Set(
  Object.entries(fieldsOf(createLayerDef.inputSchema, 'create')).map(([k]) => k),
);

/** Static fields that hold a colour (palette references resolve here). */
export const COLOUR_FIELDS: ReadonlySet<string> = new Set(['fill', 'stroke']);

// ── Animatable properties ──────────────────────────────────────────────

/**
 * Plain (unprefixed) property paths `set_keyframes` accepts on a layer.
 * Mirrors `isAnimatableProp` in src/core/ai/toolContext.ts — see the header.
 */
export const ANIMATABLE_PROPS: readonly string[] = [
  // transform
  'x', 'y', 'rotation', 'scale', 'scaleX', 'scaleY', 'opacity',
  // 3D (needs threeD: true)
  'z', 'rotationX', 'rotationY',
  // camera layers
  'focalLength', 'orbitYaw', 'orbitPitch', 'orientationX', 'orientationY', 'orientationZ',
  'poiX', 'poiY', 'poiZ', 'dofStrength', 'focusDistance', 'dofAperture',
  // layer extras (SAMPLED_LAYER_PROPS)
  'anchorX', 'anchorY', 'skew', 'skewAxis', 'fillOpacity',
  'strokeWidth', 'strokeOpacity', 'letterSpacing',
  // gradient fill geometry (fractions of the layer box)
  'fillAngle', 'fillCenterX', 'fillCenterY', 'fillRadius',
  // parametric polygon / star
  'polystar.points', 'polystar.rotation', 'polystar.outerRadius', 'polystar.innerRadius',
  'polystar.outerRoundness', 'polystar.innerRoundness',
  // 3D material + geometry (needs threeD: true)
  'extrusionDepth', 'bevelDepth', 'ambient', 'diffuse', 'specular', 'shininess',
  'metal', 'roughness', 'reflectionIntensity', 'reflectionSharpness', 'transparency', 'lightTransmission',
  // light layers (poiX / poiY / poiZ above aim spot and parallel lights too)
  'intensity', 'lightCone', 'lightConeFeather', 'shadowDarkness', 'shadowDiffusion', 'falloffDistance',
];

export const ANIMATABLE: ReadonlySet<string> = new Set(ANIMATABLE_PROPS);

/** A 3D layer's Material / Geometry Options (update_layer): they exist once the layer is 3D. */
export const MATERIAL_FIELDS: ReadonlySet<string> = new Set([
  'acceptsLights', 'ambient', 'diffuse', 'specular', 'shininess', 'shading', 'metal', 'roughness',
  'reflectionIntensity', 'reflectionSharpness', 'transparency', 'ior', 'lightTransmission',
  'castsShadows', 'acceptsShadows', 'toonBands', 'extrusionDepth', 'bevelDepth', 'bevelStyle',
]);

/** Props that need the layer's 3D switch (cameras excepted). */
export const THREE_D_ONLY: ReadonlySet<string> = new Set(['z', 'rotationX', 'rotationY', ...MATERIAL_FIELDS]);

/** create_layer fields only a `primitive` layer takes (its mesh type and size). */
export const PRIMITIVE_ONLY: ReadonlySet<string> = new Set(['primitive', 'radius', 'depth', 'tube']);

/** Light-layer tracks: keys only a light has. */
export const LIGHT_ONLY: ReadonlySet<string> = new Set(['intensity', 'lightCone', 'lightConeFeather', 'shadowDarkness', 'shadowDiffusion', 'falloffDistance']);

/** Camera-only props. */
export const CAMERA_ONLY: ReadonlySet<string> = new Set([
  'focalLength', 'orbitYaw', 'orbitPitch', 'orientationX', 'orientationY', 'orientationZ',
  'poiX', 'poiY', 'poiZ', 'dofStrength', 'focusDistance', 'dofAperture',
]);

/**
 * Names a model reaches for that mean a real prop. A REPAIR table: each entry
 * is a spelling of exactly one existing property, never a substitution of a
 * different look.
 */
export const PROP_ALIASES: Readonly<Record<string, string>> = {
  positionX: 'x',
  positionY: 'y',
  positionZ: 'z',
  posX: 'x',
  posY: 'y',
  'position.x': 'x',
  'position.y': 'y',
  'position.z': 'z',
  'transform.x': 'x',
  'transform.y': 'y',
  'scale.x': 'scaleX',
  'scale.y': 'scaleY',
  alpha: 'opacity',
  rotate: 'rotation',
  rotationZ: 'rotation',
  tracking: 'letterSpacing',
  zoom: 'focalLength',
};

// ── Effects ────────────────────────────────────────────────────────────

/** Effect types `add_effect` admits. */
export const AI_EFFECT_TYPES: ReadonlySet<string> = new Set(
  ((addEffectDef.inputSchema.properties as Record<string, JsonSchema>).type!.enum ?? []) as string[],
);

/** The catalog entries an author may use, in catalog order. */
export const AUTHOR_EFFECTS: readonly CatalogEffect[] = EFFECT_CATALOG.filter((e) => AI_EFFECT_TYPES.has(e.type));

const EFFECT_BY_TYPE = new Map(AUTHOR_EFFECTS.map((e) => [e.type, e]));

export function authorEffect(type: string): CatalogEffect | undefined {
  return EFFECT_BY_TYPE.get(type);
}

// ── Text animators, blend modes, path operators ───────────────────────

const TA_STRUCTURAL = new Set(['nodeId', 'index', 'sweep', 'remove', 'basedOn', 'shape', 'color']);

/** Numeric text-animator fields (static, and keyable as `ta.<i>.<field>`). */
export const TEXT_ANIMATOR_FIELDS: readonly string[] = Object.entries(
  (textAnimatorDef.inputSchema.properties ?? {}) as Record<string, JsonSchema>,
)
  .filter(([k, p]) => !TA_STRUCTURAL.has(k) && p.type === 'number')
  .map(([k]) => k);

/** Blend modes `update_layer` takes. */
export const BLEND_MODES: readonly string[] =
  ((updateLayerDef.inputSchema.properties as Record<string, JsonSchema>).blendMode!.enum ?? []) as string[];

export const PATH_OPS: readonly string[] = ['zigzag', 'pucker', 'twist', 'roundCorners', 'offset', 'roughen', 'wiggleTransform'];

// ── The card ───────────────────────────────────────────────────────────

function effectLine(e: CatalogEffect): string {
  // Every param a script can set: the point lists (Curves, Lumetri) and the
  // layer / mask pickers too — a param the card hides is one no author uses.
  const params = e.params
    .filter((p) => ['number', 'color', 'checkbox', 'enum', 'curve', 'layer', 'maskPath'].includes(p.type))
    .map((p) => {
      if (p.type === 'number') {
        const range = p.min !== undefined || p.max !== undefined ? ` ${p.min ?? ''}..${p.max ?? ''}` : '';
        return `${p.key}${range}${p.unit ? p.unit : ''}`;
      }
      if (p.type === 'enum') return `${p.key}:${(p.options ?? []).map((o) => o.label).slice(0, 6).join('|')}`;
      if (p.type === 'curve') return `${p.key}:curve`;
      if (p.type === 'layer') return `${p.key}:layer id`;
      if (p.type === 'maskPath') return `${p.key}:mask id`;
      return `${p.key}:${p.type}`;
    });
  return `${e.type} (${e.label}) — ${params.join(', ') || 'no params'}`;
}

function staticLine(): string {
  return Object.entries(STATIC_FIELDS)
    .map(([k, f]) => {
      if (f.enum) return `${k}:${f.enum.join('|')}`;
      const range = f.minimum !== undefined || f.maximum !== undefined ? `${f.minimum ?? ''}..${f.maximum ?? ''}` : '';
      return range ? `${k} ${range}` : k;
    })
    .join(', ');
}

/**
 * The vocabulary as a compact card for a system prompt.
 *
 * One line per effect, with every numeric param's range — the model cannot
 * use what it cannot see, and a guessed param is a dropped param.
 */
export function vocabularyCard(): string {
  return [
    'ENGINE VOCABULARY — use these names exactly.',
    '',
    `Layer kinds: ${LAYER_KINDS.join(', ')}.`,
    '  shape: give `shape` (rect|ellipse|line|star|polygon) and width/height (polygon/star: outerRadius, points, innerRadius, roundness).',
    '  text: give `text`, then type props (fontFamily, fontSize, fontWeight, letterSpacing, lineHeight, align, fill). `width` makes it paragraph text: it wraps inside a box that wide, centred on x, and align left|right|center|justify sets the lines inside the box (left edge = x − width/2). Without width it is point text: one line per line break, centred on x.',
    '  Fonts that ship with every install: Inter, Noto Sans, Noto Serif (variable weight 100–900), and Noto Sans / Serif JP, Noto Sans KR, SC, TC, Arabic, Hebrew, Devanagari, Thai. Another family renders only if this machine has it, else a plain sans.',
    '  solid: a filled rectangle; adjustment: effects on it apply to everything below; null: an invisible parent.',
    '  camera: frames 3D layers (focalLength, poi*, orbit*, dof*); light: lights layers that have threeD and acceptsLights (set `light`).',
    '  primitive: a real 3D mesh, already 3D, lit and shadow-casting — props.primitive sphere|cylinder|cone|torus|capsule|box|cube|plane, sized by radius / height / width / depth / tube (torus thickness). A planet, a pill, a ring, a pedestal, a product block.',
    '  gradient: full-frame gradient backdrop (set `gradient`: stops = 2–4 COLOUR STRINGS, e.g. ["#050303", "$ember"], spaced evenly (no offsets); kind linear|radial|corners (corners takes exactly 4); angle; centerX/centerY/radius in %).',
    '  image: a generated picture (set `image`: prompt = subject and look, aspect). svg: your own vector (set `svg`: markup) — the layer is the size the markup width / height say (else its viewBox), and it rasterises at that size, so write it at the size it shows on screen rather than scaling a small one up.',
    '  video: a generated clip (set `video`: prompt = subject, light and camera with no text, durationSec, aspect, fit contain|cover, model optional) — b-roll or a background plate under authored type.',
    '  particle: a particle emitter with the engine default look — prefer effects (snowfall, rainfall, particle-systems, cc-bubbles) for styled particles.',
    '',
    `Static props (layer.props): ${staticLine()}.`,
    '  Units: opacity 0..100, rotation degrees, scale a multiplier (1 = 100%), x/y the layer centre in comp px, anchorX/anchorY layer px from the centre.',
    '  Colours are hex or $paletteName. z / rotationX / rotationY need threeD: true. Camera props only on camera layers.',
    '',
    `Animatable props (layer.keys): ${ANIMATABLE_PROPS.join(', ')}.`,
    '  Effect params animate under effects[i].keys; trim, repeater, path-op and text-animator params under their own keys.',
    `Easings: ${EASES.join(', ')}. bezier takes [x1,y1,x2,y2]. Ease applies to the segment starting at that key.`,
    `Blend modes: ${BLEND_MODES.join(', ')}.`,
    `Path operators (pathOps[].op): ${PATH_OPS.join(', ')} — amount keyable. trim: start/end/offset %, keyable. repeaters: copies, positionX/Y, rotation, scale, anchorX/Y, startOpacity/endOpacity; copies and offset keyable.`,
    'A line that draws itself on: a shape with props fill "none", stroke, strokeWidth and a trim whose end keys 0 → 100.',
    'Stroke look (update_layer, any shape): strokeCap butt|round|square, strokeJoin miter|round|bevel, miterLimit, strokeDash [dash, gap, …] px, strokeDashOffset, strokeTaper { startLength, endLength, startWidth, endWidth (%), startEase, endEase }, strokeWave { amount, wavelength, phase }. stroke takes hex or $paletteName like fill.',
    'Brush ink (calligraphy, ink marks): a layer\'s `paint`: [{ points: [[x, y, pressure], …] in layer px from its top-left, pressure 0..1 tapers the tip down to minSize %, color, size px, hardness %, opacity %, reveal: { from, to } in the layer\'s seconds to draw it on }]. Paint on a SOLID (filled with the paper or scene colour; a shape with no fill shows nothing).',
    `Text animators: basedOn characters|words|lines, shape square|rampUp|rampDown|triangle|round|smooth, numeric ${TEXT_ANIMATOR_FIELDS.join(', ')}, color; sweep {from,to,fromOffset,toOffset,ease} sweeps the range selector's offset: the selector is Start 0 / End 100, offset o covers characters [o%, o%+100%], so the default 0 → 100 uncovers the text once left to right (a reveal when the animator hides what it covers) and 100 → 0 covers it once; a square swept −100 → 100 covers the text only mid-sweep.`,
    '  A REVEAL (opacity / fillOpacity / scale 0 on the animator) needs shape square — smoothness softens its edge — or, for a soft reveal, rampUp swept fromOffset −100 → toOffset 100 (AE: Ramp Up selects everything past the window\'s end fully; rampDown everything before its start, swept 100 → −100). Bumps (triangle, round, smooth) never select every character fully and select nothing outside their window, so hidden text shows before and after the sweep; use them for a wave through visible text.',
    '',
    'REAL 3D — the engine renders lit, shadowed, reflective 3D; a camera over flat layers is only a zoom.',
    '  Depth: threeD: true + z on each layer (background z≈+600, subject 0, foreground −300) gives parallax to any camera move.',
    '  Geometry (3D shape and text layers): extrusionDepth px (a slab, extruded type, a coin), bevelDepth px, bevelStyle angular|convex|concave.',
    '  Material (3D layers; any of these turns the layer 3D): shading phong|pbr|toon; pbr reads metal % and roughness % (chrome: metal 100, roughness 10; brushed steel: 100/45; glossy plastic: 0/20; clay: 0/85);',
    '    reflectionIntensity %, reflectionSharpness %, transparency % + ior (glass 1.52), lightTransmission %, toonBands 2..8; castsShadows off|on|only, acceptsShadows, acceptsLights.',
    '  Light (kind light, its `light`): type point|spot|parallel|ambient|environment, color, intensity %, falloff none|smooth|inverse-square, falloffDistance,',
    '    coneAngle °, coneFeather %, castsShadows, shadowDarkness %, shadowDiffusion px (soft), pointOfInterest {x,y,z} (where a spot/parallel aims),',
    '    environment studio|sky|sunset + environmentVisible + environmentBlur (type environment: sky light AND reflections for metal and glass).',
    '  A lit set: a warm key spot (castsShadows, shadowDiffusion 20–60) high and to one side, a cool low fill (ambient or point, intensity 20–40), a rim behind the subject, an environment light for reflections, and a floor (a 3D solid rotated rotationX 90 with acceptsShadows) for the shadows to land on.',
    '  Animate it: extrusionDepth growing, metal/roughness shifting, a spot\'s lightCone opening, intensity pulses, poiX/poiY tracking the hero, shadowDiffusion softening.',
    '',
    'Masks: rectangle|ellipse, mode add|subtract|intersect, width, height, feather, opacity 0..1, expansion, inverted.',
    'Track matte: matte { mode alpha|luma|alpha-inv|luma-inv, source: <layer id> }.',
    'Expressions: expressions { <prop>: "<AE expression>" } — one expression or an AE-style rig: statements on lines or after `;`, var / let / const and assignment, if / else, functions and arrows (closures), for / while loops, the last expression is the value.',
    '  Bindings: time, value, wiggle(f,a), loopOut("cycle"|"pingpong"), loopIn, linear / ease (t, t0, t1, v0, v1), Math, random / seedRandom, effect("Name")("Param") or .param("Param"), transform.position / scale / rotation / opacity, inPoint, outPoint, index, parent, hasParent, thisComp.layer(n); vectors add, subtract and scale like AE ([a, b] + [c, d], v * 2).',
    '',
    `Effects (effects[].type, params by key; ${AUTHOR_EFFECTS.length} available). Numbers keep their sign where the range is signed; a value outside a range is clamped and the reply says so. A curve param takes its points [[x, y], …] in 0..255 from [0, 0] to [255, 255] (an S-curve: [[0,0],[64,48],[192,208],[255,255]]); a layer param a layer id; a mask param a mask id:`,
    ...AUTHOR_EFFECTS.map((e) => `  ${effectLine(e)}`),
  ].join('\n');
}
