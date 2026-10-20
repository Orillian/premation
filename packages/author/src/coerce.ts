/**
 * Untrusted model JSON → a valid scene script, plus every repair made.
 *
 * The rule this file keeps: a repair fixes INPUT, it never adds design. A
 * misspelt effect becomes the effect it names, an out-of-range number is
 * clamped to the range the engine takes, a field the engine has no reader
 * for is dropped. Nothing here picks a colour, a size, a position, a font, an
 * ease or a time the model did not write — when something required is
 * missing, the thing that needed it is dropped and the repair says so, so
 * the critique and the revise call can put it back on purpose.
 */

import { validate } from '@motion/ai-tools';
import type { CatalogEffect, CatalogEffectParam } from '@motion/engine-api';
import {
  ANIMATABLE,
  AUTHOR_EFFECTS,
  CAMERA_ONLY,
  LIGHT_ONLY,
  PATH_OPS,
  PRIMITIVE_ONLY,
  PROP_ALIASES,
  STATIC_FIELDS,
  STRUCT_FIELDS,
  TEXT_ANIMATOR_FIELDS,
  THREE_D_ONLY,
  authorEffect,
} from './vocabulary';
import {
  EASES,
  LAYER_KINDS,
  type Beat,
  type BeatOutline,
  type ConceptOption,
  type DesignResult,
  type Ease,
  type EffectSpec,
  type GridSystem,
  type Key,
  type Keys,
  type LayerKind,
  type LayerSpec,
  type LightSpec,
  type MaskSpec,
  type PaintSpec,
  type PathOpSpec,
  type PrecomposeSpec,
  type PropValue,
  type Repair,
  type RepeaterSpec,
  type SceneScript,
  type ScriptHeader,
  type TextAnimatorSpec,
  type TrimSpec,
  type TypeStyle,
} from './types';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const clamp = (v: number, lo?: number, hi?: number): number =>
  Math.min(hi ?? Number.POSITIVE_INFINITY, Math.max(lo ?? Number.NEGATIVE_INFINITY, v));

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** What coercion needs to know about the host. */
export interface CoerceContext {
  /** The composition's length — the user chose it, so the script fits it. */
  durationSec: number;
  width: number;
  height: number;
}

/** Collects repairs under a path prefix. */
class Repairs {
  readonly list: Repair[] = [];
  add(path: string, message: string): void {
    this.list.push({ path, message });
  }
}

// ── Nearest-name matching ─────────────────────────────────────────────

function norm(s: string): string {
  return s.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '');
}

/** Levenshtein distance — small strings only. */
function lev(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * The effect a model meant, or undefined.
 *
 * Exact type, then the same name normalised (`Gaussian Blur`, `gaussian_blur`),
 * then a label match (`Drop Shadow`), then the closest type or label within a
 * third of its length — a typo, not a different effect.
 */
export function nearestEffect(raw: string): CatalogEffect | undefined {
  const exact = authorEffect(raw);
  if (exact) return exact;
  const n = norm(raw);
  if (!n) return undefined;
  const byNorm = AUTHOR_EFFECTS.find((e) => norm(e.type) === n || norm(e.label) === n);
  if (byNorm) return byNorm;
  let best: { e: CatalogEffect; d: number } | undefined;
  for (const e of AUTHOR_EFFECTS) {
    const d = Math.min(lev(n, norm(e.type)), lev(n, norm(e.label)));
    if (!best || d < best.d) best = { e, d };
  }
  return best && best.d <= Math.max(1, Math.floor(n.length / 3)) ? best.e : undefined;
}

/** The param of `e` a key names (key, label, or a close spelling of either). */
export function nearestParam(e: CatalogEffect, raw: string): CatalogEffectParam | undefined {
  const exact = e.params.find((p) => p.key === raw);
  if (exact) return exact;
  const n = norm(raw);
  const byNorm = e.params.find((p) => norm(p.key) === n || norm(p.label) === n);
  if (byNorm) return byNorm;
  let best: { p: CatalogEffectParam; d: number } | undefined;
  for (const p of e.params) {
    const d = Math.min(lev(n, norm(p.key)), lev(n, norm(p.label)));
    if (!best || d < best.d) best = { p, d };
  }
  return best && best.d <= Math.max(1, Math.floor(n.length / 3)) ? best.p : undefined;
}

// ── Leaves ─────────────────────────────────────────────────────────────

/** A colour the compiler can resolve: hex, or a reference to a palette swatch that exists. */
function colour(v: unknown, palette: Readonly<Record<string, string>>, path: string, r: Repairs): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  if (HEX.test(s)) return s;
  // No paint at all: a stroke-only shape's fill (create_layer / update_layer take it).
  if (s === 'none' || s === 'transparent') return 'none';
  if (s.startsWith('$')) {
    if (palette[s.slice(1)] !== undefined) return s;
    r.add(path, `palette has no swatch '${s.slice(1)}' — dropped (define it in palette, or use a hex)`);
    return undefined;
  }
  // A bare swatch name is a reference written without its `$`.
  if (palette[s] !== undefined) return `$${s}`;
  r.add(path, `'${s}' is not a hex colour or a palette reference — dropped`);
  return undefined;
}

function ease(v: unknown): Ease | undefined {
  return typeof v === 'string' && (EASES as readonly string[]).includes(v) ? (v as Ease) : undefined;
}

function bezier(v: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(v) || v.length !== 4) return undefined;
  const n = v.map(num);
  if (n.some((x) => x === undefined)) return undefined;
  const [x1, y1, x2, y2] = n as number[];
  // x must stay in 0..1 for the curve to be a function of time; y may overshoot.
  return [clamp(x1!, 0, 1), y1!, clamp(x2!, 0, 1), y2!];
}

/** Keys of one property: `{t,v,ease,bezier}` objects or `[t, v, ease?]` tuples. */
function keyList(raw: unknown, path: string, r: Repairs): Key[] {
  if (!Array.isArray(raw)) return [];
  const out: Key[] = [];
  raw.forEach((k, i) => {
    let t: number | undefined;
    let v: number | undefined;
    let e: Ease | undefined;
    let b: Key['bezier'];
    if (Array.isArray(k)) {
      t = num(k[0]);
      v = num(k[1]);
      e = ease(k[2]);
    } else if (isObj(k)) {
      t = num(k.t ?? k.time);
      v = num(k.v ?? k.value);
      e = ease(k.ease ?? k.easing);
      b = bezier(k.bezier);
      if ((k.ease ?? k.easing) !== undefined && !e) r.add(`${path}[${i}].ease`, `unknown easing '${String(k.ease ?? k.easing)}' — the key keeps the engine default`);
    }
    if (t === undefined || v === undefined) {
      r.add(`${path}[${i}]`, 'a key needs a numeric t and v — dropped');
      return;
    }
    out.push({ t, v, ...(e ? { ease: e } : {}), ...(e === 'bezier' && b ? { bezier: b } : {}) });
  });
  return out.sort((a, b) => a.t - b.t);
}

/** Resolve a prop name through the alias table. */
function propName(raw: string): string {
  return PROP_ALIASES[raw] ?? raw;
}

/** A layer's `keys`: only animatable props, through the alias table. */
function layerKeys(raw: unknown, path: string, r: Repairs): Keys | undefined {
  if (!isObj(raw)) return undefined;
  const out: Keys = {};
  for (const [k, v] of Object.entries(raw)) {
    const prop = propName(k);
    if (!ANIMATABLE.has(prop)) {
      r.add(`${path}.${k}`, `'${k}' is not an animatable property — dropped`);
      continue;
    }
    if (prop !== k) r.add(`${path}.${k}`, `read '${k}' as '${prop}'`);
    const list = keyList(v, `${path}.${k}`, r);
    if (list.length) out[prop] = [...(out[prop] ?? []), ...list].sort((a, b) => a.t - b.t);
  }
  return Object.keys(out).length ? out : undefined;
}

/** Keys restricted to a fixed set of params (trim, repeater, path op, animator). */
function paramKeys(raw: unknown, allowed: ReadonlySet<string>, path: string, r: Repairs): Keys | undefined {
  if (!isObj(raw)) return undefined;
  const out: Keys = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!allowed.has(k)) {
      r.add(`${path}.${k}`, `'${k}' cannot be keyed here (only ${[...allowed].join(', ')}) — dropped`);
      continue;
    }
    const list = keyList(v, `${path}.${k}`, r);
    if (list.length) out[k] = list;
  }
  return Object.keys(out).length ? out : undefined;
}

// ── Layer parts ────────────────────────────────────────────────────────

/** Static fields only a text layer carries (the Text component's). */
const TEXT_ONLY = new Set(['fontSize', 'fontWeight', 'fontFamily', 'letterSpacing', 'lineHeight', 'align']);

const PROP_FIELD_ALIASES: Readonly<Record<string, string>> = {
  color: 'fill',
  fillColor: 'fill',
  fontColor: 'fill',
  textColor: 'fill',
  strokeColor: 'stroke',
  tracking: 'letterSpacing',
  leading: 'lineHeight',
  radius: 'cornerRadius',
  blend: 'blendMode',
  '3d': 'threeD',
  is3D: 'threeD',
};

function staticProps(
  raw: unknown,
  palette: Readonly<Record<string, string>>,
  kind: LayerKind,
  path: string,
  r: Repairs,
): Record<string, PropValue> | undefined {
  if (!isObj(raw)) return undefined;
  const out: Record<string, PropValue> = {};
  for (const [k0, v] of Object.entries(raw)) {
    const k = STATIC_FIELDS[k0] ? k0 : PROP_FIELD_ALIASES[k0] ?? PROP_ALIASES[k0] ?? k0;
    const struct = STRUCT_FIELDS[k];
    if (struct) {
      const ok = validate(struct, v);
      if (ok.ok) out[k] = v as PropValue;
      else r.add(`${path}.${k}`, `'${k}' is not a valid ${k} (${ok.errors.join('; ')}) — dropped`);
      continue;
    }
    const f = STATIC_FIELDS[k];
    if (!f) {
      r.add(`${path}.${k0}`, `'${k0}' is not a static property the engine takes — dropped`);
      continue;
    }
    if (k !== k0) r.add(`${path}.${k0}`, `read '${k0}' as '${k}'`);
    if (cameraOnly(k, kind)) {
      r.add(`${path}.${k}`, `'${k}' is a camera property and this is a ${kind} — dropped`);
      continue;
    }
    if (PRIMITIVE_ONLY.has(k) && kind !== 'primitive') {
      r.add(`${path}.${k}`, `'${k}' belongs to a primitive layer and this is a ${kind} — dropped`);
      continue;
    }
    if (TEXT_ONLY.has(k) && kind !== 'text') {
      r.add(`${path}.${k}`, `'${k}' sets type and this is a ${kind} layer — dropped`);
      continue;
    }
    if (k === 'fill' || k === 'stroke') {
      const c = colour(v, palette, `${path}.${k}`, r);
      if (c) out[k] = c;
      continue;
    }
    if (f.type === 'number') {
      const n = num(v);
      if (n === undefined) { r.add(`${path}.${k}`, `'${k}' needs a number — dropped`); continue; }
      const c = clamp(n, f.minimum, f.maximum);
      if (c !== n) r.add(`${path}.${k}`, `${k} ${n} is outside ${f.minimum ?? '−∞'}..${f.maximum ?? '∞'} — clamped to ${c}`);
      out[k] = c;
    } else if (f.type === 'boolean') {
      if (typeof v === 'boolean') out[k] = v;
      else r.add(`${path}.${k}`, `'${k}' needs true or false — dropped`);
    } else {
      const s = str(v);
      if (!s) { r.add(`${path}.${k}`, `'${k}' needs a string — dropped`); continue; }
      if (f.enum && !f.enum.includes(s)) {
        const n = f.enum.find((e) => norm(e) === norm(s));
        if (n) { out[k] = n; continue; }
        r.add(`${path}.${k}`, `'${s}' is not one of ${f.enum.join(', ')} — dropped`);
        continue;
      }
      out[k] = s;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function effectParamValue(p: CatalogEffectParam, v: unknown, palette: Readonly<Record<string, string>>, path: string, r: Repairs): number | string | boolean | undefined {
  switch (p.type) {
    case 'number': {
      const n = num(v);
      if (n === undefined) { r.add(path, `${p.key} needs a number — dropped`); return undefined; }
      const c = clamp(n, p.min, p.max);
      if (c !== n) r.add(path, `${p.key} ${n} is outside ${p.min ?? '−∞'}..${p.max ?? '∞'} — clamped to ${c}`);
      return c;
    }
    case 'color':
      return colour(v, palette, path, r);
    case 'checkbox':
      if (typeof v === 'boolean') return v;
      r.add(path, `${p.key} needs true or false — dropped`);
      return undefined;
    case 'enum': {
      const opts = p.options ?? [];
      if (typeof v === 'number' && opts.some((o) => o.value === v)) return v;
      const s = typeof v === 'string' ? opts.find((o) => norm(o.label) === norm(v)) : undefined;
      if (s) return s.label;
      r.add(path, `${p.key} must be one of ${opts.map((o) => o.label).join(', ')} — dropped`);
      return undefined;
    }
    default:
      r.add(path, `${p.key} is a ${p.type} parameter, which a script cannot set — dropped`);
      return undefined;
  }
}

function effects(raw: unknown, palette: Readonly<Record<string, string>>, path: string, r: Repairs): EffectSpec[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: EffectSpec[] = [];
  const ids = new Set<string>();
  raw.forEach((e0, i) => {
    const p = `${path}[${i}]`;
    if (!isObj(e0)) return;
    const t = str(e0.type) ?? str(e0.effect);
    const e = t ? nearestEffect(t) : undefined;
    if (!e) { r.add(`${p}.type`, `no effect named '${t ?? ''}' — dropped`); return; }
    if (e.type !== t) r.add(`${p}.type`, `read '${t}' as '${e.type}' (${e.label})`);
    let id = (str(e0.id) ?? e.type).replace(/[^A-Za-z0-9_-]/g, '_');
    for (let n = 2; ids.has(id); n++) id = `${(str(e0.id) ?? e.type).replace(/[^A-Za-z0-9_-]/g, '_')}_${n}`;
    ids.add(id);
    const params: Record<string, number | string | boolean> = {};
    if (isObj(e0.params)) {
      for (const [k, v] of Object.entries(e0.params)) {
        const prm = nearestParam(e, k);
        if (!prm) { r.add(`${p}.params.${k}`, `${e.type} has no param '${k}' — dropped`); continue; }
        if (prm.key !== k) r.add(`${p}.params.${k}`, `read '${k}' as '${prm.key}'`);
        const val = effectParamValue(prm, v, palette, `${p}.params.${prm.key}`, r);
        if (val !== undefined) params[prm.key] = val;
      }
    }
    let keys: Keys | undefined;
    if (isObj(e0.keys)) {
      keys = {};
      for (const [k, v] of Object.entries(e0.keys)) {
        const prm = nearestParam(e, k);
        if (!prm || prm.type !== 'number') { r.add(`${p}.keys.${k}`, `${e.type} has no numeric param '${k}' to key — dropped`); continue; }
        const list = keyList(v, `${p}.keys.${prm.key}`, r).map((kk) => ({ ...kk, v: clamp(kk.v, prm.min, prm.max) }));
        if (list.length) keys[prm.key] = list;
      }
      if (!Object.keys(keys).length) keys = undefined;
    }
    out.push({ id, type: e.type, ...(Object.keys(params).length ? { params } : {}), ...(keys ? { keys } : {}) });
  });
  return out.length ? out : undefined;
}

/** A camera property on a layer that is not a camera — except the point of interest, which a spot or parallel light aims with too. */
function cameraOnly(prop: string, kind: LayerKind): boolean {
  if (!CAMERA_ONLY.has(prop) || kind === 'camera') return false;
  return !(kind === 'light' && (prop === 'poiX' || prop === 'poiY' || prop === 'poiZ'));
}

function numberFields<T extends object>(raw: Obj, fields: readonly string[]): Partial<T> {
  const out: Record<string, number> = {};
  for (const f of fields) {
    const n = num(raw[f]);
    if (n !== undefined) out[f] = n;
  }
  return out as Partial<T>;
}

const LIGHT_TYPES = ['point', 'spot', 'parallel', 'ambient', 'environment'] as const;
const LIGHT_FALLOFFS = ['none', 'smooth', 'inverse-square'] as const;
const LIGHT_SKIES = ['studio', 'sky', 'sunset'] as const;

/** A light layer's `light`: set_light's fields, each checked (a bad choice is dropped and said). */
function lightSpec(raw: Obj, color: string | undefined, path: string, r: Repairs): LightSpec {
  const out: LightSpec = { ...numberFields<LightSpec>(raw, ['intensity', 'radius', 'falloffDistance', 'coneAngle', 'coneFeather', 'shadowDarkness', 'shadowDiffusion', 'environmentBlur']) };
  if (color) out.color = color;
  const pick = <T extends string>(field: string, options: readonly T[]): T | undefined => {
    const v = str(raw[field]);
    if (v === undefined) return undefined;
    const hit = options.find((o) => norm(o) === norm(v));
    if (!hit) r.add(`${path}.${field}`, `'${v}' is not one of ${options.join(', ')} — dropped`);
    return hit;
  };
  const type = pick('type', LIGHT_TYPES);
  if (type) out.type = type;
  const falloff = pick('falloff', LIGHT_FALLOFFS);
  if (falloff) out.falloff = falloff;
  const environment = pick('environment', LIGHT_SKIES);
  if (environment) out.environment = environment;
  for (const field of ['castsShadows', 'environmentVisible'] as const) {
    const v = raw[field];
    if (typeof v === 'boolean') out[field] = v;
    else if (v !== undefined) r.add(`${path}.${field}`, `'${field}' needs true or false — dropped`);
  }
  const poi = raw.pointOfInterest ?? raw.poi;
  if (isObj(poi)) {
    const at = numberFields<{ x: number; y: number; z: number }>(poi, ['x', 'y', 'z']);
    if (Object.keys(at).length) out.pointOfInterest = at;
  }
  return out;
}

function textAnimators(raw: unknown, palette: Readonly<Record<string, string>>, path: string, r: Repairs): TextAnimatorSpec[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const allowed = new Set([...TEXT_ANIMATOR_FIELDS]);
  const out: TextAnimatorSpec[] = [];
  raw.forEach((a, i) => {
    if (!isObj(a)) return;
    const p = `${path}[${i}]`;
    const spec: TextAnimatorSpec = { ...numberFields<TextAnimatorSpec>(a, TEXT_ANIMATOR_FIELDS) };
    if (a.basedOn === 'characters' || a.basedOn === 'words' || a.basedOn === 'lines') spec.basedOn = a.basedOn;
    if (typeof a.shape === 'string' && ['square', 'rampUp', 'rampDown', 'triangle', 'round', 'smooth'].includes(a.shape)) {
      spec.shape = a.shape as TextAnimatorSpec['shape'];
    }
    const c = colour(a.color, palette, `${p}.color`, r);
    if (c) spec.color = c;
    if (isObj(a.sweep)) {
      const from = num(a.sweep.from ?? a.sweep.fromSec);
      const to = num(a.sweep.to ?? a.sweep.toSec);
      if (from !== undefined && to !== undefined && to > from) {
        const e = ease(a.sweep.ease ?? a.sweep.easing);
        const b = bezier(a.sweep.bezier);
        const fo = num(a.sweep.fromOffset);
        const to2 = num(a.sweep.toOffset);
        spec.sweep = {
          from, to,
          ...(fo !== undefined ? { fromOffset: fo } : {}),
          ...(to2 !== undefined ? { toOffset: to2 } : {}),
          ...(e ? { ease: e } : {}),
          ...(b ? { bezier: b } : {}),
        };
      } else {
        r.add(`${p}.sweep`, 'a sweep needs numeric from < to — dropped');
      }
    }
    const keys = paramKeys(a.keys, allowed, `${p}.keys`, r);
    if (keys) spec.keys = keys;
    out.push(spec);
  });
  return out.length ? out : undefined;
}

function trim(raw: unknown, path: string, r: Repairs): TrimSpec | undefined {
  if (!isObj(raw)) return undefined;
  const spec: TrimSpec = {};
  for (const f of ['start', 'end'] as const) {
    const n = num(raw[f]);
    if (n !== undefined) spec[f] = clamp(n, 0, 100);
  }
  const off = num(raw.offset);
  if (off !== undefined) spec.offset = off;
  const keys = paramKeys(raw.keys, new Set(['start', 'end', 'offset']), `${path}.keys`, r);
  if (keys) spec.keys = keys;
  if (spec.start === undefined && spec.end === undefined && spec.offset === undefined && !keys) {
    r.add(path, 'a trim needs start, end, offset or keys — dropped');
    return undefined;
  }
  return spec;
}

const REPEATER_FIELDS = ['copies', 'positionX', 'positionY', 'rotation', 'scale', 'anchorX', 'anchorY', 'startOpacity', 'endOpacity'];

function repeaters(raw: unknown, path: string, r: Repairs): RepeaterSpec[] | undefined {
  const list = Array.isArray(raw) ? raw : isObj(raw) ? [raw] : [];
  const out: RepeaterSpec[] = [];
  list.forEach((x, i) => {
    if (!isObj(x)) return;
    const spec: RepeaterSpec = { ...numberFields<RepeaterSpec>(x, REPEATER_FIELDS) };
    if (spec.copies !== undefined) spec.copies = clamp(Math.round(spec.copies), 1, 100);
    for (const f of ['startOpacity', 'endOpacity'] as const) if (spec[f] !== undefined) spec[f] = clamp(spec[f]!, 0, 100);
    const keys = paramKeys(x.keys, new Set(['copies', 'offset']), `${path}[${i}].keys`, r);
    if (keys) spec.keys = keys;
    out.push(spec);
  });
  return out.length ? out : undefined;
}

function pathOps(raw: unknown, path: string, r: Repairs): PathOpSpec[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PathOpSpec[] = [];
  raw.forEach((x, i) => {
    if (!isObj(x)) return;
    const op0 = str(x.op);
    const op = op0 === 'puckerBloat' ? 'pucker' : op0;
    if (!op || !PATH_OPS.includes(op)) { r.add(`${path}[${i}].op`, `unknown path operator '${op0 ?? ''}' — dropped`); return; }
    const spec: PathOpSpec = { op: op as PathOpSpec['op'], ...numberFields<PathOpSpec>(x, ['amount', 'detail', 'wigglesPerSecond']) };
    const keys = paramKeys(x.keys, new Set(['amount']), `${path}[${i}].keys`, r);
    if (keys) spec.keys = keys;
    out.push(spec);
  });
  return out.length ? out : undefined;
}

function masks(raw: unknown, path: string, r: Repairs): MaskSpec[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: MaskSpec[] = [];
  raw.forEach((x, i) => {
    if (!isObj(x)) return;
    const shape = x.shape === 'rect' ? 'rectangle' : x.shape;
    if (shape !== 'rectangle' && shape !== 'ellipse') { r.add(`${path}[${i}].shape`, 'a mask is a rectangle or an ellipse — dropped'); return; }
    const spec: MaskSpec = { shape, ...numberFields<MaskSpec>(x, ['width', 'height', 'feather', 'opacity', 'expansion']) };
    if (x.mode === 'add' || x.mode === 'subtract' || x.mode === 'intersect') spec.mode = x.mode;
    if (typeof x.inverted === 'boolean') spec.inverted = x.inverted;
    if (spec.opacity !== undefined) spec.opacity = clamp(spec.opacity, 0, 1);
    for (const f of ['width', 'height'] as const) if (spec[f] !== undefined) spec[f] = Math.max(1, spec[f]!);
    out.push(spec);
  });
  return out.length ? out : undefined;
}

// ── Layers ─────────────────────────────────────────────────────────────

const KIND_ALIASES: Readonly<Record<string, { kind: LayerKind; shape?: LayerSpec['shape'] }>> = {
  rect: { kind: 'shape', shape: 'rect' },
  rectangle: { kind: 'shape', shape: 'rect' },
  ellipse: { kind: 'shape', shape: 'ellipse' },
  circle: { kind: 'shape', shape: 'ellipse' },
  line: { kind: 'shape', shape: 'line' },
  star: { kind: 'shape', shape: 'star' },
  polygon: { kind: 'shape', shape: 'polygon' },
  vector: { kind: 'svg' },
  picture: { kind: 'image' },
  photo: { kind: 'image' },
  backdrop: { kind: 'gradient' },
};

const SHAPES = new Set(['rect', 'ellipse', 'line', 'star', 'polygon']);
/** Kinds whose content runs through the shape-path pipeline. */
const PATH_KINDS = new Set<LayerKind>(['shape', 'solid']);

/** Shared across one script, so ids stay unique between beats. */
export class IdPool {
  private readonly used = new Set<string>();
  constructor(reserved: Iterable<string> = []) {
    for (const id of reserved) this.used.add(id);
  }
  claim(raw: string): string {
    const base = raw.replace(/[^A-Za-z0-9_-]/g, '_') || 'layer';
    let id = base;
    for (let n = 2; this.used.has(id); n++) id = `${base}_${n}`;
    this.used.add(id);
    return id;
  }
  has(id: string): boolean {
    return this.used.has(id);
  }
}

/** A layer list: valid layers, unique ids, parents and mattes inside the list. */
function layers(
  raw: unknown,
  header: Pick<ScriptHeader, 'palette' | 'type'>,
  pool: IdPool,
  path: string,
  r: Repairs,
): LayerSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: LayerSpec[] = [];
  /** Raw id → claimed id, for parent / matte references in this list. */
  const renamed = new Map<string, string>();
  raw.forEach((l0, i) => {
    const p = `${path}[${i}]`;
    if (!isObj(l0)) return;
    let kind = str(l0.kind) as LayerKind | undefined;
    let shape = str(l0.shape) as LayerSpec['shape'] | undefined;
    if (kind && !(LAYER_KINDS as readonly string[]).includes(kind)) {
      const alias = KIND_ALIASES[kind.toLowerCase()];
      if (!alias) { r.add(`${p}.kind`, `unknown layer kind '${kind}' — layer dropped`); return; }
      r.add(`${p}.kind`, `read kind '${kind}' as ${alias.kind}${alias.shape ? ` (${alias.shape})` : ''}`);
      kind = alias.kind;
      shape = shape ?? alias.shape;
    }
    if (!kind) { r.add(`${p}.kind`, 'a layer needs a kind — layer dropped'); return; }
    const rawId = str(l0.id) ?? str(l0.name) ?? `${kind}_${i}`;
    const id = pool.claim(rawId);
    if (id !== rawId) r.add(`${p}.id`, `id '${rawId}' was taken or invalid — renamed '${id}'`);
    renamed.set(rawId, id);

    const spec: LayerSpec = { id, kind, name: str(l0.name) ?? id };
    if (kind === 'shape') {
      if (shape && SHAPES.has(shape)) spec.shape = shape;
      else if (shape) r.add(`${p}.shape`, `unknown shape '${shape}' — the layer keeps the engine's rectangle`);
    }
    if (kind === 'text') {
      const t = typeof l0.text === 'string' ? l0.text : undefined;
      if (!t) { r.add(`${p}.text`, 'a text layer needs text — layer dropped'); return; }
      spec.text = t;
    }
    const ts = str(l0.typeStyle);
    if (ts) {
      if (header.type[ts]) spec.typeStyle = ts;
      else r.add(`${p}.typeStyle`, `no type style '${ts}' — ignored`);
    }
    if (l0.stack === 'front' || l0.stack === 'back') spec.stack = l0.stack;
    const role = str(l0.role);
    if (role && ['hero', 'support', 'ui', 'ambient', 'background'].includes(role)) spec.role = role as LayerSpec['role'];
    for (const f of ['inSec', 'outSec'] as const) {
      const n = num(l0[f]);
      if (n !== undefined) spec[f] = n;
    }
    if (spec.inSec !== undefined && spec.outSec !== undefined && spec.outSec <= spec.inSec) {
      r.add(`${p}`, `outSec ${spec.outSec} is not after inSec ${spec.inSec} — both dropped (the layer spans its beat)`);
      delete spec.inSec;
      delete spec.outSec;
    }

    // Props may arrive nested (`props`) or flat on the layer; both are read.
    const flat: Obj = {};
    for (const [k, v] of Object.entries(l0)) if (!LAYER_KEYS.has(k)) flat[k] = v;
    const props = staticProps({ ...flat, ...(isObj(l0.props) ? l0.props : {}) }, header.palette, kind, `${p}.props`, r);
    if (props) spec.props = props;

    const keys = layerKeys(l0.keys, `${p}.keys`, r);
    if (keys) {
      for (const prop of Object.keys(keys)) {
        if (cameraOnly(prop, kind)) {
          r.add(`${p}.keys.${prop}`, `'${prop}' is a camera property and this is a ${kind} — dropped`);
          delete keys[prop];
        } else if (LIGHT_ONLY.has(prop) && kind !== 'light') {
          r.add(`${p}.keys.${prop}`, `'${prop}' is a light property and this is a ${kind} — dropped`);
          delete keys[prop];
        }
      }
      if (Object.keys(keys).length) spec.keys = keys;
    }
    // z, rotationX/Y and every Material / Geometry option exist only on a 3D
    // layer: asking for one IS asking for 3D. Said, never silent.
    if (kind !== 'camera' && kind !== 'light' && kind !== 'primitive' && spec.props?.threeD !== false) {
      const wants3D = [...Object.keys(spec.props ?? {}), ...Object.keys(spec.keys ?? {})].filter((k) => THREE_D_ONLY.has(k));
      if (wants3D.length && spec.props?.threeD !== true) {
        spec.props = { ...(spec.props ?? {}), threeD: true };
        r.add(`${p}.props.threeD`, `${wants3D.join(', ')} need${wants3D.length === 1 ? 's' : ''} a 3D layer — threeD turned on`);
      }
    }
    if (isObj(l0.expressions)) {
      const ex: Record<string, string> = {};
      for (const [k, v] of Object.entries(l0.expressions)) {
        const prop = propName(k);
        if (typeof v === 'string' && v.trim() && ANIMATABLE.has(prop)) ex[prop] = v.trim();
        else r.add(`${p}.expressions.${k}`, 'an expression needs an animatable prop and a non-empty string — dropped');
      }
      if (Object.keys(ex).length) spec.expressions = ex;
    }
    const fx = effects(l0.effects, header.palette, `${p}.effects`, r);
    if (fx) spec.effects = fx;

    if (l0.textAnimators !== undefined) {
      if (kind === 'text') {
        const ta = textAnimators(l0.textAnimators, header.palette, `${p}.textAnimators`, r);
        if (ta) spec.textAnimators = ta;
      } else r.add(`${p}.textAnimators`, `text animators only apply to text layers — dropped`);
    }
    for (const [field, make] of [
      ['trim', () => { const t = trim(l0.trim, `${p}.trim`, r); if (t) spec.trim = t; }],
      ['repeaters', () => { const t = repeaters(l0.repeaters ?? l0.repeater, `${p}.repeaters`, r); if (t) spec.repeaters = t; }],
      ['pathOps', () => { const t = pathOps(l0.pathOps, `${p}.pathOps`, r); if (t) spec.pathOps = t; }],
    ] as const) {
      const present = field === 'repeaters' ? (l0.repeaters ?? l0.repeater) !== undefined : l0[field] !== undefined;
      if (!present) continue;
      if (PATH_KINDS.has(kind)) make();
      else r.add(`${p}.${field}`, `${field} cut a shape path, and a ${kind} layer has none — dropped`);
    }
    const mk = masks(l0.masks, `${p}.masks`, r);
    if (mk) spec.masks = mk;
    const pt = paint(l0.paint, header.palette, `${p}.paint`, r);
    if (pt) spec.paint = pt;

    if (kind === 'light' && isObj(l0.light)) {
      const c = colour(l0.light.color, header.palette, `${p}.light.color`, r);
      spec.light = lightSpec(l0.light, c, `${p}.light`, r);
    }
    if (kind === 'gradient') {
      const g = isObj(l0.gradient) ? l0.gradient : undefined;
      // A stop is a colour (hex or $palette). The shape models reach for —
      // { color, offset } — is taken for its colour; stops are spaced evenly.
      const rawStops = Array.isArray(g?.stops) ? (g!.stops as unknown[]) : [];
      if (rawStops.some((s) => isObj(s) && s.offset !== undefined)) {
        r.add(`${p}.gradient.stops`, 'stops are colours spaced evenly — offsets ignored');
      }
      const stops = rawStops
        .map((s, j) => colour(isObj(s) ? (s.color ?? s.colour ?? s.c) : s, header.palette, `${p}.gradient.stops[${j}]`, r))
        .filter((s): s is string => !!s);
      if (stops.length < 2) { r.add(`${p}.gradient`, 'a gradient needs at least two valid stops — layer dropped'); return; }
      const gk = g!.kind === 'radial' || g!.kind === 'corners' || g!.kind === 'linear' ? g!.kind : undefined;
      if (gk === 'corners' && stops.length !== 4) { r.add(`${p}.gradient`, 'a corners gradient needs exactly four stops — layer dropped'); return; }
      spec.gradient = { stops: stops.slice(0, 4), ...(gk ? { kind: gk } : {}), ...numberFields(g!, ['angle', 'centerX', 'centerY', 'radius']) };
    }
    if (kind === 'image') {
      const prompt = isObj(l0.image) ? str(l0.image.prompt) : undefined;
      if (!prompt || prompt.length < 8) { r.add(`${p}.image`, 'an image layer needs image.prompt (8+ characters) — layer dropped'); return; }
      const aspect = isObj(l0.image) && ['square', 'landscape', 'portrait'].includes(String(l0.image.aspect)) ? String(l0.image.aspect) : undefined;
      spec.image = { prompt: prompt.slice(0, 2000), ...(aspect ? { aspect: aspect as 'square' } : {}) };
    }
    if (kind === 'svg') {
      const markup = isObj(l0.svg) ? str(l0.svg.markup) : undefined;
      if (!markup || !/<svg[\s>]/i.test(markup)) { r.add(`${p}.svg`, 'an svg layer needs svg.markup with an <svg> element — layer dropped'); return; }
      spec.svg = { markup };
    }
    if (kind === 'video') {
      const v = isObj(l0.video) ? l0.video : undefined;
      const prompt = v ? str(v.prompt) : undefined;
      if (!prompt || prompt.length < 8) { r.add(`${p}.video`, 'a video layer needs video.prompt (8+ characters) — layer dropped'); return; }
      const aspect = ['landscape', 'portrait', 'square'].includes(String(v!.aspect)) ? String(v!.aspect) as 'landscape' : undefined;
      const fit = v!.fit === 'cover' || v!.fit === 'contain' ? v!.fit : undefined;
      const d = num(v!.durationSec);
      spec.video = {
        prompt: prompt.slice(0, 2000),
        ...(d !== undefined ? { durationSec: clamp(d, 1, 10) } : {}),
        ...(aspect ? { aspect } : {}),
        ...(str(v!.model) ? { model: str(v!.model)! } : {}),
        ...(fit ? { fit } : {}),
      };
    }
    // References are resolved after the list, once every id is claimed.
    if (str(l0.parent)) (spec as LayerSpec & { _parent?: string })._parent = str(l0.parent);
    if (isObj(l0.matte)) {
      const mode = l0.matte.mode;
      const source = str(l0.matte.source ?? l0.matte.sourceId);
      if (['alpha', 'luma', 'alpha-inv', 'luma-inv'].includes(String(mode)) && source) {
        (spec as LayerSpec & { _matte?: { mode: string; source: string } })._matte = { mode: String(mode), source };
      } else r.add(`${p}.matte`, 'a matte needs mode alpha|luma|alpha-inv|luma-inv and a source layer — dropped');
    }
    out.push(spec);
  });

  // Parents and mattes: inside this list, no cycles.
  const ids = new Set(out.map((l) => l.id));
  for (const [i, l] of out.entries()) {
    const ext = l as LayerSpec & { _parent?: string; _matte?: { mode: string; source: string } };
    if (ext._parent !== undefined) {
      const target = renamed.get(ext._parent) ?? ext._parent;
      if (target !== l.id && ids.has(target)) l.parent = target;
      else r.add(`${path}[${i}].parent`, `parent '${ext._parent}' is not another layer here — dropped`);
      delete ext._parent;
    }
    if (ext._matte) {
      const target = renamed.get(ext._matte.source) ?? ext._matte.source;
      if (target !== l.id && ids.has(target)) l.matte = { mode: ext._matte.mode as 'alpha', source: target };
      else r.add(`${path}[${i}].matte`, `matte source '${ext._matte.source}' is not another layer here — dropped`);
      delete ext._matte;
    }
  }
  const byId = new Map(out.map((l) => [l.id, l]));
  for (const l of out) {
    const seen = new Set<string>([l.id]);
    let cur = l.parent ? byId.get(l.parent) : undefined;
    while (cur) {
      if (seen.has(cur.id)) {
        r.add(`${path}`, `parent chain of '${l.id}' loops — its parent dropped`);
        delete l.parent;
        break;
      }
      seen.add(cur.id);
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
  }
  return out;
}

/** Fields of a layer object that are NOT static props. */
const LAYER_KEYS = new Set([
  'id', 'kind', 'name', 'parent', 'role', 'inSec', 'outSec', 'shape', 'text', 'typeStyle', 'props', 'matte',
  'keys', 'expressions', 'effects', 'textAnimators', 'trim', 'repeaters', 'repeater', 'pathOps', 'masks', 'paint',
  'light', 'gradient', 'image', 'svg', 'video', 'stack',
]);

// ── Header, outline, beats ─────────────────────────────────────────────

function typeStyles(raw: unknown): Record<string, TypeStyle> {
  if (!isObj(raw)) return {};
  const out: Record<string, TypeStyle> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!isObj(v)) continue;
    const s: TypeStyle = {};
    const fam = str(v.family ?? v.fontFamily);
    if (fam) s.family = fam;
    const w = num(v.weight ?? v.fontWeight);
    if (w !== undefined) s.weight = clamp(w, 1, 1000);
    const size = num(v.size ?? v.fontSize);
    if (size !== undefined) s.size = Math.max(1, size);
    const tr = num(v.tracking ?? v.letterSpacing);
    if (tr !== undefined) s.tracking = tr;
    const ld = num(v.leading ?? v.lineHeight);
    if (ld !== undefined) s.leading = Math.max(0, ld);
    out[k] = s;
  }
  return out;
}

function header(raw: Obj, ctx: CoerceContext, r: Repairs): ScriptHeader {
  const palette: Record<string, string> = {};
  if (isObj(raw.palette)) {
    for (const [k, v] of Object.entries(raw.palette)) {
      if (typeof v === 'string' && HEX.test(v.trim())) palette[k] = v.trim();
      else r.add(`palette.${k}`, `'${String(v)}' is not a hex colour — dropped`);
    }
  }
  const d = num(raw.durationSec);
  if (d !== undefined && Math.abs(d - ctx.durationSec) > 1e-3) {
    r.add('durationSec', `the composition is ${ctx.durationSec}s (the user's choice) — the script's ${d}s was set to it`);
  }
  const g = isObj(raw.grid) ? raw.grid : {};
  const grid: GridSystem = {
    columns: clamp(Math.round(num(g.columns) ?? 0), 0, 48),
    gutter: Math.max(0, num(g.gutter) ?? 0),
    margin: Math.max(0, num(g.margin) ?? 0),
    baseline: Math.max(0, num(g.baseline) ?? 0),
  };
  if (!grid.columns || !grid.baseline) r.add('grid', 'the grid needs columns and a baseline — the layout advisor will measure against none');
  const bg = colour(raw.background, palette, 'background', r);
  if (!bg) r.add('background', 'no background colour — the composition keeps its own');
  return {
    title: str(raw.title) ?? '',
    intent: str(raw.intent) ?? '',
    durationSec: ctx.durationSec,
    background: bg ?? '',
    palette,
    grid,
    type: typeStyles(raw.type),
  };
}

function outlineOf(raw: unknown, ctx: CoerceContext, path: string, r: Repairs): BeatOutline | undefined {
  if (!isObj(raw)) return undefined;
  const s = num(raw.startSec);
  const e = num(raw.endSec);
  if (s === undefined || e === undefined) { r.add(path, 'a beat needs startSec and endSec — dropped'); return undefined; }
  const start = clamp(s, 0, ctx.durationSec);
  const end = clamp(e, 0, ctx.durationSec);
  if (start !== s || end !== e) r.add(path, `beat ${s}–${e}s runs outside the ${ctx.durationSec}s composition — clipped to ${start}–${end}s`);
  if (end <= start) { r.add(path, 'a beat must end after it starts — dropped'); return undefined; }
  return {
    name: str(raw.name) ?? `Beat`,
    purpose: str(raw.purpose) ?? '',
    startSec: start,
    endSec: end,
    ...(str(raw.notes) ? { notes: str(raw.notes)! } : {}),
  };
}

/** Composition-time sanity for a beat's layers: keys and bars inside the composition. */
function fitLayersToTime(ls: LayerSpec[], offset: number, ctx: CoerceContext, path: string, r: Repairs): void {
  const eps = 1e-6;
  for (const [i, l] of ls.entries()) {
    const inside = (t: number) => t + offset >= -eps && t + offset <= ctx.durationSec + eps;
    const fix = (keys: Keys | undefined, at: string): void => {
      if (!keys) return;
      for (const [prop, list] of Object.entries(keys)) {
        const kept = list.filter((k) => inside(k.t));
        if (kept.length !== list.length) r.add(`${path}[${i}].${at}.${prop}`, `${list.length - kept.length} key(s) fall outside the composition — dropped`);
        if (kept.length) keys[prop] = kept;
        else delete keys[prop];
      }
    };
    fix(l.keys, 'keys');
    l.effects?.forEach((e, j) => fix(e.keys, `effects[${j}].keys`));
    l.textAnimators?.forEach((a, j) => fix(a.keys, `textAnimators[${j}].keys`));
    fix(l.trim?.keys, 'trim.keys');
    l.repeaters?.forEach((x, j) => fix(x.keys, `repeaters[${j}].keys`));
    l.pathOps?.forEach((x, j) => fix(x.keys, `pathOps[${j}].keys`));
    if (l.inSec !== undefined && !inside(l.inSec)) { r.add(`${path}[${i}].inSec`, 'starts outside the composition — dropped'); delete l.inSec; }
    if (l.outSec !== undefined && !inside(l.outSec)) {
      const clipped = ctx.durationSec - offset;
      r.add(`${path}[${i}].outSec`, `ends after the composition — clipped to ${clipped}`);
      l.outSec = clipped;
    }
  }
}

// ── Entry points ───────────────────────────────────────────────────────

export interface Coerced<T> {
  value: T;
  repairs: Repair[];
}

/** The DESIGN call's output: header, beat outline (sorted, inside the comp), globals. */
/**
 * `concepts`: the design CALL is asked for three candidate concepts and is told
 * when they are missing; a whole script (author_scene) carries them only if it likes.
 */
export function coerceDesign(raw: unknown, ctx: CoerceContext, opts: { concepts?: boolean } = {}): Coerced<DesignResult> {
  const r = new Repairs();
  const o = isObj(raw) ? raw : {};
  const h = header(o, ctx, r);
  const beats = (Array.isArray(o.beats) ? o.beats : [])
    .map((b, i) => outlineOf(b, ctx, `beats[${i}]`, r))
    .filter((b): b is BeatOutline => !!b)
    .sort((a, b) => a.startSec - b.startSec);
  if (!beats.length) r.add('beats', 'the design has no usable beats');
  const pool = new IdPool(beats.map((_, i) => `beat_${i}`));
  const globals = layers(o.globals, h, pool, 'globals', r);
  fitLayersToTime(globals, 0, ctx, 'globals', r);
  const c = opts.concepts === false && !Array.isArray(o.concepts) ? {} : concepts(o, r);
  return { value: { ...h, globals, beats, ...c }, repairs: r.list };
}

const CONCEPT_MEDIA = ['3d', 'image', 'ink', 'ui', 'shape', 'type', 'mixed'] as const;
const CONCEPT_VALUES = ['light', 'mid', 'dark'] as const;

/** The design call's three candidate concepts and its pick; what is missing or alike is said, never invented. */
function concepts(o: Obj, r: Repairs): Pick<DesignResult, 'concepts' | 'chosen' | 'why'> {
  if (!Array.isArray(o.concepts) || o.concepts.length === 0) {
    r.add('concepts', 'no candidate concepts — the design was not weighed against alternatives');
    return {};
  }
  const list: ConceptOption[] = [];
  o.concepts.slice(0, 3).forEach((c, i) => {
    if (!isObj(c)) return;
    const medium = CONCEPT_MEDIA.find((m) => m === str(c.medium));
    const value = CONCEPT_VALUES.find((v) => v === str(c.value));
    if (!medium || !value) r.add(`concepts[${i}]`, 'a concept needs a medium and a value (light, mid, dark)');
    list.push({ name: str(c.name) ?? `Concept ${i + 1}`, idea: str(c.idea) ?? '', medium: medium ?? 'mixed', value: value ?? 'mid', palette: str(c.palette) ?? '', camera: str(c.camera) ?? '' });
  });
  if (list.length < 3) r.add('concepts', `${list.length} concept(s), not three — fewer real alternatives were weighed`);
  const alike = list.length >= 2 && list.every((c) => c.value === list[0]!.value) && list.every((c) => c.medium === list[0]!.medium);
  if (alike) r.add('concepts', 'the concepts share one value and one medium — they are variations, not alternatives');
  const n = num(o.chosen);
  const chosen = n !== undefined && Number.isInteger(n) && n >= 0 && n < list.length ? n : undefined;
  if (chosen === undefined) r.add('chosen', 'no valid chosen concept index');
  return { concepts: list, ...(chosen !== undefined ? { chosen } : {}), ...(str(o.why) ? { why: str(o.why)! } : {}) };
}

/**
 * One beat's layers, written against its outline. `pool` is shared across the
 * script so ids stay unique; pass the same pool for every beat.
 */
export function coerceBeat(
  raw: unknown,
  outline: BeatOutline,
  head: Pick<ScriptHeader, 'palette' | 'type'>,
  pool: IdPool,
  ctx: CoerceContext,
  beatIndex: number,
): Coerced<Beat> {
  const r = new Repairs();
  const o = isObj(raw) ? raw : {};
  const path = `beats[${beatIndex}].layers`;
  const ls = layers(o.layers, head, pool, path, r);
  fitLayersToTime(ls, outline.startSec, ctx, path, r);
  if (!ls.length) r.add(`beats[${beatIndex}]`, 'the beat has no usable layers');
  const pc = precompose(o.precompose, ls, pool, `beats[${beatIndex}].precompose`, r);
  return { value: { ...outline, layers: ls, ...(pc.length ? { precompose: pc } : {}) }, repairs: r.list };
}

/** A layer's `paint` strokes: finite points (2 or 3 numbers each), the brush fields clamped. */
function paint(raw: unknown, palette: Readonly<Record<string, string>>, path: string, r: Repairs): PaintSpec[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) { r.add(path, 'paint is a list of { points, … } strokes — dropped'); return undefined; }
  const out: PaintSpec[] = [];
  raw.slice(0, 64).forEach((s, i) => {
    const p = `${path}[${i}]`;
    if (!isObj(s) || !Array.isArray(s.points)) { r.add(p, 'a stroke needs points: [[x, y], …] — dropped'); return; }
    const points = (s.points as unknown[])
      .filter((q): q is unknown[] => Array.isArray(q) && q.length >= 2)
      .map((q) => q.slice(0, 3).map((v) => num(v)))
      .filter((q): q is number[] => q.every((v) => v !== undefined))
      .slice(0, 2000);
    if (points.length === 0) { r.add(p, 'no usable [x, y] points — dropped'); return; }
    const c = s.color !== undefined ? colour(s.color, palette, `${p}.color`, r) : undefined;
    const rev = isObj(s.reveal) ? { from: num(s.reveal.from), to: num(s.reveal.to) } : undefined;
    out.push({
      points,
      ...(c ? { color: c } : {}),
      ...numberFields(s, ['size', 'hardness', 'opacity', 'minSize']),
      ...(rev && rev.from !== undefined && rev.to !== undefined && rev.to > rev.from ? { reveal: { from: rev.from, to: rev.to } } : {}),
    });
  });
  return out.length ? out : undefined;
}

const PRECOMP_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity'] as const;

/** A beat's `precompose` groups: layers of this beat that share a parent, each used once. */
function precompose(raw: unknown, ls: readonly LayerSpec[], pool: IdPool, path: string, r: Repairs): PrecomposeSpec[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) { r.add(path, 'precompose is a list of { id, name, layers } — dropped'); return []; }
  const byId = new Map(ls.map((l) => [l.id, l]));
  const used = new Set<string>();
  const out: PrecomposeSpec[] = [];
  raw.forEach((g, i) => {
    const p = `${path}[${i}]`;
    if (!isObj(g)) { r.add(p, 'not an object — dropped'); return; }
    const want = Array.isArray(g.layers) ? g.layers.map((x) => String(x)) : [];
    const ids = want.filter((id) => {
      if (!byId.has(id)) { r.add(`${p}.layers`, `'${id}' is not a layer of this beat — left out`); return false; }
      if (used.has(id)) { r.add(`${p}.layers`, `'${id}' is already in another precompose group — left out`); return false; }
      return true;
    });
    if (ids.length === 0) { r.add(p, 'no layers to pre-compose — dropped'); return; }
    const parents = new Set(ids.map((id) => byId.get(id)!.parent ?? ''));
    if (parents.size > 1) { r.add(p, 'layers pre-composed together must share a parent — dropped'); return; }
    for (const id of ids) used.add(id);
    const name = str(g.name) ?? `Precomp ${i + 1}`;
    const props: Record<string, number> = {};
    if (isObj(g.props)) for (const k of PRECOMP_PROPS) { const v = num(g.props[k]); if (v !== undefined) props[k] = v; }
    const keys = layerKeys(g.keys, `${p}.keys`, r);
    out.push({ id: pool.claim(str(g.id) ?? `precomp_${i}`), name, layers: ids, ...(Object.keys(props).length ? { props } : {}), ...(keys ? { keys } : {}) });
  });
  return out;
}

/** A whole script in one object (exemplars, tests, a single-call author). */
export function coerceScript(raw: unknown, ctx: CoerceContext): Coerced<SceneScript> {
  const d = coerceDesign(raw, ctx, { concepts: false });
  const o = isObj(raw) ? raw : {};
  const rawBeats = Array.isArray(o.beats) ? o.beats : [];
  const pool = new IdPool([...d.value.beats.map((_, i) => `beat_${i}`), ...d.value.globals.map((g) => g.id)]);
  const repairs = [...d.repairs];
  // The outline was sorted; pair each kept outline back with its raw beat by bounds.
  const beats: Beat[] = d.value.beats.map((outline, i) => {
    const match = rawBeats.find((b) => isObj(b) && num(b.startSec) === outline.startSec && num(b.endSec) === outline.endSec)
      ?? rawBeats.find((b) => isObj(b) && clamp(num(b.startSec) ?? -1, 0, ctx.durationSec) === outline.startSec);
    const c = coerceBeat(match, outline, d.value, pool, ctx, i);
    repairs.push(...c.repairs);
    return c.value;
  });
  return { value: { ...d.value, beats }, repairs };
}

/** Repairs as lines for a prompt or a log. */
export function formatRepairs(repairs: readonly Repair[], max = 40): string {
  const shown = repairs.slice(0, max).map((x) => `- ${x.path}: ${x.message}`);
  return repairs.length > max ? [...shown, `- …and ${repairs.length - max} more`].join('\n') : shown.join('\n');
}
