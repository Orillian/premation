/**
 * The Library panel, opened to Claude: `search_library`, `preview_library`'s
 * inserts and `insert_library_item`.
 *
 * One catalog over every shelf the panel offers (and the ones the in-app AI
 * recipes already use): bundled Lottie, transitions, sound FX and templates,
 * the UI kit, cursors and motion graphics, the user's saved components, and
 * the premium shelf (Premation Cloud). Ids are `<kind>:<id>` for bundled
 * items and components, and the catalog's own `pro.<kind>.<slug>` /
 * `free.<kind>.<slug>` for server items.
 *
 * Bundled items and components are built with the SAME builders the panel's
 * click and canvas drop use, then pasted on the call's engine session — so an
 * insert is part of Claude's transaction (one undo step, inside a begin_edit
 * group too, rolled back if the call fails). Templates and premium items take
 * the editor's own paths (McpEditorOps): they download, check the plan, or
 * replace a composition, and run as their own undo step.
 */

import { resolveAlias, bindAlias, type AiEngineSession, type ToolContext } from '@motion/ai-tools';
import type { Command } from '@motion/engine-api';
import { FragmentBuilder, type BuiltFragment } from '@/engine-client/fragmentBuilder';
import { insertFrame } from '@/engine-client/insertFragment';
import { buildLottieFragment } from '@/engine-client/lottieFragment';
import { activeCompRootId } from '@core/scene/activeComp';
import { compTime } from '@core/engine/propRefs';
import { planLottieImport } from '@core/lottie/lottieImport';
import { LOTTIE_DESIGN_CENTER, LOTTIE_ITEMS, getLottieItem } from '@core/library/lottieLibrary';
import { TRANSITION_ITEMS, getTransitionItem } from '@core/library/transitionLibrary';
import { buildTransitionPanels } from '@core/library/transitionFragment';
import { SFX_ITEMS } from '@core/library/sfxLibrary';
import { UI_COMPONENTS, buildUiComponent } from '@core/library/uiKitLibrary';
import { CURSOR_ITEMS, buildCursorItem } from '@core/library/cursorLibrary';
import { MOGRAPH_ITEMS, buildMographFragment, getMographItem, mographDuration } from '@core/library/mographLibrary';
import { TEMPLATES } from '@core/template/registry';
import type { PremiumCatalogItem } from '@core/library/premium/packFormat';
import { libraryMediaUrl } from '@core/library/premium/catalog';
import { fromStored, useComponentStore } from '@stores/componentStore';
import { usePremiumLibraryStore } from '@stores/premiumLibraryStore';

export type LibraryKind = 'template' | 'transition' | 'sfx' | 'lottie' | 'ui' | 'cursor' | 'mograph' | 'component';
export const LIBRARY_KINDS: readonly LibraryKind[] = ['template', 'transition', 'sfx', 'lottie', 'ui', 'cursor', 'mograph', 'component'];

export interface LibraryEntry {
  id: string;
  kind: LibraryKind;
  name: string;
  category: string;
  /** Seconds of motion; 0 = a still element; undefined = unknown. */
  durationSec?: number;
  /** Authored size, px. */
  size?: { width: number; height: number };
  tier: 'bundled' | 'yours' | 'free' | 'cloud';
  description: string;
  tags: readonly string[];
  premium?: PremiumCatalogItem;
}

/** What only the editor can do (layout code): injected, like McpEditorOps. */
export interface LibraryEditorOps {
  /** Apply a bundled template to the active composition — it REPLACES the composition's layers. */
  applyTemplate(id: string): Promise<{ ok: true; message: string } | { error: string }>;
  /** Insert a premium shelf item (plan check, download, the kind's own insert). */
  insertPremium(item: PremiumCatalogItem, o: { at?: { x: number; y: number }; layer?: string; atSec?: number }): Promise<{ ok: true; message: string } | { error: string }>;
  /** A bundled sound effect at `atSec` (add_sfx's path). */
  addSfx(id: string, atSec: number, inGroup: boolean): Promise<{ id: string } | { error: string }>;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// ── The catalog ────────────────────────────────────────────────────────

const PREMIUM_KIND: Record<PremiumCatalogItem['kind'], LibraryKind> = { template: 'template', lottie: 'lottie', sfx: 'sfx', transition: 'transition' };

/** The premium shelf, loaded on first use (the panel loads it the same way). */
async function premiumItems(): Promise<readonly PremiumCatalogItem[]> {
  const store = usePremiumLibraryStore.getState();
  if (store.status === 'idle') {
    try { await store.load(); } catch { /* offline: the bundled shelves still answer */ }
  }
  return usePremiumLibraryStore.getState().items;
}

export async function libraryEntries(): Promise<LibraryEntry[]> {
  const out: LibraryEntry[] = [];
  for (const t of TEMPLATES) {
    out.push({
      id: `template:${t.id}`, kind: 'template', name: t.name, category: t.aspect ?? 'scene',
      ...(t.settings ? { durationSec: t.settings.durationSeconds } : {}),
      size: { width: t.width, height: t.height }, tier: 'bundled',
      description: `${t.description ?? 'A whole designed scene'}. REPLACES the active composition's layers; editable fields: ${t.fields.map((f) => f.label).join(', ') || 'none'}.`,
      tags: [],
    });
  }
  for (const t of TRANSITION_ITEMS) {
    out.push({
      id: `transition:${t.id}`, kind: 'transition', name: t.layerName, category: t.cat, durationSec: t.duration, tier: 'bundled',
      description: `${t.solidOnly ? 'Comp-covering panel(s)' : 'Comp-covering panel(s) over a cut'} (${t.solidCount ?? 1}), ${t.a} → ${t.b}${t.motionBlur ? ', motion blur' : ''}${t.irisMask ? ', iris mask' : ''}. Centre it on the cut with atSec = cut − duration/2.`,
      tags: [],
    });
  }
  for (const s of SFX_ITEMS) out.push({ id: `sfx:${s.id}`, kind: 'sfx', name: s.name, category: s.cat, durationSec: s.duration, tier: 'bundled', description: `${s.cat} sound`, tags: [] });
  for (const l of LOTTIE_ITEMS) {
    out.push({ id: `lottie:${l.id}`, kind: 'lottie', name: l.name, category: l.cat, durationSec: l.frames / 30, size: { width: 200, height: 200 }, tier: 'bundled', description: `Animated vector (${l.frames} frames), editable shape layers`, tags: [] });
  }
  for (const u of UI_COMPONENTS) {
    out.push({ id: `ui:${u.id}`, kind: 'ui', name: u.name, category: u.cat, durationSec: 0, size: { width: u.width, height: u.height }, tier: 'bundled', description: 'Static UI element as an editable vector group (animate it yourself)', tags: [] });
  }
  for (const c of CURSOR_ITEMS) {
    out.push({ id: `cursor:${c.id}`, kind: 'cursor', name: c.name, category: c.cat, tier: 'bundled', description: c.animated ? 'Cursor with its own click / pulse choreography' : 'Static cursor (move it with set_keyframes)', tags: [], ...(c.animated ? {} : { durationSec: 0 }) });
  }
  for (const m of MOGRAPH_ITEMS) {
    out.push({ id: `mograph:${m.id}`, kind: 'mograph', name: m.name, category: m.cat, durationSec: m.loop ? (m.previewSeconds ?? 0) : mographDuration(m), tier: 'bundled', description: m.loop ? 'Motion graphic, loops forever (expressions)' : 'Motion graphic with its own choreography', tags: [] });
  }
  for (const c of useComponentStore.getState().components) {
    out.push({ id: `component:${c.id}`, kind: 'component', name: c.name, category: 'saved', tier: 'yours', description: 'A component the user saved from their own layers', tags: [] });
  }
  for (const p of await premiumItems()) {
    out.push({
      id: p.id, kind: PREMIUM_KIND[p.kind], name: p.name, category: p.category, durationSec: p.durationSec,
      ...(p.width && p.height ? { size: { width: p.width, height: p.height } } : {}),
      tier: p.tier === 'free' ? 'free' : 'cloud',
      description: [p.description, p.kind === 'template' ? (p.mode === 'element' ? 'drops into the active composition' : 'opens as a NEW composition') : '', p.fieldLabels?.length ? `fields: ${p.fieldLabels.join(', ')}` : ''].filter(Boolean).join('; '),
      tags: p.tags,
      premium: p,
    });
  }
  return out;
}

// ── search_library ─────────────────────────────────────────────────────

/** A word the user says → words the catalog uses. */
const SYNONYMS: Record<string, readonly string[]> = {
  button: ['buttons', 'ui'], loader: ['loaders', 'loading', 'spinner'], spinner: ['loaders', 'loading'],
  click: ['pointer', 'cursor', 'tap'], mouse: ['cursor', 'pointer'], swoosh: ['whoosh'], hit: ['impact'],
  title: ['titles', 'headline'], caption: ['lower-thirds', 'callouts'], chart: ['data'], graph: ['data'],
  toggle: ['toggles', 'switch'], notification: ['feedback', 'toast'], success: ['feedback', 'check'],
  intro: ['opener', 'title', 'titles'], logo: ['reveal', 'logo'],
};

function score(e: LibraryEntry, words: readonly string[]): number {
  const name = e.name.toLowerCase();
  const cat = `${e.kind} ${e.category} ${e.tags.join(' ')}`.toLowerCase();
  const rest = `${e.id} ${e.description}`.toLowerCase();
  let s = 0;
  for (const w of words) {
    const alts = [w, ...(SYNONYMS[w] ?? [])];
    let best = 0;
    for (const a of alts) {
      const weight = a === w ? 1 : 0.6;
      if (name.includes(a)) best = Math.max(best, 3 * weight);
      else if (cat.includes(a)) best = Math.max(best, 2 * weight);
      else if (rest.includes(a)) best = Math.max(best, 1 * weight);
    }
    s += best;
  }
  return s;
}

function line(e: LibraryEntry): string {
  const dur = e.durationSec === undefined ? '' : e.durationSec === 0 ? 'still' : `${e.durationSec.toFixed(2)}s`;
  const size = e.size ? `${e.size.width}×${e.size.height}` : '';
  const tier = e.tier === 'cloud' ? 'Premation Cloud' : e.tier === 'free' ? 'free (server)' : e.tier === 'yours' ? 'your component' : 'bundled';
  return `- ${e.id} — ${e.name} [${e.kind} / ${e.category}] ${[dur, size, tier].filter(Boolean).join(', ')} — ${e.description}`;
}

export async function searchLibraryText(rawArgs: unknown): Promise<string> {
  const a = obj(rawArgs);
  const kind = typeof a.kind === 'string' && (LIBRARY_KINDS as readonly string[]).includes(a.kind) ? (a.kind as LibraryKind) : null;
  const query = typeof a.query === 'string' ? a.query.toLowerCase() : '';
  const words = query.split(/[^a-z0-9-]+/).filter((w) => w.length > 1);
  const limit = Math.max(1, Math.min(80, Math.round(num(a.limit) ?? 25)));
  const all = (await libraryEntries()).filter((e) => !kind || e.kind === kind).filter((e) => a.includePremium !== false || !e.premium);
  const ranked = words.length
    ? all.map((e) => ({ e, s: score(e, words) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s).map((x) => x.e)
    : all;
  const counts = LIBRARY_KINDS.map((k) => `${k} ${all.filter((e) => e.kind === k).length}`).join(', ');
  if (ranked.length === 0) return `Nothing in the library matches "${query}"${kind ? ` among ${kind} items` : ''}. The library has: ${counts}. Try other words or a kind.`;
  return [
    `${ranked.length} match(es)${ranked.length > limit ? `, first ${limit}` : ''} (library: ${counts}).`,
    ...ranked.slice(0, limit).map(line),
    '',
    'See items with preview_library (frames of the real item), place one with insert_library_item. Sound FX: add_sfx works too.',
  ].join('\n');
}

// ── insert ─────────────────────────────────────────────────────────────

async function paste(session: AiEngineSession, comp: string, built: BuiltFragment | null): Promise<string[]> {
  if (!built) return [];
  const r = await session.apply([{ type: 'pasteLayers', comp, fragment: built.fragment } as Command]);
  return (r[0] as { layers?: string[] } | undefined)?.layers ?? [];
}

/** Top-level ids among `ids` (their parent was not pasted with them), with names. */
async function topsOf(session: AiEngineSession, ids: readonly string[]): Promise<{ id: string; name: string }[]> {
  if (ids.length === 0) return [];
  const info = await session.query({ type: 'getLayers', layers: [...ids] } as never) as { layers?: { id: string; name: string; parent: string | null }[] };
  const rows = info.layers ?? [];
  return rows.filter((l) => !l.parent || !ids.includes(l.parent)).map((l) => ({ id: l.id, name: l.name }));
}

export interface InsertOutcome {
  ok: boolean;
  text: string;
  /** Layer ids the insert made (all of them). */
  created: string[];
}

/**
 * Insert a bundled item or a component on the call's session. Returns null
 * for ids it does not build itself (templates, sound FX, premium items: the
 * caller routes those through `LibraryEditorOps`).
 */
async function insertOnSession(ctx: ToolContext, entry: LibraryEntry, o: { x?: number; y?: number; atSec: number }): Promise<string[] | null> {
  const comp = activeCompRootId() as string;
  const frame = insertFrame(comp);
  const x = o.x ?? frame.width / 2;
  const y = o.y ?? frame.height / 2;
  const raw = entry.id.slice(entry.id.indexOf(':') + 1);
  const b = new FragmentBuilder({ idPrefix: 'lib' });
  switch (entry.kind) {
    case 'lottie': {
      const item = getLottieItem(raw);
      if (!item) return [];
      const { built } = buildLottieFragment(planLottieImport(item.doc), {
        offset: { x: x - LOTTIE_DESIGN_CENTER, y: y - LOTTIE_DESIGN_CENTER },
        compFps: frame.fps,
        compDurationSeconds: frame.durationSeconds,
      });
      const ids = await paste(ctx.engine, comp, built);
      // A Lottie's keys start at 0: its bars move to the asked time, keys with them.
      if (ids.length && o.atSec > 0) {
        await ctx.engine.apply([{ type: 'setLayerTiming', items: ids.map((layer) => ({ layer, startTime: compTime(o.atSec) })) } as Command]);
      }
      return ids;
    }
    case 'ui':
      return buildUiComponent(b, frame, raw, x, y) ? paste(ctx.engine, comp, b.build()) : [];
    case 'cursor':
      return buildCursorItem(b, frame, raw, o.atSec, x, y) ? paste(ctx.engine, comp, b.build()) : [];
    case 'mograph':
      return getMographItem(raw) && buildMographFragment(b, frame, raw, o.atSec, x, y) ? paste(ctx.engine, comp, b.build()) : [];
    case 'transition':
      return getTransitionItem(raw) && buildTransitionPanels(b, frame, raw, o.atSec) ? paste(ctx.engine, comp, b.build()) : [];
    case 'component': {
      const def = useComponentStore.getState().components.find((c) => c.id === raw);
      if (!def?.fragment) return [];
      const r = await ctx.engine.apply([{ type: 'pasteLayers', comp, fragment: fromStored(def.fragment), index: 0 } as Command]);
      const ids = (r[0] as { layers?: string[] } | undefined)?.layers ?? [];
      const tops = await topsOf(ctx.engine, ids);
      if (tops.length > 1) {
        const g = await ctx.engine.apply([{ type: 'groupLayers', layers: tops.map((t) => t.id), name: def.name } as Command]);
        const group = (g[0] as { layer?: string } | undefined)?.layer;
        if (group) ids.unshift(group);
      }
      return ids;
    }
    default:
      return null;
  }
}

export async function insertLibraryItem(
  ctx: ToolContext,
  rawArgs: unknown,
  deps: { editor?: LibraryEditorOps; inGroup: boolean; moveLayer: (id: string, x: number, y: number) => Promise<void> },
): Promise<InsertOutcome> {
  const a = obj(rawArgs);
  const id = typeof a.id === 'string' ? a.id.trim() : '';
  const entry = await findLibraryEntry(id);
  if (!entry) return { ok: false, created: [], text: `No library item '${id}'. Find ids with search_library.` };
  const x = num(a.x), y = num(a.y);
  const atSec = Math.max(0, num(a.atSec) ?? 0);
  const fail = (text: string): InsertOutcome => ({ ok: false, created: [], text });

  if (entry.premium) {
    if (!deps.editor) return fail('This Premation build cannot insert library items from Claude.');
    if (deps.inGroup) return fail(`${entry.name} is a Premation Cloud item: it downloads and inserts as its own undo step, so it cannot join a begin_edit group. Call end_edit first, insert it, then continue.`);
    const layer = typeof a.layerId === 'string' ? resolveAlias(ctx, a.layerId) : undefined;
    const r = await deps.editor.insertPremium(entry.premium, { ...(x !== undefined && y !== undefined ? { at: { x, y } } : {}), ...(layer ? { layer } : {}), atSec });
    return 'error' in r ? fail(r.error) : { ok: true, created: [], text: `${r.message}. Read what it made with describe_scene.` };
  }
  if (entry.kind === 'template') {
    if (a.replaceComposition !== true) return fail(`${entry.name} is a whole scene: it REPLACES every layer of the active composition. Make a new composition for it (create_composition) and pass replaceComposition: true.`);
    if (!deps.editor) return fail('This Premation build cannot apply templates from Claude.');
    if (deps.inGroup) return fail('Applying a template is its own undo step and cannot join a begin_edit group. Call end_edit first.');
    const r = await deps.editor.applyTemplate(entry.id.slice('template:'.length));
    return 'error' in r ? fail(r.error) : { ok: true, created: [], text: `${r.message} Its fields are in Essential Graphics; read the layers with describe_scene.` };
  }
  if (entry.kind === 'sfx') {
    if (!deps.editor) return fail('This Premation build cannot add sound effects from Claude.');
    const r = await deps.editor.addSfx(entry.id.slice('sfx:'.length), atSec, deps.inGroup);
    return 'error' in r ? fail(r.error) : { ok: true, created: [r.id], text: `Added ${entry.name} at ${atSec}s as audio layer ${r.id}.` };
  }

  const ids = await insertOnSession(ctx, entry, { ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}), atSec });
  if (!ids || ids.length === 0) return fail(`Premation could not build ${entry.name}.`);
  const tops = await topsOf(ctx.engine, ids);
  const lead = tops[0];
  // Components keep where they were saved; move the root where the call asked.
  if (entry.kind === 'component' && lead && x !== undefined && y !== undefined) await deps.moveLayer(lead.id, x, y);
  if (lead && typeof a.as === 'string') bindAlias(ctx, a.as, lead.id);
  const dur = entry.durationSec ? ` Its motion runs ${atSec.toFixed(2)}–${(atSec + entry.durationSec).toFixed(2)}s.` : '';
  return {
    ok: true,
    created: ids,
    text: [
      `Inserted ${entry.name} (${entry.kind}): ${ids.length} layer(s); top level ${tops.map((t) => `'${t.name}' (${t.id})`).join(', ') || ids[0]}.${dur}`,
      'It is yours to fit: recolour (update_layer fill), retime (set_layer_timing / read_tracks + set_keyframes), re-ease (set_easing), then analyze_motion.',
    ].join('\n'),
  };
}

export async function findLibraryEntry(id: string): Promise<LibraryEntry | undefined> {
  return (await libraryEntries()).find((e) => e.id === id.trim());
}

/**
 * Where an insert runs: on the call's session (inside Claude's transaction),
 * or through the editor as its own undo step (downloads, plan checks, a
 * template replacing the composition, the sound FX import).
 */
export function insertRoute(e: LibraryEntry): 'session' | 'editor' {
  return e.premium || e.kind === 'template' || e.kind === 'sfx' ? 'editor' : 'session';
}

/** preview_library: build the item at the composition centre at 0 s, on a session the caller rolls back. */
export async function insertForPreview(ctx: ToolContext, e: LibraryEntry): Promise<string[] | null> {
  return insertRoute(e) === 'session' ? insertOnSession(ctx, e, { atSec: 0 }) : null;
}

/** Seconds of motion to show in a preview (0: one frame). */
export function previewSpan(entry: LibraryEntry): number {
  return entry.durationSec ?? 2;
}

/** A premium item's poster (the server renders it from the same payload the insert applies); null when it has none or it cannot be fetched. */
export async function premiumPoster(e: LibraryEntry): Promise<{ mimeType: string; data: string } | null> {
  const path = e.premium?.poster;
  const url = path ? libraryMediaUrl(path) : null;
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { mimeType: blob.type || 'image/jpeg', data: btoa(binary) };
  } catch {
    return null;
  }
}

/** One paragraph about an entry, for a preview's text. */
export function describeEntry(e: LibraryEntry): string {
  return line(e).slice(2);
}
