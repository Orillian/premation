/**
 * Premation's design machinery, opened to MCP clients (docs/MCP_PLAN.md §14).
 *
 * Until now an outside Claude got only the primitives — create_layer,
 * set_keyframes — and built from rectangles, text and its own guesses, which
 * is why its pieces read as stock. Everything that makes the in-app path look
 * designed already exists and is pure; this hands it over:
 *
 *   looks       8 look packs (palette, type pairing, pacing, motion signature)
 *               — `list_looks`, `apply_look`
 *   techniques  ~110 hand-authored motion techniques (entrances, kinetic type,
 *               camera, transitions, backgrounds, emphasis, exits, product UI)
 *               that animate layers Claude made — `list_techniques`,
 *               `apply_technique`
 *   caster      brief → sequenced beats → layout template + technique per beat
 *               → linted, repaired, best of N variants — `cast_piece`
 *   review      the scene verifier, keyframe-aware filmstrip + velocity graphs,
 *               and the critique a senior designer would run — `review_design`
 *   guide       the in-app assistant's design brief and craft rules —
 *               `get_design_guide`
 *
 * No React, no layout code: the host (mcpHost.ts) calls these with its tool
 * context and runs the emitted calls through the same registry.
 */

import type { ToolContext, ToolRegistry } from '@motion/ai-tools';
import { CRAFT_RULES, NEVER_RULES } from '@motion/ai-tools';
import { LOOK_PACKS, lookPack, resolvePack } from '@motion/design-system';
import {
  TECHNIQUES,
  briefFor,
  absolutizePositions,
  coerceParams,
  technique as editorialTechnique,
  type AnimatableRole,
  type TechniqueDef,
} from '@motion/technique-library';
import { PRODUCT_TECHNIQUES } from '@motion/product-motion';
import { runCaster, type CreativeBrief } from '@motion/caster';
import { buildCustomStyle, setRuntimeStyle, type EasingPersonality } from '../design';
import { formatFindings, verifyScene } from '../verify';
import { formatStructureWarnings, sceneStructureWarnings } from '../structureAdvisors';
import { renderCritiqueEvidence } from '../filmstrip';

// ── Session look ──────────────────────────────────────────────────────

/** The look a client chose; every cast and technique after it uses it. */
export interface SessionLook {
  id: string;
  accent?: string;
  mode?: 'dark' | 'light';
}

type Registry = Pick<ToolRegistry, 'execute'>;

const EASE_TO_PERSONALITY: Record<string, EasingPersonality> = {
  sharp: 'snappy',
  smooth: 'smooth',
  elastic: 'elastic',
  mechanical: 'snappy',
  organic: 'soft',
};

const HEX = /^#[0-9a-f]{6}$/i;

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// ── Looks ─────────────────────────────────────────────────────────────

export function listLooks(): string {
  return LOOK_PACKS.map((p) => [
    `${p.id} — ${p.displayName}: ${p.intent}`,
    `  mode ${p.mode}; accents ${p.accents.join(', ')}; type ${p.typePairingId}; shapes ${p.shapeVocabulary}; surface ${p.surfaceStyle}`,
    `  pacing: beat ${p.pacing.baseBeatMs}ms, motion ${p.motionSignature.easeFamily} (overshoot ${p.motionSignature.overshootBias}, blur ${p.motionSignature.blurBias})`,
    p.prefer?.length ? `  signature techniques: ${p.prefer.slice(0, 6).join(', ')}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
}

/**
 * Adopt a look for the rest of the session: the casts and techniques use it,
 * and the compose tools' runtime style follows its palette and easing.
 */
export function applyLook(args: unknown): { look: SessionLook; summary: string } | { error: string } {
  const a = obj(args);
  const id = typeof a.lookId === 'string' ? a.lookId : '';
  if (!LOOK_PACKS.some((p) => p.id === id)) {
    return { error: `Unknown look '${id}'. Looks: ${LOOK_PACKS.map((p) => p.id).join(', ')} (list_looks).` };
  }
  const look: SessionLook = {
    id,
    ...(typeof a.accent === 'string' && HEX.test(a.accent) ? { accent: a.accent } : {}),
    ...(a.mode === 'dark' || a.mode === 'light' ? { mode: a.mode } : {}),
  };
  const r = resolvePack(id, { ...(look.accent ? { accent: look.accent } : {}), ...(look.mode ? { mode: look.mode } : {}) });
  const pack = lookPack(id);
  setRuntimeStyle(buildCustomStyle({
    name: pack.displayName,
    brief: pack.intent,
    palette: { bg: r.palette.bg, bgAccent: r.palette.surface, card: r.palette.surface, fg: r.palette.fg, accent: r.palette.accent, muted: r.palette.muted },
    easing: EASE_TO_PERSONALITY[pack.motionSignature.easeFamily] ?? 'smooth',
  }));
  const p = r.palette;
  return {
    look,
    summary: [
      `Look "${pack.displayName}" is on for this session: casts, techniques and the compose tools follow it.`,
      `Palette — bg ${p.bg}, surface ${p.surface}, text ${p.fg}, muted ${p.muted}, accent ${p.accent} (small text: ${p.accentText}). Keep the accent to ~10% of the frame.`,
      `Type — ${r.typePairing.display.family ?? 'display'} for display, ${r.typePairing.body.family ?? 'body'} for body, scale ratio ${r.ratio}.`,
      `Motion — ${pack.motionSignature.easeFamily} easing, beat ≈ ${pack.pacing.baseBeatMs}ms.`,
    ].join('\n'),
  };
}

// ── Techniques ────────────────────────────────────────────────────────

const ALL_TECHNIQUES: readonly TechniqueDef[] = [...TECHNIQUES, ...PRODUCT_TECHNIQUES];

export function findTechnique(id: string): TechniqueDef | undefined {
  return editorialTechnique(id) ?? PRODUCT_TECHNIQUES.find((t) => t.id === id);
}

export function listTechniques(args: unknown, look: SessionLook | null): string {
  const a = obj(args);
  const category = typeof a.category === 'string' ? a.category : null;
  const q = typeof a.query === 'string' ? a.query.toLowerCase() : null;
  const pack = look ? lookPack(look.id) : null;
  let list = ALL_TECHNIQUES.filter((t) => (!category || t.category === category || t.id.startsWith(`${category}.`)));
  if (q) list = list.filter((t) => `${t.id} ${t.intent} ${t.tags.join(' ')}`.toLowerCase().includes(q));
  if (pack) {
    const forbid = new Set(pack.forbid ?? []);
    const prefer = new Set(pack.prefer ?? []);
    list = list.filter((t) => !forbid.has(t.id) && !(pack.forbidCategories ?? []).includes(t.category));
    list = [...list].sort((x, y) => Number(prefer.has(y.id)) - Number(prefer.has(x.id)));
  }
  if (list.length === 0) return 'No technique matches. Categories: entrance, kinetic_type, transition, camera, background, emphasis, exit, ui.';
  const head = `${list.length} techniques${category ? ` in ${category}` : ''}${pack ? ` that suit "${pack.displayName}" (its signature ones first)` : ''}. Apply with apply_technique: give the layer ids for the roles it animates.`;
  return [head, '', ...list.slice(0, 40).map((t) => briefFor(t)), list.length > 40 ? `…and ${list.length - 40} more — narrow with category or query.` : ''].join('\n');
}

export interface ExecReport {
  applied: number;
  total: number;
  rejected: string[];
}

export async function execCalls(calls: readonly { name: string; args: unknown }[], registry: Registry, ctx: ToolContext): Promise<ExecReport> {
  const rejected: string[] = [];
  let applied = 0;
  for (const c of calls) {
    if (ctx.signal.aborted) break;
    const r = await registry.execute(c.name, c.args, ctx);
    if (r.ok) applied++;
    else rejected.push(`${c.name}: ${r.content.slice(0, 200)}`);
  }
  return { applied, total: calls.length, rejected };
}

let helperSeq = 0;

/** Animate existing layers with a library technique. */
export async function applyTechnique(
  args: unknown,
  look: SessionLook | null,
  registry: Registry,
  ctx: ToolContext,
): Promise<{ ok: boolean; text: string }> {
  const a = obj(args);
  const id = typeof a.id === 'string' ? a.id : '';
  const t = findTechnique(id);
  if (!t) return { ok: false, text: `Unknown technique '${id}'. Find one with list_techniques.` };

  const targets: Partial<Record<AnimatableRole, string[]>> = {};
  const rawTargets = obj(a.targets);
  const unknownRoles: string[] = [];
  for (const [role, ids] of Object.entries(rawTargets)) {
    if (!(t.roles as readonly string[]).includes(role)) { unknownRoles.push(role); continue; }
    // Handles the client invented earlier ("hl") → the engine ids they were bound to.
    const list = (Array.isArray(ids) ? ids : [ids])
      .filter((x): x is string => typeof x === 'string' && x !== '')
      .map((x) => ctx.aliases?.get(x) ?? x);
    if (list.length) targets[role as AnimatableRole] = list;
  }
  if (unknownRoles.length) return { ok: false, text: `${t.id} animates ${t.roles.join(', ')}; it has no role ${unknownRoles.join(', ')}.` };
  const needsTargets = t.roles.filter((r) => r !== 'camera' && r !== 'background');
  if (needsTargets.length && Object.keys(targets).length === 0) {
    return { ok: false, text: `${t.id} needs layer ids for at least one of: ${needsTargets.join(', ')} — e.g. targets: { "${needsTargets[0]}": ["layer_3"] }.` };
  }
  for (const ids of Object.values(targets)) {
    for (const nodeId of ids ?? []) {
      if (!(await ctx.scene.has(nodeId))) return { ok: false, text: `No layer '${nodeId}'. Use ids from describe_scene.` };
    }
  }

  const comp = await ctx.comp.get();
  const startMs = Math.max(0, num(a.startSec, 0) * 1000);
  const wanted = num(a.durationSec, (t.minDurationMs + t.maxDurationMs) / 2000) * 1000;
  const durationMs = Math.max(t.minDurationMs, Math.min(t.maxDurationMs, wanted));
  const params = coerceParams(t.params, obj(a.params));
  const lookId = look?.id ?? LOOK_PACKS[0]!.id;
  const pack = resolvePack(lookId, { ...(look?.accent ? { accent: look.accent } : {}), ...(look?.mode ? { mode: look.mode } : {}) });
  // Techniques move x/y as offsets from rest: anchor them on each layer's base position.
  const rest = new Map<string, { x: number; y: number }>();
  for (const ids of Object.values(targets)) {
    for (const nodeId of ids ?? []) {
      const v = await ctx.scene.get(nodeId);
      if (v) rest.set(nodeId, { x: v.x, y: v.y });
    }
  }
  const emitted = t.emit({
    startMs,
    durationMs,
    frameMs: 1000 / (comp.fps || 30),
    width: comp.width,
    height: comp.height,
    pack,
    targets,
    idPrefix: `tq${++helperSeq}_`,
  }, params.value, Math.round(num(a.seed, 0)));
  const calls = absolutizePositions(emitted, (id) => rest.get(id));
  const r = await execCalls(calls, registry, ctx);
  const lines = [`${t.displayName} (${t.id}) on ${Object.entries(targets).map(([k, v]) => `${k}: ${v?.join(', ')}`).join('; ') || 'the composition'}, ${(startMs / 1000).toFixed(2)}–${((startMs + durationMs) / 1000).toFixed(2)}s: ${r.applied} of ${r.total} steps applied.`];
  if (durationMs !== wanted) lines.push(`Duration fitted to the technique's range (${(t.minDurationMs / 1000).toFixed(1)}–${(t.maxDurationMs / 1000).toFixed(1)}s).`);
  if (params.errors.length) lines.push(`Params fixed: ${params.errors.join('; ')}`);
  if (r.rejected.length) lines.push('Rejected:', ...r.rejected.slice(0, 8).map((x) => `- ${x}`));
  return { ok: r.applied > 0, text: lines.join('\n') };
}

// ── Cast a whole piece ────────────────────────────────────────────────

export interface CastArgs {
  brief: CreativeBrief;
  layoutPicks: { beatIndex: number; id: string; seed?: number }[];
  motionPicks: { beatIndex: number; id: string; params?: Record<string, unknown>; seed?: number }[];
  variants: number;
  menusOnly: boolean;
}

export function coerceCastArgs(args: unknown, look: SessionLook | null, compDurationSec: number): CastArgs | { error: string } {
  const a = obj(args);
  const beatsRaw = Array.isArray(a.beats) ? a.beats : [];
  const beats = beatsRaw.flatMap((b, i) => {
    const o = obj(b);
    const content = obj(o.content);
    const purpose = typeof o.purpose === 'string' && o.purpose.trim() ? o.purpose.trim() : `beat ${i + 1}`;
    if (Object.keys(content).length === 0) return [];
    // Generated imagery (`art`) spends credit; an MCP cast uses imported media (mediaAssetId) or none.
    const clean: Record<string, unknown> = {};
    for (const k of ['headline', 'subhead', 'support', 'overline', 'quote', 'attribution', 'cta', 'mediaAssetId']) {
      if (typeof content[k] === 'string' && (content[k] as string).trim()) clean[k] = (content[k] as string).trim();
    }
    if (Array.isArray(content.items)) clean.items = (content.items as unknown[]).map(obj).slice(0, 8);
    return [{ purpose, weight: Math.max(0.05, num(o.weight, 1)), content: clean }];
  });
  if (beats.length === 0) return { error: 'cast_piece needs `beats`: [{ purpose, content: { headline, subhead, … } }], one per moment of the piece.' };
  const lookId = typeof a.lookId === 'string' && LOOK_PACKS.some((p) => p.id === a.lookId) ? a.lookId : look?.id ?? LOOK_PACKS[0]!.id;
  const accent = typeof a.accent === 'string' && HEX.test(a.accent) ? a.accent : look?.accent;
  const mode = a.mode === 'dark' || a.mode === 'light' ? a.mode : look?.mode;
  const picks = (raw: unknown) => (Array.isArray(raw) ? raw : []).flatMap((p) => {
    const o = obj(p);
    return typeof o.id === 'string' && typeof o.beatIndex === 'number'
      ? [{ beatIndex: o.beatIndex, id: o.id, ...(typeof o.seed === 'number' ? { seed: o.seed } : {}), ...(o.params ? { params: obj(o.params) } : {}) }]
      : [];
  });
  return {
    brief: {
      lookPackId: lookId,
      ...(accent ? { accent } : {}),
      ...(mode ? { mode } : {}),
      energy: Math.max(0, Math.min(1, num(a.energy, 0.5))),
      tone: typeof a.tone === 'string' ? a.tone : '',
      totalDurationMs: Math.max(1000, num(a.durationSec, compDurationSec) * 1000),
      beats: beats as CreativeBrief['beats'],
    },
    layoutPicks: picks(a.layoutPicks),
    motionPicks: picks(a.motionPicks),
    variants: Math.max(1, Math.min(4, Math.round(num(a.variants, 3)))),
    menusOnly: a.menusOnly === true,
  };
}

/**
 * Brief → designed piece, through the caster. Claude is the caster's two
 * "model" hooks: it supplies the brief AND the layout/motion pick per beat
 * (from the menus `menusOnly` returns). An invalid pick is repaired to the
 * best-ranked candidate; a MISSING pick is not filled in — the call returns
 * the menus instead of building. Premation used to take the first entry of
 * each menu on Claude's behalf, which made every cast with N beats the same
 * N layouts and entrances whatever the brief said. The choice is Claude's.
 */
export async function castPiece(args: unknown, look: SessionLook | null, registry: Registry, ctx: ToolContext): Promise<{ ok: boolean; text: string; created: string[] }> {
  const comp = await ctx.comp.get();
  const c = coerceCastArgs(args, look, comp.durationSeconds);
  if ('error' in c) return { ok: false, text: c.error, created: [] };
  const menus: string[] = [];
  const open: string[] = [];
  const result = await runCaster({
    userPrompt: c.brief.tone,
    width: comp.width,
    height: comp.height,
    fps: comp.fps,
    variants: c.variants,
    hooks: {
      brief: async () => c.brief,
      cast: async (prompts, kind) => {
        for (const p of prompts) menus.push(`── ${kind.toUpperCase()} for beat ${p.beatIndex} ──\n${p.prompt}`);
        const given = kind === 'layout' ? c.layoutPicks : c.motionPicks;
        for (const p of prompts) {
          if (!given.some((g) => g.beatIndex === p.beatIndex)) open.push(`${kind} for beat ${p.beatIndex}`);
        }
        return given;
      },
    },
  });
  if (c.menusOnly || open.length) {
    return {
      ok: true,
      created: [],
      text: [
        c.menusOnly
          ? 'The menus for this brief (nothing was built). Pick a layout id and a technique id per beat, then call cast_piece again with layoutPicks / motionPicks.'
          : `Nothing was built: no pick for ${open.join(', ')}. Premation does not choose for you — read the menus below, pick a layout id and a technique id for EVERY beat (vary them; a camera or depth technique only where the beat can carry it), and call cast_piece again with layoutPicks and motionPicks. Or design the piece yourself with author_scene.`,
        '',
        ...menus,
      ].join('\n'),
    };
  }
  // The layers this cast creates, by their real ids: every handle the emitted
  // calls introduce (`id` on create_layer, import_svg, create_gradient, …) that
  // the alias map resolves to an id it did not hold before. The host keeps
  // them so a second cast_piece replaces the piece instead of stacking a copy.
  const before = new Set(ctx.aliases.values());
  const handles = new Set(result.calls.flatMap((c) => (typeof c.args.id === 'string' ? [c.args.id] : [])));
  const r = await execCalls(result.calls, registry, ctx);
  const created = [...handles].flatMap((h) => {
    const id = ctx.aliases.get(h);
    return id && !before.has(id) ? [id] : [];
  });
  const rep = result.report as unknown as Record<string, unknown>;
  const score = (k: string): string => (typeof rep[k] === 'number' ? (rep[k] as number).toFixed(2) : '—');
  const lines = [
    `Cast "${result.brief.tone || 'piece'}" in ${lookPack(result.brief.lookPackId).displayName}: ${result.brief.beats.length} beats, ${r.applied} of ${r.total} steps applied.`,
    `Scores (best of ${result.variants.length}): design ${score('designScore')}, craft ${score('craftScore')}, UI motion ${score('uiMotionScore')}.`,
  ];
  const problems = [
    ...result.problems.sequence.map((p) => `[sequence] ${p.message}`),
    ...result.problems.casting.map((p) => `[beat ${p.beatIndex}] ${p.message}${p.replacedWith ? ` → used '${p.replacedWith}'` : ''}`),
  ];
  if (problems.length) lines.push('Repaired:', ...problems.slice(0, 10).map((p) => `- ${p}`));
  if (r.rejected.length) lines.push('Rejected:', ...r.rejected.slice(0, 8).map((x) => `- ${x}`));
  lines.push('Next: review_design, then refine with apply_technique and the individual tools.');
  return { ok: r.applied > 0, text: lines.join('\n'), created };
}

// ── Review ────────────────────────────────────────────────────────────

const REVIEW_QUESTIONS = [
  'Review it the way a senior motion designer reviews a junior\'s work:',
  '- Could you name the stock template it resembles? If yes, it is not designed yet — change the layout, the type scale or the motion.',
  '- Hierarchy: one clear hero per beat, a type scale with real contrast (not everything 48px), tracking set for display sizes.',
  '- Composition: an intentional grid, negative space, not everything centred; nothing clipped or crowding the edges.',
  '- Colour: a deliberate palette, accent on ~10% of the frame, no pure #000/#fff, text legible on what is behind it.',
  '- Depth and finish: background layers (gradient, texture, grain, light), shadows that agree, not flat fills on flat fills.',
  '- Motion: in the filmstrip, spacing between cells is velocity — eases out of entrances, overlap and stagger that varies, no simultaneous pops, no linear moves, motion blur on fast moves.',
  '- Rhythm: beats that breathe, transitions that carry something across, a held final frame.',
  'Fix the biggest three problems (begin_edit / end_edit), then review again.',
].join('\n');

export async function reviewDesign(ctx: ToolContext): Promise<{ text: string; images: { mimeType: string; data: string }[] }> {
  const comp = await ctx.comp.get();
  const findings = formatFindings(await verifyScene(ctx));
  const structure = formatStructureWarnings(await sceneStructureWarnings(ctx));
  const evidence = await renderCritiqueEvidence(ctx, comp.durationSeconds);
  const text = [
    findings ? `Mechanical checks found problems:\n${findings}` : 'Mechanical checks: nothing off-screen, invisible, past the end, or popping in together.',
    structure ? `\nStructure — fix these FIRST, they make everything else slower and wrong:\n${structure}` : '',
    '',
    evidence.length ? `Attached: ${evidence.length === 2 ? 'a filmstrip sampled around the keyframes (cells labelled with time) and speed graphs of the hero properties' : 'a filmstrip sampled around the keyframes'}.` : 'No frames could be rendered for review.',
    '',
    REVIEW_QUESTIONS,
  ].join('\n');
  return { text, images: evidence.map((i) => ({ mimeType: i.mediaType, data: i.dataBase64 })) };
}

// ── The design guide ──────────────────────────────────────────────────

export function designGuide(topic: string | undefined): string {
  const sections: Record<string, string> = {
    process: [
      'PROCESS — how a designed piece gets made here:',
      '1. Design the piece yourself: read get_author_guide, write the concept, palette, type scale, grid and beats, then author_scene. Everything the engine can do is yours — real 3D (primitives, extrusion and bevels, PBR metal / glass materials, spot / sun / environment lights with soft shadows), cameras, effects with animated params, text animators, trim paths, repeaters, masks, mattes, blend modes, your own vectors. Nothing is chosen for you.',
      '2. Instruments, picked up when they serve YOUR idea, never as a starting point: apply_look (a palette/type/pacing pack — list_looks), apply_technique (a hand-authored move for layers you made — list_techniques), cast_piece (a template layout + technique per beat; you must pick both per beat from its menus, menusOnly: true first). A piece that is only a look pack and a template reads as a template.',
      '3. Refine with the individual tools: set_easing, text_animator, add_effect, add_camera_move, set_light, set_keyframes.',
      '4. review_design: fix the three biggest problems, review again. Twice is normal for good work.',
      '5. Sound: list_sfx / add_sfx on the moments that hit (whoosh into a transition, impact on a reveal, riser before a drop); set_audio_levels to sit them under music; import_media for the user\'s music.',
    ].join('\n'),
    craft: `CRAFT RULES\n${CRAFT_RULES}\n\nNEVER\n${NEVER_RULES}`,
    looks: `LOOKS\n${listLooks()}`,
    techniques: [
      'TECHNIQUE CATEGORIES (list_techniques with category to see them):',
      '- entrance: how a hero element arrives (rise_settle, mask_rise, blur_resolve, depth_arrive, split_flap, unfold…)',
      '- kinetic_type: type as motion (word_cascade, scramble_decode, slam_in, line_push_stack, marquee_band…)',
      '- camera: push_in_slow, crash_zoom, dolly_zoom, rack_focus, whip_pan, orbit_reveal, handheld_float…',
      '- transition: rule_wipe, glitch_slam, iris, streak_wipe…   - background: aurora_drift, grid_scan, soft_mesh, particle_drift, spotlight_sweep…',
      '- emphasis: count_up, highlight_sweep, chromatic_pulse…   - exit: scatter_out…   - ui: shared_element_expand, sheet_present, chart_draw_on… (product demos)',
      'A technique animates layers you give it by ROLE (headline, subhead, media, stat, cta, background, camera…). It never invents content.',
    ].join('\n'),
  };
  if (topic && sections[topic]) return sections[topic]!;
  return [sections.process, '', sections.craft, '', sections.techniques, '', 'Call get_design_guide with topic "looks" for the full look list.'].join('\n');
}
