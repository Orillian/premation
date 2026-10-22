/**
 * `premation render-item <pack-dir>` — the renderer half (electron/cliRenderItem.ts
 * is the main-process half: engine process, files, ffmpeg).
 *
 * A Library pack's card media must be rendered from exactly what a buyer
 * inserts, so the pack is laid into a NEW document by the Library's own
 * interpreters, not a look-alike:
 *   template   — `preparedLayers` (templateStore.applyPayload's preparation:
 *                assets imported first, placeholders rewritten, an element
 *                placed at the comp centre) pasted as one `pasteLayers`; a
 *                scene into a composition made to its settings, an element
 *                over a demo backdrop;
 *   transition — `planSpecTransition` (the Library's layer-mode apply) keyed
 *                onto a demo card over a backdrop: the entrance at the card's
 *                in-point, the exit at its out-point, effects added with the
 *                ids the keys use, `setMemberKeyframes` + the motion-blur switch
 *                (transitionInsertEdits.ts `layerTransitionEdit`).
 * Frames come from the engine (`getThumbnail`, the card path) and go to the
 * caller's sink; the loop is seamless by construction (frames 0 … n-1 of a
 * piece that rests where it starts).
 *
 * No Node, no stores: the engine is the client handed in, the files are the
 * bytes handed in. Bundled for main by scripts/buildRenderItem.cjs.
 */

import { AnimationEngine } from '@motion/animation';
import { ProcessEngineClient, secondsToFlicks, type Command, type EngineBridge, type EngineClient, type PropertyInit, type Value } from '@motion/engine-api';
import { FragmentBuilder, encodeFragmentLayers, type FragmentLayer } from '@/engine-client/fragmentBuilder';
import { effectDefFor, parseColorChannels } from '@core/effects/effects';
import { catalogItemProblem, parsePayload, type PremiumMeta, type TemplatePayload, type TransitionPayload } from './packFormat';
import { preparedLayers, type ImportedRef, type PlacementTarget } from './templatePayload';
import { planSpecTransition } from './transitionSpec';
import type { TransitionLayerFacts } from '@core/library/transitionLibrary';

export interface RenderItemInput {
  /** meta.json and payload.json, as read. */
  meta: Uint8Array;
  payload: Uint8Array;
  /** The demo card a transition plays on (an encoded image), from main. */
  card: { bytes: Uint8Array; mime: string; width: number; height: number };
  size: number;
  fps: number;
  posterTime?: number;
}

export interface RenderItemSink {
  /** Frame `index` of the loop, encoded (`format`: png / jpeg). In order. */
  frame(index: number, bytes: Uint8Array, format: string): Promise<void> | void;
  log?(message: string): void;
  progress?(fraction: number): void;
}

export interface RenderItemResult {
  id: string;
  kind: PremiumMeta['kind'];
  frames: number;
  width: number;
  height: number;
  durationSec: number;
  posterTime: number;
  poster: { bytes: Uint8Array; format: string };
  /** `snapshot.layerErrors` of the rendered comp (font, effect, decode…) — a card that hides one must not ship. */
  layerErrors: Array<{ layer: string; stage: string; message: string }>;
}

class ItemError extends Error {}

function ok<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }, what: string): T {
  if (!r.ok) throw new ItemError(`${what}: ${r.error.message}`);
  return r.value;
}

const color = (hex: string): { r: number; g: number; b: number; a: number } => {
  const [r, g, b, a] = parseColorChannels(hex);
  return { r, g, b, a };
};

/** Demo scene for transitions and elements: a deep, quiet backdrop with two soft blooms and a hairline horizon. */
function backdrop(b: FragmentBuilder, w: number, h: number): void {
  const rect = (id: string, x: number, y: number, rw: number, rh: number, fill: string, opacity = 100, shape = 'rect'): void => {
    b.layer({
      id, name: id, parent: null,
      components: [
        { id: `${id}_t`, type: 'Transform', props: { __kind: 'shape', x, y, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0, width: rw, height: rh, shapeType: shape } },
        { id: `${id}_s`, type: 'Style', props: { opacity, fill } },
      ],
    });
  };
  rect('Backdrop', w / 2, h / 2, w, h, '#0c0e14');
  rect('Bloom A', w * 0.18, h * 0.2, w * 0.4, w * 0.4, '#2b4cff', 16, 'ellipse');
  b.setFx('Bloom A', 'effects', [{ id: 'bloomA_blur', type: 'gaussian-blur', enabled: true, params: { blurriness: Math.round(w * 0.1) } }]);
  rect('Bloom B', w * 0.84, h * 0.84, w * 0.36, w * 0.36, '#ff5a3c', 12, 'ellipse');
  b.setFx('Bloom B', 'effects', [{ id: 'bloomB_blur', type: 'gaussian-blur', enabled: true, params: { blurriness: Math.round(w * 0.1) } }]);
  rect('Horizon', w / 2, h * 0.5, w, Math.max(1, h / 1080), '#ffffff', 6);
}

/** A spec's effect init values as typed `addEffect` params (transitionInsertEdits.ts `effectInit`, static values only). */
function effectInit(type: string, init: Record<string, number | string | boolean> | undefined): PropertyInit[] {
  const def = effectDefFor(type);
  if (!def || !init) return [];
  const out: PropertyInit[] = [];
  for (const [key, raw] of Object.entries(init)) {
    const p = def.params.find((x) => x.key === key);
    if (!p) continue;
    let v: Value | null = null;
    if (p.type === 'number' && typeof raw === 'number') v = { kind: 'scalar', value: raw };
    else if (p.type === 'enum') {
      const opt = p.options?.find((o) => o.value === Number(raw));
      v = opt ? { kind: 'choice', value: opt.label } : null;
    } else if (p.type === 'checkbox') v = { kind: 'bool', value: raw === true || raw === 1 };
    else if (p.type === 'color' && typeof raw === 'string') v = { kind: 'color', value: color(raw) };
    if (v) out.push({ path: key, value: v });
  }
  return out;
}

async function createComp(client: EngineClient, name: string, s: TemplatePayload['settings']): Promise<string> {
  const res = ok(await client.execute({
    type: 'createComposition',
    settings: { name, width: s.width, height: s.height, frameRate: { num: s.fps, den: 1 }, duration: secondsToFlicks(s.durationSeconds), background: color(s.background) },
    fromItems: [],
  } as Command), 'createComposition') as unknown as { item: string };
  return res.item;
}

async function paste(client: EngineClient, comp: string, layers: FragmentLayer[], index = 0): Promise<string[]> {
  const res = ok(await client.execute({ type: 'pasteLayers', comp, fragment: encodeFragmentLayers(layers), index } as Command), 'pasteLayers') as { layers?: string[] };
  return res.layers ?? [];
}

async function importBytes(client: EngineClient, name: string, data: Uint8Array, mimeType: string): Promise<ImportedRef & { ref: string }> {
  const res = ok(await client.execute({ type: 'importBytes', files: [{ name, data, mimeType }] } as Command), `import ${name}`) as { items?: string[] };
  const id = res.items?.[0];
  if (!id) throw new ItemError(`import ${name}: no item`);
  const info = ok(await client.query({ type: 'getItems', items: [id] }), 'getItems').items[0];
  return { ref: '', id, src: info?.mediaUrl ?? '' };
}

/** A template, as templateStore.applyPayload lays it. Returns the comp and the rest time. */
/** What a pack laid into a document is, for the card render and for pack checks. */
export interface LaidItem {
  comp: string;
  duration: number;
  /** The rest frame (the card's still) when the pack names none. */
  rest?: number;
  /** Templates: the fields with their targets remapped onto the pasted layers (applyPayload's remap). */
  fields?: TemplatePayload['fields'];
  /** Transitions: the demo card, its pose and when the entrance and exit run. */
  card?: { layer: string; pose: { x: number; y: number; scaleX: number; scaleY: number; rotation: number }; enterAt: number; exitAt: number; duration: number };
}

async function layTemplate(client: EngineClient, meta: PremiumMeta, p: TemplatePayload): Promise<LaidItem> {
  const s = p.settings;
  const comp = await createComp(client, meta.name, s);
  const imported: ImportedRef[] = [];
  for (const a of p.assets) {
    const r = await importBytes(client, a.name, base64(a.data), a.mime);
    imported.push({ ref: a.ref, id: r.id, src: r.src });
  }
  let target: PlacementTarget | null = null;
  if (p.mode === 'element') {
    // An element lands in the user's comp; the card shows it over a demo backdrop.
    const b = new FragmentBuilder({ idPrefix: 'demo' });
    backdrop(b, s.width, s.height);
    const built = b.build();
    if (built) await paste(client, comp, built.layers);
    target = { width: s.width, height: s.height, fps: s.fps, t0: 0 };
  }
  const layers = preparedLayers(p, imported, target);
  const ids = await paste(client, comp, layers, 0);
  const map = new Map(layers.map((l, i) => [l.row.id, ids[i] ?? '']));
  const remap = (tg: TemplatePayload['fields'][number]['target']): typeof tg => ({ ...tg, nodeId: map.get(tg.nodeId) ?? tg.nodeId });
  const fields = p.fields.map((f) => ({ ...f, target: remap(f.target), ...(f.alsoTargets ? { alsoTargets: f.alsoTargets.map(remap) } : {}) }));
  return { comp, duration: s.durationSeconds, fields };
}

/** Lead-in and hold around a transition on the demo card, seconds. */
const LEAD = 0.4;
const HOLD = 1.3;
const TAIL = 0.5;

/** A transition on the demo card: entrance at its in-point, exit at its out-point. */
async function layTransition(client: EngineClient, meta: PremiumMeta, spec: TransitionPayload, card: RenderItemInput['card'], fps: number): Promise<LaidItem> {
  const W = 1920, H = 1080;
  const d = spec.duration;
  const enterAt = LEAD;
  const exitAt = LEAD + d + HOLD;
  const end = exitAt + d;
  const duration = +(end + TAIL).toFixed(4);
  const comp = await createComp(client, meta.name, { width: W, height: H, fps, durationSeconds: duration, background: '#0c0e14' });

  const back = new FragmentBuilder({ idPrefix: 'demo' });
  backdrop(back, W, H);
  await paste(client, comp, back.build()!.layers);

  const img = await importBytes(client, 'demo-card.png', card.bytes, card.mime);
  const cw = 1040, ch = Math.round((1040 * card.height) / card.width);
  const b = new FragmentBuilder({ idPrefix: 'demo' });
  b.layer({
    id: 'card', name: 'Demo card', parent: null,
    components: [
      { id: 'card_t', type: 'Transform', props: { __kind: 'image', x: W / 2, y: H / 2, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0, width: cw, height: ch, src: img.src, assetId: img.id, slotFit: 'cover', slotW: cw, slotH: ch } },
      { id: 'card_s', type: 'Style', props: { opacity: 100 } },
    ],
  });
  // No effects of its own: a transition's effects stack after the layer's, so a
  // shadow here would stay behind every wipe and read as the transition's fault.
  b.setBars('card', [{ start: Math.round(enterAt * fps), duration: Math.round((end - enterAt) * fps), sourceIn: 0, sourceDuration: null }]);
  const [cardId] = await paste(client, comp, b.build()!.layers, 0);
  if (!cardId) throw new ItemError('the demo card did not paste');

  // The facts the Library reads off the mirror, known here: the pose authored above, the bar, no effects yet.
  const pose = { x: W / 2, y: H / 2, scaleX: 1, scaleY: 1, rotation: 0, width: cw, height: ch };
  const added: Array<{ id: string; type: string }> = [];
  const facts: TransitionLayerFacts = {
    pose: (id) => (id === cardId ? pose : null),
    clips: () => ({ fps, clips: [{ start: Math.round(enterAt * fps), end: Math.round(end * fps) }] }),
    effects: () => added,
  };
  const box = { width: W, height: H };
  const keyTimes = new Map<number, number>();
  const keyTime = async (t: number): Promise<number> => {
    let v = keyTimes.get(t);
    if (v === undefined) {
      const r = await client.query({ type: 'mapLayerTime', layer: cardId, time: secondsToFlicks(t), outward: false, keyframeAxis: true });
      v = r.ok && r.value.time !== undefined ? r.value.time / secondsToFlicks(1) : t;
      keyTimes.set(t, v);
    }
    return v;
  };
  const scratch = new AnimationEngine();
  for (const t0 of [enterAt, exitAt]) {
    // withKeyTimes (memberEdits.ts): a dry run learns which comp times map, then the real run.
    const asked = new Set<number>();
    planSpecTransition(spec, [cardId], t0, box, facts, new AnimationEngine(), (_l, t) => { asked.add(t); return t; });
    for (const t of asked) await keyTime(t);
    const plan = planSpecTransition(spec, [cardId], t0, box, facts, scratch, (_l, t) => keyTimes.get(t) ?? t);
    for (const fx of plan.needFx) {
      ok(await client.execute({ type: 'addEffect', layers: [fx.layer], effect: fx.type, params: effectInit(fx.type, fx.init), id: fx.id } as Command), `addEffect ${fx.type}`);
      added.push({ id: fx.id, type: fx.type });
    }
  }
  const tracks = scratch.animatedProps(cardId).map((member) => ({ member, keyframes: JSON.stringify(scratch.getTrackKeyframes(cardId, member) ?? []) }));
  const cmds: Command[] = [{ type: 'setMemberKeyframes', layer: cardId, tracks } as Command];
  if (spec.motionBlur) cmds.push({ type: 'setLayerSwitches', layers: [cardId], patch: { motionBlur: true } } as Command);
  ok(await client.batch(`Apply ${meta.name}`, cmds), 'transition keys');
  return { comp, duration, rest: enterAt + d + HOLD / 2, card: { layer: cardId, pose, enterAt, exitAt, duration: d } };
}

/**
 * Lay a parsed pack into a new composition of the engine `client` reaches, by
 * the Library's interpreters (see the file header). Also the entry pack checks
 * use (the private content repo pastes every pack into the headless engine
 * through this).
 */
export async function layItem(client: EngineClient, meta: PremiumMeta, parsed: ReturnType<typeof parsePayload>, card: RenderItemInput['card'], fps: number): Promise<LaidItem> {
  if (parsed.kind === 'template') return layTemplate(client, meta, parsed.payload);
  if (parsed.kind === 'transition') return layTransition(client, meta, parsed.payload, card, fps);
  throw new ItemError(`render-item renders templates and transitions, not ${meta.kind}`);
}

function base64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Lay the pack into the engine `bridge` talks to and stream its loop to `sink`. Throws with a readable reason. */
export async function renderItem(input: RenderItemInput, bridge: EngineBridge, sink: RenderItemSink): Promise<RenderItemResult> {
  const client = new ProcessEngineClient(bridge);
  await client.whenReady();
  let meta: PremiumMeta & { posterTime?: number };
  try {
    meta = JSON.parse(new TextDecoder().decode(input.meta)) as PremiumMeta & { posterTime?: number };
  } catch {
    throw new ItemError('meta.json is not JSON');
  }
  const bad = catalogItemProblem(meta);
  if (bad) throw new ItemError(`meta.json: ${bad}`);
  let parsed;
  try {
    parsed = parsePayload(meta.kind, input.payload);
  } catch (e) {
    throw new ItemError(`payload.json: ${(e as Error).message}`);
  }
  const laid = await layItem(client, meta, parsed, input.card, input.fps);
  sink.log?.(`${meta.id}: laid into ${laid.comp}, ${laid.duration}s`);

  const grab = async (sec: number): Promise<{ data: Uint8Array; format: string; width: number; height: number }> => {
    const r = ok(await client.query({ type: 'getThumbnail', item: laid.comp, time: secondsToFlicks(sec), maxSize: input.size }), `frame at ${sec}s`);
    return r as unknown as { data: Uint8Array; format: string; width: number; height: number };
  };
  const count = Math.max(1, Math.round(laid.duration * input.fps));
  let width = 0, height = 0;
  for (let f = 0; f < count; f++) {
    const t = await grab(f / input.fps);
    width = t.width; height = t.height;
    await sink.frame(f, t.data, t.format);
    sink.progress?.((f + 1) / (count + 1));
  }
  const posterTime = input.posterTime ?? meta.posterTime ?? laid.rest ?? laid.duration * 0.7;
  const p = await grab(Math.min(posterTime, laid.duration - 1 / input.fps));
  // Read after every frame rendered: a font, decode or effect failure is recorded as it draws.
  const errs = ok(await client.query({ type: 'getLayerErrors', comp: laid.comp }), 'getLayerErrors').errors;
  sink.progress?.(1);
  return { id: meta.id, kind: meta.kind, frames: count, width, height, durationSec: laid.duration, posterTime, poster: { bytes: p.data, format: p.format }, layerErrors: errs.map((x) => ({ layer: x.layer, stage: x.stage, message: x.message })) };
}
