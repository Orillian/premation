/**
 * Variety and depth: what makes a piece read as the same template again.
 *
 *  - A FINGERPRINT of a finished piece — its value (light / mid / dark), accent
 *    hue family, medium, camera and lighting — kept for the last few pieces
 *    and handed to the next run, so the model knows what it just made.
 *  - Four lint rules, run on an authored script (advisors.ts → the critique
 *    and the revise calls) and on a live scene (review_design):
 *      CAMERA_OVER_FLAT   a camera over layers that are not in 3D at distinct depths — a zoom, not a move
 *      NO_LIGHTING_IN_3D  3D content with no light that shades it, or lights that shade nothing
 *      DARK_DEFAULT       a near-black frame the brief never asked for
 *      SAME_AS_LAST       the same value, medium, camera and hue as a recent piece
 *
 * Both work on `DepthScene`, a neutral description built from a script
 * (`depthSceneOfScript`) or by the host from the engine's document. Pure.
 */

import type { LayerSpec, SceneScript } from './types';

/** One layer, as far as depth, light and medium go. */
export interface DepthLayer {
  id: string;
  kind: string;
  /** In 3D: the switch is on, or it is a primitive (3D by nature). */
  threeD: boolean;
  /** Every z it holds (static, and each key). */
  zs: readonly number[];
  /** Lights shade it. */
  acceptsLights: boolean;
  /** Has real depth: extruded, or a primitive mesh. */
  solid: boolean;
  /** kind light: its type. */
  lightType?: string;
  /** Painted strokes on it. */
  painted?: boolean;
  role?: string;
}

export interface DepthScene {
  /** Hex. */
  background: string;
  /** The accent the piece is built around, hex (absent = none known). */
  accent?: string;
  title?: string;
  layers: readonly DepthLayer[];
}

export type PieceValue = 'light' | 'mid' | 'dark';
export type PieceMedium = '3d' | 'image' | 'ink' | 'ui' | 'shape' | 'type';
export type PieceCamera = 'none' | 'flat' | 'depth';

export interface PieceFingerprint {
  title: string;
  value: PieceValue;
  /** Accent hue family: neutral, red, orange, yellow, green, cyan, blue, purple, magenta. */
  hue: string;
  medium: PieceMedium;
  camera: PieceCamera;
  /** Some light shades the piece. */
  lit: boolean;
}

/** Where the last pieces' fingerprints live (the host persists them; newest first). */
export interface PieceHistory {
  recent(): readonly PieceFingerprint[];
  record(fp: PieceFingerprint): void;
}

export interface VarietyFinding {
  rule: 'CAMERA_OVER_FLAT' | 'NO_LIGHTING_IN_3D' | 'DARK_DEFAULT' | 'SAME_AS_LAST';
  severity: 'error' | 'warn';
  message: string;
  nodeIds: string[];
}

export interface VarietyOptions {
  /** The brief (and anything the user said about the look), for DARK_DEFAULT's cues. Absent = unknown. */
  brief?: string;
  /** The user picked a dark piece in the composer. */
  mode?: 'dark' | 'light';
  /** The last pieces, newest first; SAME_AS_LAST compares against the first three. */
  recent?: readonly PieceFingerprint[];
}

// ── Colour ─────────────────────────────────────────────────────────────

function rgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? m[1]!.split('').map((c) => c + c).join('') : m[1]!;
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Relative luminance 0..1 (sRGB channels, unlinearised: a designer's "value"). */
export function luminance(hex: string): number {
  const c = rgb(hex);
  return c ? 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] : 0;
}

export function valueOf(hex: string): PieceValue {
  const l = luminance(hex);
  return l < 0.15 ? 'dark' : l > 0.55 ? 'light' : 'mid';
}

function hsl(hex: string): { h: number; s: number; l: number } | null {
  const c = rgb(hex);
  if (!c) return null;
  const [r, g, b] = c;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}

export function hueFamily(hex: string | undefined): string {
  const c = hex ? hsl(hex) : null;
  if (!c || c.s < 0.18) return 'neutral';
  const families: Array<[number, string]> = [[15, 'red'], [45, 'orange'], [70, 'yellow'], [160, 'green'], [200, 'cyan'], [255, 'blue'], [290, 'purple'], [335, 'magenta'], [360, 'red']];
  return families.find(([upTo]) => c.h < upTo)![1];
}

// ── Scene from a script ────────────────────────────────────────────────

function resolve(c: string | undefined, palette: Readonly<Record<string, string>>): string | undefined {
  if (!c) return undefined;
  return c.startsWith('$') ? palette[c.slice(1)] : c;
}

/** The accent a script is built around: `$accent`, else its most saturated swatch. */
function accentOf(script: Pick<SceneScript, 'palette'>): string | undefined {
  if (script.palette.accent) return script.palette.accent;
  let best: string | undefined;
  let s = -1;
  for (const v of Object.values(script.palette)) {
    const c = hsl(v);
    if (c && c.s * (1 - Math.abs(2 * c.l - 1)) > s) { s = c.s * (1 - Math.abs(2 * c.l - 1)); best = v; }
  }
  return best;
}

function layerOf(l: LayerSpec): DepthLayer {
  const p = l.props ?? {};
  const zKeys = (l.keys?.z ?? []).map((k) => k.v);
  const zs = [...(typeof p.z === 'number' ? [p.z] : []), ...zKeys];
  const primitive = l.kind === 'primitive';
  const extruded = (typeof p.extrusionDepth === 'number' && p.extrusionDepth > 0) || (l.keys?.extrusionDepth ?? []).some((k) => k.v > 0);
  return {
    id: l.id,
    kind: l.kind,
    threeD: primitive || p.threeD === true,
    zs: zs.length ? zs : [0],
    acceptsLights: primitive || p.acceptsLights === true,
    solid: primitive || extruded,
    ...(l.kind === 'light' ? { lightType: l.light?.type ?? 'point' } : {}),
    ...(l.paint?.length ? { painted: true } : {}),
    ...(l.role ? { role: l.role } : {}),
  };
}

export function depthSceneOfScript(script: SceneScript): DepthScene {
  const accent = accentOf(script);
  return {
    background: resolve(script.background, script.palette) ?? '#000000',
    ...(accent ? { accent } : {}),
    title: script.title,
    layers: [...script.globals, ...script.beats.flatMap((b) => b.layers)].map(layerOf),
  };
}

// ── Fingerprint ────────────────────────────────────────────────────────

const DEVICE = new Set(['camera', 'light', 'null', 'adjustment', 'audio']);

/** Layers that draw something in 3D. */
const drawn3D = (s: DepthScene): DepthLayer[] => s.layers.filter((l) => !DEVICE.has(l.kind) && l.threeD);

function cameraKind(s: DepthScene): PieceCamera {
  if (!s.layers.some((l) => l.kind === 'camera')) return 'none';
  const d = drawn3D(s);
  const zs = d.flatMap((l) => l.zs);
  const spread = zs.length ? Math.max(...zs) - Math.min(...zs) : 0;
  // Two drawn 3D layers apart in depth, or one real solid the camera can turn around.
  return (d.length >= 2 && spread >= 300) || d.some((l) => l.solid) ? 'depth' : 'flat';
}

/** A light that shades (an ambient light is only a fill: it has no direction). */
const shadingLights = (s: DepthScene): DepthLayer[] => s.layers.filter((l) => l.kind === 'light' && l.lightType !== 'ambient');

export function fingerprintOf(s: DepthScene): PieceFingerprint {
  const kinds = s.layers.map((l) => l.kind);
  const lit = shadingLights(s).length > 0 && drawn3D(s).some((l) => l.acceptsLights);
  const medium: PieceMedium = s.layers.some((l) => l.solid) || (lit && drawn3D(s).length >= 2)
    ? '3d'
    : kinds.includes('image') || kinds.includes('video')
      ? 'image'
      : s.layers.some((l) => l.painted)
        ? 'ink'
        : s.layers.filter((l) => l.role === 'ui').length >= 2
          ? 'ui'
          : kinds.filter((k) => k === 'shape' || k === 'svg' || k === 'solid').length > kinds.filter((k) => k === 'text').length
            ? 'shape'
            : 'type';
  return { title: s.title ?? '', value: valueOf(s.background), hue: hueFamily(s.accent), medium, camera: cameraKind(s), lit };
}

export function fingerprintScript(script: SceneScript): PieceFingerprint {
  return fingerprintOf(depthSceneOfScript(script));
}

/** One line per recent piece, for a prompt. */
export function describeRecent(recent: readonly PieceFingerprint[], max = 4): string {
  return recent.slice(0, max).map((f) => `- "${f.title || 'untitled'}": ${f.value} frame, ${f.hue} accent, ${f.medium}-led, camera ${f.camera === 'none' ? 'none' : f.camera === 'flat' ? 'over flat layers' : 'in depth'}${f.lit ? ', lit' : ''}`).join('\n');
}

// ── The rules ──────────────────────────────────────────────────────────

/** Words in a brief that ask for a dark frame. */
const DARK_CUES = /\b(night|nights|nighttime|dark|darkness|noir|moody|cinematic|film|movie|trailer|space|cosmic|galaxy|stars|neon|club|nightlife|horror|thriller|midnight|after hours|gaming|esports|cyberpunk|sci-?fi|black)\b/i;

export function lintVariety(s: DepthScene, o: VarietyOptions = {}): VarietyFinding[] {
  const out: VarietyFinding[] = [];
  const cameras = s.layers.filter((l) => l.kind === 'camera');
  const d3 = drawn3D(s);

  if (cameras.length && cameraKind(s) === 'flat') {
    const zs = d3.flatMap((l) => l.zs);
    const spread = zs.length ? Math.max(...zs) - Math.min(...zs) : 0;
    out.push({
      rule: 'CAMERA_OVER_FLAT',
      severity: 'error',
      message: d3.length < 2
        ? `A camera moves over ${d3.length === 0 ? 'no 3D layers at all' : 'a single 3D layer'}: it reads as a flat zoom. Turn the content 3D and spread it in z (background +600…+1200, subject 0, foreground −200…−500), or add real geometry (extrusion, a primitive).`
        : `A camera moves over 3D layers only ${Math.round(spread)}px apart in z: no parallax, a flat zoom. Spread them over 1000px+ of depth.`,
      nodeIds: [...cameras.map((c) => c.id), ...d3.map((l) => l.id)],
    });
  }

  const lights = shadingLights(s);
  const shaded = d3.filter((l) => l.acceptsLights);
  if (d3.filter((l) => l.solid).length > 0 && lights.length === 0) {
    out.push({
      rule: 'NO_LIGHTING_IN_3D',
      severity: 'warn',
      message: '3D geometry with no light shading it renders flat. Light it like a set: a key (spot, castsShadows, soft shadowDiffusion), a fill, a rim, an environment light for reflections.',
      nodeIds: d3.filter((l) => l.solid).map((l) => l.id),
    });
  } else if (lights.length > 0 && d3.length > 0 && shaded.length === 0) {
    out.push({
      rule: 'NO_LIGHTING_IN_3D',
      severity: 'error',
      message: 'The lights shade nothing: no 3D layer has acceptsLights on. Turn it on for every layer the light is meant to sculpt.',
      nodeIds: [...lights.map((l) => l.id), ...d3.map((l) => l.id)],
    });
  }

  if (valueOf(s.background) === 'dark' && o.mode !== 'dark' && !(o.brief && DARK_CUES.test(o.brief))) {
    out.push({
      rule: 'DARK_DEFAULT',
      severity: 'warn',
      message: o.brief !== undefined
        ? `A near-black frame (${s.background}) that the brief never asked for. Decide the value from the brief: paper, daylight, a pale studio, a saturated colour field, a photograph — dark only when the idea is night, cinema or space.`
        : `A near-black frame (${s.background}). If the brief did not ask for night, cinema or space, choose the value from it instead: paper, daylight, a pale studio, a saturated field.`,
      nodeIds: [],
    });
  }

  const fp = fingerprintOf(s);
  const twin = (o.recent ?? []).slice(0, 3).find((r) => r.value === fp.value && r.medium === fp.medium && r.camera === fp.camera && r.hue === fp.hue);
  if (twin) {
    out.push({
      rule: 'SAME_AS_LAST',
      severity: 'warn',
      message: `This reads like a recent piece, "${twin.title || 'untitled'}": the same ${fp.value} frame, ${fp.hue} accent, ${fp.medium}-led, camera ${fp.camera}. Unless the brief asks for a series, change the value, the medium or the camera idea.`,
      nodeIds: [],
    });
  }
  return out;
}

// ── Diversity over a set of pieces (the eval harness) ───────────────────

export interface DiversityReport {
  pieces: number;
  /** Distinct values (light / mid / dark), accent hue families, media, camera kinds. */
  values: number;
  hues: number;
  media: number;
  cameras: number;
  /** Share of pieces that are 3D: 3D-led, or a camera moving through real depth. */
  threeDShare: number;
  /** Share of dark frames. */
  darkShare: number;
  /** The most common look (value · medium · camera) and its share. */
  dominantLook: string;
  dominantShare: number;
  /** Counts per bucket, for the report. */
  counts: { value: Record<string, number>; hue: Record<string, number>; medium: Record<string, number>; camera: Record<string, number> };
  /** False when the set reads as one template; `reasons` says why. Always true under `minPieces`. */
  pass: boolean;
  reasons: string[];
}

export interface DiversityThresholds {
  /** Fewer pieces than this are reported, never failed (default 5). */
  minPieces: number;
  /** Fail when one look covers more than this share (default 0.5: "most pieces share one look"). */
  maxDominantShare: number;
  /** Fail when more than this share is dark (default 0.6). */
  maxDarkShare: number;
  minValues: number;
  minHues: number;
  minMedia: number;
  minCameras: number;
  /** Fail when fewer than this share use 3D (default 0.1: at least one in ten). */
  minThreeDShare: number;
}

export const DIVERSITY_THRESHOLDS: DiversityThresholds = {
  minPieces: 5,
  maxDominantShare: 0.5,
  maxDarkShare: 0.6,
  minValues: 2,
  minHues: 3,
  minMedia: 3,
  minCameras: 2,
  minThreeDShare: 0.1,
};

const lookOf = (f: PieceFingerprint): string => `${f.value} · ${f.medium} · camera ${f.camera}`;

function tally(xs: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}

/** How varied a set of pieces is, and whether it reads as one template. Pure. */
export function diversityOf(pieces: readonly PieceFingerprint[], t: DiversityThresholds = DIVERSITY_THRESHOLDS): DiversityReport {
  const n = pieces.length;
  const counts = {
    value: tally(pieces.map((p) => p.value)),
    hue: tally(pieces.map((p) => p.hue)),
    medium: tally(pieces.map((p) => p.medium)),
    camera: tally(pieces.map((p) => p.camera)),
  };
  const looks = Object.entries(tally(pieces.map(lookOf))).sort((a, b) => b[1] - a[1]);
  const share = (k: number): number => (n ? k / n : 0);
  const r: DiversityReport = {
    pieces: n,
    values: Object.keys(counts.value).length,
    hues: Object.keys(counts.hue).length,
    media: Object.keys(counts.medium).length,
    cameras: Object.keys(counts.camera).length,
    threeDShare: share(pieces.filter((p) => p.medium === '3d' || p.camera === 'depth').length),
    darkShare: share(counts.value.dark ?? 0),
    dominantLook: looks[0]?.[0] ?? '',
    dominantShare: share(looks[0]?.[1] ?? 0),
    counts,
    pass: true,
    reasons: [],
  };
  if (n < t.minPieces) return r;
  const fail = (why: string): void => { r.reasons.push(why); };
  if (r.dominantShare > t.maxDominantShare) fail(`${Math.round(r.dominantShare * 100)}% of the pieces share one look (${r.dominantLook})`);
  if (r.darkShare > t.maxDarkShare) fail(`${Math.round(r.darkShare * 100)}% of the frames are dark`);
  if (r.values < t.minValues) fail(`only ${r.values} value(s) across ${n} pieces`);
  if (r.hues < t.minHues) fail(`only ${r.hues} accent hue famil${r.hues === 1 ? 'y' : 'ies'}`);
  if (r.media < t.minMedia) fail(`only ${r.media} medi${r.media === 1 ? 'um' : 'a'} (${Object.keys(counts.medium).join(', ')})`);
  if (r.cameras < t.minCameras) fail(`only one camera kind (${Object.keys(counts.camera).join(', ')})`);
  if (r.threeDShare < t.minThreeDShare) fail(`${Math.round(r.threeDShare * 100)}% of the pieces use 3D`);
  r.pass = r.reasons.length === 0;
  return r;
}
