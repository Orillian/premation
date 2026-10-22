/**
 * After Effects' scripting object model (`app.project`, CompItem, Layer,
 * Property — a SUBSET, docs/SCRIPTING.md) for user scripts, WORKER side.
 *
 * Not a second engine: every attribute is one engine-API query or command
 * through the run's `AeBridge`, which the script runtime (scriptRuntime.ts)
 * makes SYNCHRONOUS by deterministic replay — a read the bridge has not
 * answered yet suspends the run, the runtime asks the engine, and the script
 * runs again from the top with every earlier answer served from the run's
 * tape. So `comp.layer(1).name = 'x'` works exactly as ExtendScript writes it,
 * with no `await`.
 *
 * Writes are fire-and-forget (`fire`): queued, sent in order before the next
 * read, and a refused one throws at its own line on the next pass. Commands
 * whose RESULT the model needs (a new layer's id) go through `execute`, which
 * suspends like a read.
 */

import type { Value } from '@motion/engine-api';

/** What the object model needs of the run (scriptRuntime.ts implements it). */
export interface AeBridge {
  /** A query; its result (throws the engine's refusal). */
  query<T = Record<string, unknown>>(query: Record<string, unknown>): T;
  /** An edit command whose result is needed. */
  execute<T = Record<string, unknown>>(command: Record<string, unknown>): T;
  /** An edit command whose result is not needed (queued, in order). */
  fire(command: Record<string, unknown>): void;
  log(text: string): void;
  /** The editor's active composition when the run started (null = none). */
  readonly activeItem: string | null;
  /** The editor's current time (flicks) when the run started. */
  readonly time: number;
}

const FLICKS = 705_600_000;
const toFlicks = (s: number): number => Math.round(Number(s) * FLICKS);
const toSeconds = (f: number): number => f / FLICKS;

interface Rational { num: number; den: number }
interface CompSettings {
  name: string; width: number; height: number; pixelAspect: number; frameRate: Rational; duration: number;
  background: { r: number; g: number; b: number; a: number };
  workArea?: { start: number; duration: number };
}
interface CompInfo { id: string; settings: CompSettings; layers: string[] }
interface ItemInfo { id: string; kind: string; name: string; parent?: string; width: number; height: number; duration: number; frameRate?: Rational; comment: string }
interface LayerTiming { inPoint: number; outPoint: number; startTime: number; stretch: number }
interface LayerInfo {
  id: string; comp: string; kind: string; name: string; parent?: string; comment: string;
  switches: Record<string, unknown> & { visible: boolean; solo: boolean; locked: boolean; shy: boolean; threeD: boolean; motionBlur: boolean; adjustment: boolean; label: number };
  timing: LayerTiming;
}
interface PropertyInfo {
  path: string; name: string; matchName: string; kind: 'property' | 'group' | 'indexedGroup';
  valueType: string; animatable: boolean; animated: boolean; dimensions: number;
  value?: Value; expression: string; expressionEnabled: boolean; expressionError: string;
  keyframeCount: number; children: string[];
}
interface Keyframe { id: string; time: number; value: Value }

/** Frame rate → the engine's exact Rational (the NTSC rates as x000/1001). */
export function rationalFps(fps: number): Rational {
  const f = Number(fps);
  if (!Number.isFinite(f) || f <= 0) throw new Error(`invalid frame rate: ${String(fps)}`);
  if (Number.isInteger(f)) return { num: f, den: 1 };
  for (const base of [24, 30, 48, 60, 120]) {
    if (Math.abs(f - (base * 1000) / 1001) < 0.005) return { num: base * 1000, den: 1001 };
  }
  return { num: Math.round(f * 1000), den: 1000 };
}

// ---------------------------------------------------------------------------
// Values: the engine's tagged Value ⇄ ExtendScript's plain arrays / numbers.

/** AE's TextDocument (the Source Text value). `text` is what the model maps; the rest is carried. */
export class TextDocument {
  text: string;
  fontSize?: number;
  font?: string;
  constructor(text = '') { this.text = String(text); }
  toString(): string { return this.text; }
}

/** AE's Shape (a path value): vertices / tangents as [x, y] pairs. */
export class Shape {
  vertices: number[][] = [];
  inTangents: number[][] = [];
  outTangents: number[][] = [];
  closed = true;
}

const pairs = (flat: readonly number[] = []): number[][] => {
  const out: number[][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i]!, flat[i + 1]!]);
  return out;
};

export function valueToAe(v: Value | undefined): unknown {
  if (!v) return null;
  switch (v.kind) {
    case 'none': return null;
    case 'bool': case 'int': case 'scalar': case 'string': case 'choice': case 'layer': case 'item': case 'json':
      return v.value;
    case 'vec2': return [v.value.x, v.value.y];
    case 'vec3': return [v.value.x, v.value.y, v.value.z];
    case 'vec4': return [v.value.x, v.value.y, v.value.z, v.value.w];
    case 'color': return [v.value.r, v.value.g, v.value.b, v.value.a];
    case 'scalars': return [...((v.value as { values?: number[] }).values ?? [])];
    case 'textDocument': return new TextDocument(v.value.text);
    case 'path': {
      const s = new Shape();
      s.vertices = pairs(v.value.vertices);
      s.inTangents = pairs(v.value.inTangents);
      s.outTangents = pairs(v.value.outTangents);
      s.closed = v.value.closed;
      return s;
    }
    default: return (v as { value?: unknown }).value ?? null;
  }
}

const num = (x: unknown, what: string): number => {
  const n = Number(x);
  if (!Number.isFinite(n)) throw new Error(`${what}: expected a number, got ${String(x)}`);
  return n;
};
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : [x]);

/** An ExtendScript value → the engine Value of a property of `valueType` (current = its present value). */
export function valueFromAe(x: unknown, valueType: string, current?: Value): Value {
  switch (valueType) {
    case 'scalar': return { kind: 'scalar', value: num(Array.isArray(x) ? x[0] : x, 'setValue') };
    case 'int': return { kind: 'int', value: Math.round(num(Array.isArray(x) ? x[0] : x, 'setValue')) };
    case 'bool': return { kind: 'bool', value: Boolean(x) };
    case 'string': return { kind: 'string', value: String(x) };
    case 'choice': return { kind: 'choice', value: String(x) };
    case 'vec2': { const a = arr(x); return { kind: 'vec2', value: { x: num(a[0], 'x'), y: num(a[1] ?? a[0], 'y') } }; }
    case 'vec3': { const a = arr(x); return { kind: 'vec3', value: { x: num(a[0], 'x'), y: num(a[1] ?? a[0], 'y'), z: num(a[2] ?? 0, 'z') } }; }
    case 'vec4': { const a = arr(x); return { kind: 'vec4', value: { x: num(a[0], 'x'), y: num(a[1], 'y'), z: num(a[2], 'z'), w: num(a[3], 'w') } }; }
    case 'color': { const a = arr(x); return { kind: 'color', value: { r: num(a[0], 'r'), g: num(a[1], 'g'), b: num(a[2], 'b'), a: a[3] === undefined ? 1 : num(a[3], 'a') } }; }
    case 'json': return { kind: 'json', value: typeof x === 'string' ? x : JSON.stringify(x) };
    case 'textDocument': {
      const text = x instanceof TextDocument ? x.text : typeof x === 'object' && x && 'text' in x ? String((x as { text: unknown }).text) : String(x);
      if (current?.kind === 'textDocument') return { kind: 'textDocument', value: { ...current.value, text } };
      return { kind: 'string', value: text };
    }
    case 'path': {
      const s = x as Shape;
      const flat = (ps: number[][] = []): number[] => ps.flatMap((p) => [num(p[0], 'x'), num(p[1], 'y')]);
      return { kind: 'path', value: { vertices: flat(s.vertices), inTangents: flat(s.inTangents), outTangents: flat(s.outTangents), closed: s.closed !== false, featherPoints: [] } as never };
    }
    default:
      throw new Error(`setValue: properties of type '${valueType}' cannot be set from a script yet`);
  }
}

// ---------------------------------------------------------------------------
// Names: AE display names / match names → property paths, without a query.

const ROOT_NAMES: Record<string, string> = {
  transform: 'transform', 'adbe transform group': 'transform',
  text: 'text', 'adbe text properties': 'text',
  effects: 'effects', 'adbe effect parade': 'effects',
  masks: 'masks', 'adbe mask parade': 'masks',
  contents: 'contents', 'adbe root vectors group': 'contents',
  'material options': 'material', 'adbe material options group': 'material',
  audio: 'audio', 'adbe audio group': 'audio',
  'time remap': 'timeRemap', 'adbe time remapping': 'timeRemap',
};
const TRANSFORM_NAMES: Record<string, string> = {
  'anchor point': 'anchorPoint', 'adbe anchor point': 'anchorPoint', anchorpoint: 'anchorPoint',
  position: 'position', 'adbe position': 'position',
  scale: 'scale', 'adbe scale': 'scale',
  rotation: 'rotation', 'z rotation': 'rotation', 'adbe rotate z': 'rotation', zrotation: 'rotation',
  'x rotation': 'xRotation', 'adbe rotate x': 'xRotation', xrotation: 'xRotation',
  'y rotation': 'yRotation', 'adbe rotate y': 'yRotation', yrotation: 'yRotation',
  orientation: 'orientation', 'adbe orientation': 'orientation',
  opacity: 'opacity', 'adbe opacity': 'opacity',
};
const TEXT_NAMES: Record<string, string> = {
  'source text': 'sourceText', 'adbe text document': 'sourceText', sourcetext: 'sourceText',
};

const LAYER_KIND_CLASS: Record<string, 'text' | 'shape' | 'camera' | 'light' | 'av'> = {
  text: 'text', shape: 'shape', rectangle: 'shape', ellipse: 'shape', polygon: 'shape', path: 'shape',
  camera: 'camera', light: 'light',
};

// ---------------------------------------------------------------------------
// The object model.

/** Build the globals a script sees: `app`, the classes for `instanceof`, and the ExtendScript helpers. */
export function createAeGlobals(b: AeBridge): Record<string, unknown> {
  const docItems = (): ItemInfo[] =>
    b.query<{ items: ItemInfo[] }>({ type: 'getDocument', includeProperties: false, includeKeyframes: false }).items;
  const compDetails = (id: string): { comp: CompInfo; layers: LayerInfo[] } =>
    b.query<{ comp: CompInfo; layers: LayerInfo[] }>({ type: 'getComposition', comp: id });
  const layerInfo = (id: string): LayerInfo => {
    const l = b.query<{ layers: LayerInfo[] }>({ type: 'getLayers', layers: [id] }).layers[0];
    if (!l) throw new Error(`The layer ${id} no longer exists.`);
    return l;
  };

  /** A collection indexable as `c[1]` (AE collections are 1-based). */
  const indexable = <T extends object>(target: T, at: (i: number) => unknown): T =>
    new Proxy(target, {
      get(t, key, recv) {
        if (typeof key === 'string' && /^\d+$/.test(key)) return at(Number(key));
        return Reflect.get(t, key, recv) as unknown;
      },
    });

  const oneBased = <T>(list: readonly T[], i: number, what: string): T => {
    const n = Math.floor(Number(i));
    const v = list[n - 1];
    if (n < 1 || v === undefined) throw new Error(`${what}(${String(i)}): index out of range 1..${list.length}`);
    return v;
  };

  // --- Items ---------------------------------------------------------------

  class Item {
    readonly id: string;
    constructor(id: string) { this.id = id; }
    protected info(): ItemInfo {
      const it = docItems().find((x) => x.id === this.id);
      if (!it) throw new Error(`The project item ${this.id} no longer exists.`);
      return it;
    }
    get name(): string { return this.info().name; }
    set name(v: string) { b.fire({ type: 'renameItem', item: this.id, name: String(v) }); }
    get comment(): string { return this.info().comment; }
    get parentFolder(): FolderItem | null { const p = this.info().parent; return p ? new FolderItem(p) : null; }
    get typeName(): string { return 'Item'; }
    remove(): void { b.fire({ type: 'removeItems', items: [this.id], removeUsingLayers: true }); }
  }
  class FolderItem extends Item {
    override get typeName(): string { return 'Folder'; }
    get items(): unknown[] { return docItems().filter((x) => x.parent === this.id).map(itemFor); }
    get numItems(): number { return docItems().filter((x) => x.parent === this.id).length; }
    item(i: number): unknown { return oneBased(this.items, i, 'item'); }
  }
  class FootageItem extends Item {
    override get typeName(): string { return 'Footage'; }
    get width(): number { return this.info().width; }
    get height(): number { return this.info().height; }
    get duration(): number { return toSeconds(this.info().duration); }
    get frameRate(): number { const r = this.info().frameRate; return r ? r.num / r.den : 0; }
  }

  class CompItem extends Item {
    override get typeName(): string { return 'Composition'; }
    private settings(): CompSettings { return compDetails(this.id).comp.settings; }
    private patch(patch: Record<string, unknown>): void { b.fire({ type: 'setCompositionSettings', comp: this.id, patch }); }
    override get name(): string { return this.settings().name; }
    override set name(v: string) { this.patch({ name: String(v) }); }
    get width(): number { return this.settings().width; }
    set width(v: number) { this.patch({ width: Math.round(num(v, 'width')) }); }
    get height(): number { return this.settings().height; }
    set height(v: number) { this.patch({ height: Math.round(num(v, 'height')) }); }
    get pixelAspect(): number { return this.settings().pixelAspect; }
    set pixelAspect(v: number) { this.patch({ pixelAspect: num(v, 'pixelAspect') }); }
    get duration(): number { return toSeconds(this.settings().duration); }
    set duration(v: number) { this.patch({ duration: toFlicks(num(v, 'duration')) }); }
    get frameRate(): number { const r = this.settings().frameRate; return r.num / r.den; }
    set frameRate(v: number) { this.patch({ frameRate: rationalFps(v) }); }
    get frameDuration(): number { const r = this.settings().frameRate; return r.den / r.num; }
    get bgColor(): number[] { const c = this.settings().background; return [c.r, c.g, c.b]; }
    set bgColor(v: number[]) { const a = arr(v); this.patch({ background: { r: num(a[0], 'r'), g: num(a[1], 'g'), b: num(a[2], 'b'), a: 1 } }); }
    get workAreaStart(): number { return toSeconds(this.settings().workArea?.start ?? 0); }
    get workAreaDuration(): number { const s = this.settings(); return toSeconds(s.workArea?.duration ?? s.duration); }
    /** The editor's current time when the run started (seconds). */
    get time(): number { return toSeconds(b.time); }
    get numLayers(): number { return compDetails(this.id).comp.layers.length; }
    /** Editor state is not part of the document: a script sees no selection. */
    get selectedLayers(): Layer[] { return []; }
    get selectedProperties(): unknown[] { return []; }
    get layers(): LayerCollection { return new LayerCollection(this); }
    layer(which: number | string): Layer {
      const d = compDetails(this.id);
      if (typeof which === 'string') {
        const hit = d.layers.find((l) => l.name === which);
        if (!hit) throw new Error(`layer("${which}"): no layer of that name in "${d.comp.settings.name}"`);
        return layerFor(hit);
      }
      const id = oneBased(d.comp.layers, which, 'layer');
      const info = d.layers.find((l) => l.id === id) ?? layerInfo(id);
      return layerFor(info);
    }
    duplicate(): CompItem {
      const r = b.execute<{ item: string }>({ type: 'duplicateComposition', comp: this.id, deep: false });
      return new CompItem(r.item);
    }
    openInViewer(): null { return null; }
  }

  class LayerCollection {
    readonly comp: CompItem;
    constructor(comp: CompItem) {
      this.comp = comp;
      return indexable(this, (i) => this.comp.layer(i));
    }
    get length(): number { return this.comp.numLayers; }
    byName(name: string): Layer | null {
      const hit = compDetails(this.comp.id).layers.find((l) => l.name === name);
      return hit ? layerFor(hit) : null;
    }
    private create(kind: string, name: string | undefined, init: unknown[], extra: Record<string, unknown> = {}): Layer {
      const r = b.execute<{ layer: string }>({ type: 'createLayer', comp: this.comp.id, kind, ...(name ? { name } : {}), init, ...extra });
      return makeLayer(r.layer, this.comp.id, kind);
    }
    private timing(duration: unknown): Record<string, unknown> {
      return duration === undefined || duration === null ? {} : { inPoint: 0, outPoint: toFlicks(num(duration, 'duration')) };
    }
    /** layers.addSolid(color, name, width, height, pixelAspect[, duration]) */
    addSolid(color: number[], name?: string, width?: number, height?: number, _pixelAspect?: number, duration?: number): Layer {
      const c = arr(color ?? [1, 1, 1]);
      const init: unknown[] = [
        { path: 'layer/fill', value: { kind: 'color', value: { r: num(c[0], 'r'), g: num(c[1], 'g'), b: num(c[2], 'b'), a: 1 } } },
      ];
      if (width !== undefined) init.push({ path: 'layer/width', value: { kind: 'scalar', value: num(width, 'width') } });
      if (height !== undefined) init.push({ path: 'layer/height', value: { kind: 'scalar', value: num(height, 'height') } });
      return this.create('solid', name === undefined ? undefined : String(name), init, this.timing(duration));
    }
    /** layers.addText([sourceText]) — a string or a TextDocument. */
    addText(text?: string | TextDocument): Layer {
      const t = text === undefined ? '' : text instanceof TextDocument ? text.text : String(text);
      const init: unknown[] = t ? [{ path: 'text/sourceText', value: { kind: 'string', value: t } }] : [];
      if (text instanceof TextDocument && text.fontSize !== undefined) init.push({ path: 'text/fontSize', value: { kind: 'scalar', value: num(text.fontSize, 'fontSize') } });
      if (text instanceof TextDocument && text.font) init.push({ path: 'text/fontFamily', value: { kind: 'string', value: String(text.font) } });
      return this.create('text', t || undefined, init);
    }
    /** layers.addNull([duration]) */
    addNull(duration?: number): Layer { return this.create('null', undefined, [], this.timing(duration)); }
    /** layers.addShape() — Premation's shape layer (a rectangle primitive; AE's starts empty). */
    addShape(): Layer { return this.create('shape', undefined, []); }
    addCamera(name?: string, _centerPoint?: number[]): Layer { return this.create('camera', name === undefined ? undefined : String(name), []); }
    addLight(name?: string, _centerPoint?: number[]): Layer { return this.create('light', name === undefined ? undefined : String(name), []); }
    /** layers.add(item) — a footage or composition item as a layer. */
    add(item: Item, duration?: number): Layer {
      if (!(item instanceof Item)) throw new Error('layers.add(item): expected a project item');
      const kind = item instanceof CompItem ? 'precomp' : 'image';
      return this.create(kind, undefined, [], { source: item.id, ...this.timing(duration) });
    }
  }

  class ItemCollection {
    constructor() { return indexable(this, (i) => project.item(i)); }
    get length(): number { return docItems().length; }
    /** items.addComp(name, width, height, pixelAspect, duration, frameRate) */
    addComp(name: string, width: number, height: number, pixelAspect: number, duration: number, frameRate: number): CompItem {
      const r = b.execute<{ item: string }>({
        type: 'createComposition',
        settings: {
          name: String(name),
          width: Math.round(num(width, 'width')),
          height: Math.round(num(height, 'height')),
          pixelAspect: pixelAspect === undefined ? 1 : num(pixelAspect, 'pixelAspect'),
          duration: toFlicks(num(duration, 'duration')),
          frameRate: rationalFps(frameRate),
        },
        fromItems: [],
      });
      return new CompItem(r.item);
    }
    addFolder(name: string): FolderItem {
      const r = b.execute<{ item: string }>({ type: 'createFolder', name: String(name) });
      return new FolderItem(r.item);
    }
  }

  function itemFor(info: ItemInfo): Item {
    switch (info.kind) {
      case 'composition': return new CompItem(info.id);
      case 'folder': return new FolderItem(info.id);
      default: return new FootageItem(info.id);
    }
  }

  // --- Properties ----------------------------------------------------------

  class PropertyBase {
    readonly layerId: string;
    readonly path: string;
    protected readonly knownName: string | undefined;
    constructor(layerId: string, path: string, knownName?: string) {
      this.layerId = layerId;
      this.path = path;
      this.knownName = knownName;
    }
    protected node(depth = 1): PropertyInfo {
      const nodes = b.query<{ nodes: PropertyInfo[] }>({ type: 'getPropertyTree', layer: this.layerId, path: this.path, depth }).nodes;
      const n = nodes.find((x) => x.path === this.path) ?? nodes[0];
      if (!n) throw new Error(`The property ${this.path} does not exist on this layer.`);
      return n;
    }
    get name(): string { return this.knownName ?? this.node().name; }
    get matchName(): string { return this.node().matchName; }
    get propertyType(): string { return this instanceof Property ? 'PROPERTY' : 'NAMED_GROUP'; }
    get parentProperty(): PropertyGroup | null {
      const i = this.path.lastIndexOf('/');
      return i < 0 ? null : new PropertyGroup(this.layerId, this.path.slice(0, i));
    }
    get propertyDepth(): number { return this.path.split('/').length; }
  }

  class PropertyGroup extends PropertyBase {
    constructor(layerId: string, path: string, knownName?: string) {
      super(layerId, path, knownName);
      // AE's attribute shortcuts (`layer.transform.position`, `layer.text.sourceText`):
      // only the statically known names, so a probe such as `then` never queries.
      return new Proxy(this, {
        get(t, key, recv) {
          if (typeof key !== 'string' || key in t) return Reflect.get(t, key, recv) as unknown;
          const k = key.toLowerCase();
          const sub = t.path === 'transform' ? TRANSFORM_NAMES[k] : t.path === 'text' ? TEXT_NAMES[k] : undefined;
          if (sub) return new Property(t.layerId, `${t.path}/${sub}`);
          if (t.path === '' && ROOT_NAMES[k]) return new PropertyGroup(t.layerId, ROOT_NAMES[k]);
          return undefined;
        },
      });
    }
    private childPaths(): string[] {
      if (this.path === '') {
        return b.query<{ nodes: PropertyInfo[] }>({ type: 'getPropertyTree', layer: this.layerId, path: '', depth: 1 }).nodes
          .filter((n) => !n.path.includes('/')).map((n) => n.path);
      }
      return this.node(2).children;
    }
    get numProperties(): number { return this.childPaths().length; }
    /** property(name | matchName | 1-based index) */
    property(which: number | string): PropertyBase | null {
      if (typeof which === 'number') {
        const path = oneBased(this.childPaths(), which, 'property');
        return propertyAt(this.layerId, path);
      }
      const key = String(which).trim().toLowerCase();
      const known = this.path === '' ? ROOT_NAMES[key]
        : this.path === 'transform' ? (TRANSFORM_NAMES[key] ? `transform/${TRANSFORM_NAMES[key]}` : undefined)
        : this.path === 'text' ? (TEXT_NAMES[key] ? `text/${TEXT_NAMES[key]}` : undefined)
        : undefined;
      if (known) return propertyAt(this.layerId, known, String(which));
      // The layer root also answers the transform and text properties by name (AE's shortcut).
      if (this.path === '' && TRANSFORM_NAMES[key]) return propertyAt(this.layerId, `transform/${TRANSFORM_NAMES[key]}`, String(which));
      if (this.path === '' && TEXT_NAMES[key]) return propertyAt(this.layerId, `text/${TEXT_NAMES[key]}`, String(which));
      const depth = this.path === '' ? 1 : 2;
      const nodes = b.query<{ nodes: PropertyInfo[] }>({ type: 'getPropertyTree', layer: this.layerId, path: this.path, depth }).nodes;
      const parentOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
      const hit = nodes.find((n) => parentOf(n.path) === this.path && n.path !== this.path
        && (n.name.toLowerCase() === key || n.matchName.toLowerCase() === key || n.path.slice(n.path.lastIndexOf('/') + 1).toLowerCase() === key));
      return hit ? makeProperty(this.layerId, hit) : null;
    }
  }

  class Property extends PropertyBase {
    private ref(): { layer: string; path: string } { return { layer: this.layerId, path: this.path }; }
    private valueAt(time: number, evaluated: boolean): Value | undefined {
      return b.query<{ values: { value: Value }[] }>({ type: 'getPropertyValues', props: [this.ref()], time, evaluated }).values[0]?.value;
    }
    private keys(): Keyframe[] {
      const sets = b.query<{ sets: { keyframes: Keyframe[] }[] }>({ type: 'getKeyframes', props: [this.ref()] }).sets;
      return [...(sets[0]?.keyframes ?? [])].sort((a, c) => a.time - c.time);
    }
    private toValue(v: unknown): Value {
      const n = this.node();
      return valueFromAe(v, n.valueType, n.value);
    }
    get value(): unknown { return valueToAe(this.valueAt(b.time, true)); }
    valueAtTime(t: number, preExpression = false): unknown { return valueToAe(this.valueAt(toFlicks(num(t, 'time')), !preExpression)); }
    setValue(v: unknown): void {
      b.fire({ type: 'setProperty', prop: this.ref(), value: this.toValue(v) });
      if (v instanceof TextDocument && this.path === 'text/sourceText') this.applyTextStyle(v);
    }
    setValueAtTime(t: number, v: unknown): void {
      b.fire({ type: 'addKeyframes', keys: [{ prop: this.ref(), time: toFlicks(num(t, 'time')), value: this.toValue(v), spatialIn: [], spatialOut: [] }] });
    }
    setValuesAtTimes(times: number[], values: unknown[]): void {
      if (!Array.isArray(times) || !Array.isArray(values) || times.length !== values.length) {
        throw new Error('setValuesAtTimes(times, values): two arrays of the same length');
      }
      const n = this.node();
      b.fire({
        type: 'addKeyframes',
        keys: times.map((t, i) => ({ prop: this.ref(), time: toFlicks(num(t, 'time')), value: valueFromAe(values[i], n.valueType, n.value), spatialIn: [], spatialOut: [] })),
      });
    }
    private applyTextStyle(td: TextDocument): void {
      if (td.fontSize !== undefined) b.fire({ type: 'setProperty', prop: { layer: this.layerId, path: 'text/fontSize' }, value: { kind: 'scalar', value: num(td.fontSize, 'fontSize') } });
      if (td.font) b.fire({ type: 'setProperty', prop: { layer: this.layerId, path: 'text/fontFamily' }, value: { kind: 'string', value: String(td.font) } });
    }
    get numKeys(): number { return this.node().keyframeCount; }
    get isTimeVarying(): boolean { const n = this.node(); return n.keyframeCount > 0 || (n.expressionEnabled && n.expression !== ''); }
    get canVaryOverTime(): boolean { return this.node().animatable; }
    get canSetExpression(): boolean { return this.node().animatable; }
    get valueType(): string { return this.node().valueType; }
    get dimensions(): number { return this.node().dimensions; }
    keyTime(i: number): number { return toSeconds(oneBased(this.keys(), i, 'keyTime').time); }
    keyValue(i: number): unknown { return valueToAe(oneBased(this.keys(), i, 'keyValue').value); }
    nearestKeyIndex(t: number): number {
      const ks = this.keys();
      if (ks.length === 0) throw new Error('nearestKeyIndex: the property has no keyframes');
      const f = toFlicks(num(t, 'time'));
      let best = 0;
      ks.forEach((k, i) => { if (Math.abs(k.time - f) < Math.abs(ks[best]!.time - f)) best = i; });
      return best + 1;
    }
    /** addKey(time) → the new key's 1-based index (the value there is kept). */
    addKey(t: number): number {
      const r = b.execute<{ ids: string[] }>({ type: 'addKeyframes', keys: [{ prop: this.ref(), time: toFlicks(num(t, 'time')), spatialIn: [], spatialOut: [] }] });
      const id = r.ids[0];
      return this.keys().findIndex((k) => k.id === id) + 1;
    }
    removeKey(i: number): void { b.fire({ type: 'deleteKeyframes', ids: [oneBased(this.keys(), i, 'removeKey').id] }); }
    setValueAtKey(i: number, v: unknown): void {
      const k = oneBased(this.keys(), i, 'setValueAtKey');
      b.fire({ type: 'updateKeyframes', patches: [{ id: k.id, value: this.toValue(v), spatialIn: [], spatialOut: [] }] });
    }
    get expression(): string { return this.node().expression; }
    set expression(src: string) { b.fire({ type: 'setExpression', prop: this.ref(), source: String(src ?? ''), enabled: true }); }
    get expressionEnabled(): boolean { return this.node().expressionEnabled; }
    set expressionEnabled(on: boolean) { b.fire({ type: 'setExpressionEnabled', props: [this.ref()], enabled: Boolean(on) }); }
    get expressionError(): string { return this.node().expressionError; }
  }

  function makeProperty(layerId: string, n: PropertyInfo): PropertyBase {
    return n.kind === 'property' ? new Property(layerId, n.path, n.name) : new PropertyGroup(layerId, n.path, n.name);
  }
  /** A property by path: a root is a group, a transform / Source Text path a leaf; anything else is asked. */
  function propertyAt(layerId: string, path: string, name?: string): PropertyBase {
    if (!path.includes('/')) return new PropertyGroup(layerId, path, name);
    if (path.startsWith('transform/') || path === 'text/sourceText') return new Property(layerId, path, name);
    const n = b.query<{ nodes: PropertyInfo[] }>({ type: 'getPropertyTree', layer: layerId, path, depth: 1 }).nodes.find((x) => x.path === path);
    if (!n) throw new Error(`The property ${path} does not exist on this layer.`);
    return makeProperty(layerId, n);
  }

  // --- Layers --------------------------------------------------------------

  class Layer {
    readonly id: string;
    protected readonly compId: string;
    constructor(id: string, compId: string) {
      this.id = id;
      this.compId = compId;
    }
    protected info(): LayerInfo { return layerInfo(this.id); }
    private switches(patch: Record<string, unknown>): void { b.fire({ type: 'setLayerSwitches', layers: [this.id], patch }); }
    private timing(patch: Record<string, unknown>): void { b.fire({ type: 'setLayerTiming', items: [{ layer: this.id, ...patch }] }); }
    get name(): string { return this.info().name; }
    set name(v: string) { b.fire({ type: 'renameLayer', layer: this.id, name: String(v) }); }
    get index(): number { return compDetails(this.compId).comp.layers.indexOf(this.id) + 1; }
    get containingComp(): CompItem { return new CompItem(this.compId); }
    get comment(): string { return this.info().comment; }
    set comment(v: string) { b.fire({ type: 'setLayerComment', layer: this.id, comment: String(v) }); }
    get inPoint(): number { return toSeconds(this.info().timing.inPoint); }
    set inPoint(s: number) { this.timing({ inPoint: toFlicks(num(s, 'inPoint')) }); }
    get outPoint(): number { return toSeconds(this.info().timing.outPoint); }
    set outPoint(s: number) { this.timing({ outPoint: toFlicks(num(s, 'outPoint')) }); }
    get startTime(): number { return toSeconds(this.info().timing.startTime); }
    set startTime(s: number) { this.timing({ startTime: toFlicks(num(s, 'startTime')) }); }
    get stretch(): number { return this.info().timing.stretch * 100; }
    set stretch(pct: number) { this.timing({ stretch: num(pct, 'stretch') / 100 }); }
    get enabled(): boolean { return this.info().switches.visible; }
    set enabled(v: boolean) { this.switches({ visible: Boolean(v) }); }
    get solo(): boolean { return this.info().switches.solo; }
    set solo(v: boolean) { this.switches({ solo: Boolean(v) }); }
    get locked(): boolean { return this.info().switches.locked; }
    set locked(v: boolean) { this.switches({ locked: Boolean(v) }); }
    get shy(): boolean { return this.info().switches.shy; }
    set shy(v: boolean) { this.switches({ shy: Boolean(v) }); }
    get threeDLayer(): boolean { return this.info().switches.threeD; }
    set threeDLayer(v: boolean) { this.switches({ threeD: Boolean(v) }); }
    get motionBlur(): boolean { return this.info().switches.motionBlur; }
    set motionBlur(v: boolean) { this.switches({ motionBlur: Boolean(v) }); }
    get adjustmentLayer(): boolean { return this.info().switches.adjustment; }
    set adjustmentLayer(v: boolean) { this.switches({ adjustment: Boolean(v) }); }
    get label(): number { return this.info().switches.label; }
    set label(v: number) { this.switches({ label: Math.round(num(v, 'label')) }); }
    get nullLayer(): boolean { return this.info().kind === 'null'; }
    get parent(): Layer | null {
      const p = this.info().parent;
      return p ? layerFor(layerInfo(p)) : null;
    }
    set parent(p: Layer | null) {
      if (p !== null && p !== undefined && !(p instanceof Layer)) throw new Error('parent: expected a layer or null');
      b.fire({ type: 'setParent', layers: [this.id], ...(p ? { parent: p.id } : {}), keepWorldTransform: true });
    }
    setParentWithJump(p: Layer | null): void {
      b.fire({ type: 'setParent', layers: [this.id], ...(p ? { parent: p.id } : {}), keepWorldTransform: false });
    }
    remove(): void { b.fire({ type: 'deleteLayers', layers: [this.id] }); }
    duplicate(): Layer {
      const r = b.execute<{ layers: string[] }>({ type: 'duplicateLayers', layers: [this.id] });
      return layerFor(layerInfo(r.layers[0]!));
    }
    moveToBeginning(): void { b.fire({ type: 'reorderLayers', comp: this.compId, layers: [this.id], toIndex: 0 }); }
    moveToEnd(): void {
      const n = compDetails(this.compId).comp.layers.length;
      b.fire({ type: 'reorderLayers', comp: this.compId, layers: [this.id], toIndex: Math.max(0, n - 1) });
    }
    moveBefore(other: Layer): void {
      const order = compDetails(this.compId).comp.layers.filter((l) => l !== this.id);
      b.fire({ type: 'reorderLayers', comp: this.compId, layers: [this.id], toIndex: Math.max(0, order.indexOf(other.id)) });
    }
    moveAfter(other: Layer): void {
      const order = compDetails(this.compId).comp.layers.filter((l) => l !== this.id);
      b.fire({ type: 'reorderLayers', comp: this.compId, layers: [this.id], toIndex: order.indexOf(other.id) + 1 });
    }
    /** property(name | matchName | index) on the layer's root group. */
    property(which: number | string): PropertyBase | null { return new PropertyGroup(this.id, '').property(which); }
    get numProperties(): number { return new PropertyGroup(this.id, '').numProperties; }
    get transform(): PropertyGroup { return new PropertyGroup(this.id, 'transform', 'Transform'); }
    get position(): Property { return new Property(this.id, 'transform/position', 'Position'); }
    get anchorPoint(): Property { return new Property(this.id, 'transform/anchorPoint', 'Anchor Point'); }
    get scale(): Property { return new Property(this.id, 'transform/scale', 'Scale'); }
    get rotation(): Property { return new Property(this.id, 'transform/rotation', 'Rotation'); }
    get opacity(): Property { return new Property(this.id, 'transform/opacity', 'Opacity'); }
    get Effects(): PropertyGroup { return new PropertyGroup(this.id, 'effects', 'Effects'); }
    effect(which: number | string): PropertyBase | null { return new PropertyGroup(this.id, 'effects', 'Effects').property(which); }
    get typeName(): string { return 'Layer'; }
  }
  class AVLayer extends Layer { override get typeName(): string { return 'AV Layer'; } }
  class TextLayer extends AVLayer {
    override get typeName(): string { return 'Text Layer'; }
    get text(): PropertyGroup & { sourceText: Property } {
      const g = new PropertyGroup(this.id, 'text', 'Text') as PropertyGroup & { sourceText: Property };
      Object.defineProperty(g, 'sourceText', { value: new Property(this.id, 'text/sourceText', 'Source Text') });
      return g;
    }
    get sourceText(): Property { return new Property(this.id, 'text/sourceText', 'Source Text'); }
  }
  class ShapeLayer extends AVLayer { override get typeName(): string { return 'Shape Layer'; } }
  class CameraLayer extends Layer { override get typeName(): string { return 'Camera Layer'; } }
  class LightLayer extends Layer { override get typeName(): string { return 'Light Layer'; } }

  function makeLayer(id: string, compId: string, kind: string): Layer {
    switch (LAYER_KIND_CLASS[kind] ?? 'av') {
      case 'text': return new TextLayer(id, compId);
      case 'shape': return new ShapeLayer(id, compId);
      case 'camera': return new CameraLayer(id, compId);
      case 'light': return new LightLayer(id, compId);
      default: return new AVLayer(id, compId);
    }
  }
  function layerFor(info: LayerInfo): Layer { return makeLayer(info.id, info.comp, info.kind); }

  // --- Project / app -------------------------------------------------------

  const project = {
    get activeItem(): Item | null {
      if (!b.activeItem) return null;
      const it = docItems().find((x) => x.id === b.activeItem);
      return it ? itemFor(it) : null;
    },
    get items(): ItemCollection { return new ItemCollection(); },
    get numItems(): number { return docItems().length; },
    item(i: number): Item { return itemFor(oneBased(docItems(), i, 'item')); },
    /** Premation shorthand for items.addComp. */
    addComp(name: string, width: number, height: number, pixelAspect: number, duration: number, frameRate: number): CompItem {
      return new ItemCollection().addComp(name, width, height, pixelAspect, duration, frameRate);
    },
    /** The project's compositions (a convenience; AE scripts filter items). */
    get compositions(): CompItem[] { return docItems().filter((x) => x.kind === 'composition').map((x) => new CompItem(x.id)); },
  };

  const unsupported = (what: string) => () => {
    throw new Error(`${what} is not available to Premation scripts.`);
  };
  const show = (xs: unknown[]): string => xs.map((x) => (typeof x === 'string' ? x : x instanceof TextDocument ? x.text : JSON.stringify(x))).join(' ');

  const app = {
    project,
    version: '24.0',
    buildName: 'Premation',
    language: 'en_US',
    isWatchFolder: false,
    /** One script run is one undo entry already; these are accepted and ignored. */
    beginUndoGroup(_name?: string): void { /* the run is one entry */ },
    endUndoGroup(): void { /* the run is one entry */ },
    beginSuppressDialogs(): void { /* no dialogs */ },
    endSuppressDialogs(_alert?: boolean): void { /* no dialogs */ },
    executeCommand: unsupported('app.executeCommand'),
    findMenuCommandId: unsupported('app.findMenuCommandId'),
    newProject: unsupported('app.newProject'),
    open: unsupported('app.open'),
    quit: unsupported('app.quit'),
    scheduleTask: unsupported('app.scheduleTask'),
  };

  const $ = {
    writeln: (...xs: unknown[]): void => b.log(show(xs)),
    write: (...xs: unknown[]): void => b.log(show(xs)),
    sleep: (): void => { /* scripts never block the worker on a timer */ },
    gc: (): void => { /* nothing to collect */ },
    global: undefined as unknown,
    version: '4.5.5',
    os: 'Premation',
  };

  return {
    app,
    $,
    alert: (msg: unknown): void => b.log(show([msg])),
    /** No modal UI in the sandbox: logged, answered OK. */
    confirm: (msg: unknown): boolean => { b.log(`${show([msg])} (confirm: answered OK)`); return true; },
    /** No modal UI in the sandbox: logged, answered with the default. */
    prompt: (msg: unknown, def?: unknown): unknown => { b.log(`${show([msg])} (prompt: answered "${String(def ?? '')}")`); return def ?? ''; },
    Item, FolderItem, FootageItem, CompItem, Layer, AVLayer, TextLayer, ShapeLayer, CameraLayer, LightLayer,
    PropertyBase, PropertyGroup, Property, TextDocument, Shape,
  };
}

/** The global names createAeGlobals returns (the script function's parameters). */
export const AE_GLOBAL_NAMES = [
  'app', '$', 'alert', 'confirm', 'prompt',
  'Item', 'FolderItem', 'FootageItem', 'CompItem', 'Layer', 'AVLayer', 'TextLayer', 'ShapeLayer', 'CameraLayer', 'LightLayer',
  'PropertyBase', 'PropertyGroup', 'Property', 'TextDocument', 'Shape',
] as const;
