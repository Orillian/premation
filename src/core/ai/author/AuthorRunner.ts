/**
 * Author mode's host adapter: the model writes the composition.
 *
 * `@motion/author` is pure — prompts, coercion, the compiler, the advisors.
 * This file makes the model calls over the existing gateway (`askJson`),
 * executes the compiled calls through the same registry and ToolContext the
 * direct loop uses, looks at the result, and revises the beats that fail.
 *
 * ```
 * design ─▶ beats (≤3 per call, resumed when cut off) ─▶ coerce ─▶ compile ─▶ advise
 *   ─▶ execute ─▶ look (verify + filmstrips) ─▶ critique ─▶ revise failing beats
 *   ─▶ wipe their roots + replay ─▶ look again …   (≤ MAX_AUTHOR_ROUNDS revisions)
 * ```
 *
 * ## Invariants
 *
 * 1. **One prompt = one undo entry.** Every call runs on the caller's
 *    ToolContext inside the transaction `runAgent` opened; a revision is a
 *    wipe and a replay inside the same transaction, not a second entry.
 * 2. **The editor never holds a provider key.** Every call is `askJson` →
 *    `streamTurn` → the gateway or the shell.
 * 3. **Failures are recorded, never swallowed.** A call the engine rejects is
 *    a path failure AND evidence for the critique; an unusable design is a
 *    failed run, so `runAgent` falls back to the caster.
 */

import type { AiImage, ProviderId, ToolContext, ToolRegistry } from '@motion/ai-tools';
import { LOOK_PACKS } from '@motion/design-system';
import {
  IdPool,
  TAIL_ROOT,
  adviseScript,
  authorSystemPrompt,
  beatRootId,
  beatsPrompt,
  coerceBeat,
  coerceConcepts,
  coerceCritique,
  coerceDesign,
  compileScript,
  conceptDistance,
  conceptsPrompt,
  critiquePrompt,
  critiqueSystemPrompt,
  designPrompt,
  fingerprintScript,
  rebuildCalls,
  revisePrompt,
  type AuthorBrief,
  type ConceptChoice,
  type ConceptOption,
  type CritiqueAxis,
  type PieceHistory,
  type Beat,
  type CompiledScript,
  type Critique,
  type DesignResult,
  type Repair,
  type SceneScript,
  type ToolCall,
} from '@motion/author';
import type { Direction as CasterDirection } from '@motion/caster';
import type { GatewayProviderId } from '@core/api/client';
import { recordAiPathFailure, type AgentEvents } from '../AgentLoop';
import { askJson, extractJsonArrayItems } from '../askJson';
import { renderCritiqueEvidence, renderFilmstripWindow } from '../filmstrip';
import { AUTHOR_STAGE_LABELS } from './stages';

export { AUTHOR_STAGE_LABELS };

/** Revise passes after the first build. Each costs a critique, N revise calls and a render. */
export const MAX_AUTHOR_ROUNDS = 2;
/** Beats written per model call. Three keeps a chunk well inside one response. */
export const BEAT_CHUNK = 3;
/** Re-asks for the beats a cut-off chunk did not finish. */
const MAX_RESUMES = 3;

const TOKENS = { concepts: 6_000, design: 8_000, beats: 16_000, critique: 4_000, revise: 12_000 } as const;

/** How many times "three more" may ask the model for fresh concepts. */
const MAX_CONCEPT_ROUNDS = 3;
/** A candidate this close to a recent piece (variety.ts conceptDistance) is a twin and is dropped. */
const TWIN_DISTANCE = 0.5;
/** How many concepts the gate is shown. */
const CONCEPTS_SHOWN = 3;

/**
 * What the runner needs from the editor besides the model: something to look
 * with. Injectable so the run can be tested without a renderer.
 */
export interface AuthorHost {
  /** Mechanical checks of the built scene (verify.ts), formatted, or null when clean. */
  verify(ctx: ToolContext): Promise<string | null>;
  /** Images for the critic, each with a one-line caption. */
  evidence(ctx: ToolContext, beats: readonly { name: string; startSec: number; endSec: number }[], durationSec: number): Promise<{ images: AiImage[]; notes: string[] }>;
}

export const defaultAuthorHost: AuthorHost = {
  async verify(ctx) {
    try {
      const { verifyScene, formatFindings, engineBounds } = await import('../verify');
      return formatFindings(await verifyScene(ctx, { bounds: engineBounds }));
    } catch (err) {
      recordAiPathFailure('author', `verify failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  },
  async evidence(ctx, beats, durationSec) {
    const images: AiImage[] = [];
    const notes: string[] = [];
    const whole = await renderCritiqueEvidence(ctx, durationSec);
    if (whole[0]) { images.push(whole[0]); notes.push('Filmstrip of the whole piece, cells labelled with their time; spacing between cells is velocity.'); }
    if (whole[1]) { images.push(whole[1]); notes.push('Speed of the hero properties over time.'); }
    for (const [i, b] of beats.entries()) {
      const strip = await renderFilmstripWindow(b.startSec, b.endSec, 8);
      if (strip) { images.push(strip); notes.push(`Beat ${i} "${b.name}" (${b.startSec}–${b.endSec}s), eight evenly spaced frames.`); }
    }
    return { images, notes };
  },
};

export interface AuthorRunOptions {
  provider: GatewayProviderId;
  dialect: ProviderId;
  model: string;
  prompt: string;
  signal: AbortSignal;
  events?: AgentEvents;
  /** Reference images: the design call only. */
  images?: readonly AiImage[];
  /** The composer's direction (the caster's shape, translated here). */
  direction?: CasterDirection;
  /** Imported assets to offer, one line each. */
  assets?: readonly string[];
  host?: Partial<AuthorHost>;
  /** The reference exemplar's pick (selectAuthorExemplar): Math.random unless a seeded run (the eval harness) passes its own. */
  exemplarRandom?: () => number;
  /** The last pieces made (variety.ts): fed to the design call and the advisors; this piece is recorded on success. */
  history?: PieceHistory;
  /** Override MAX_AUTHOR_ROUNDS (tests, the eval harness). */
  maxRounds?: number;
  /**
   * The concept stage's gate: shown the three candidates least like the
   * recent pieces, it answers with a pick, "more" (three fresh ones) or
   * "surprise" (the code's pick: the farthest from the ledger). Given, the
   * run opens with the concept stage; absent, the design call weighs its
   * own three as before (tests, the eval harness, scripts).
   */
  chooseConcept?: (concepts: ConceptOption[], round: number) => Promise<ConceptChoice>;
  /** Concept names not to offer again ("Another take" after one was built). */
  avoidConcepts?: readonly string[];
}

export interface AuthorRunResult {
  ok: boolean;
  toolCallCount: number;
  changes: string[];
  /** Repairs, rejected calls and advisor errors, for the user-facing summary. */
  problems: string[];
  script?: SceneScript;
  /** Revision passes actually run. */
  rounds: number;
  /** Beat indices revised, per round. */
  revised: number[][];
  /** The last critique's overall sentence. */
  critique?: string;
  /** The last critique's five scores (1–10), when the critic gave them. */
  scores?: Record<CritiqueAxis, number>;
  /** The concept the piece was built on, when a concept stage ran. */
  concept?: ConceptOption;
}

/**
 * The concept stage: five candidates from the model, the twins of recent
 * pieces dropped, the three farthest from the ledger shown to the gate. Null
 * when the model offered nothing usable (the design call then weighs its own).
 */
async function conceptStage(
  o: AuthorRunOptions,
  target: { provider: GatewayProviderId; dialect: ProviderId; model: string; signal: AbortSignal },
  brief: AuthorBrief,
  gate: NonNullable<AuthorRunOptions['chooseConcept']>,
  repairs: Repair[],
): Promise<ConceptOption | null> {
  const recent = o.history?.recent() ?? [];
  const exclude: string[] = [...(o.avoidConcepts ?? [])];
  for (let round = 0; round < MAX_CONCEPT_ROUNDS; round++) {
    if (o.signal.aborted) return null;
    o.events?.onActivity?.('Proposing concepts…');
    const res = await askJson(target, authorSystemPrompt(brief, o.exemplarRandom), conceptsPrompt(brief, exclude), { images: o.images, maxTokens: TOKENS.concepts, path: 'author' });
    const c = coerceConcepts(res.value);
    repairs.push(...c.repairs);
    if (!c.value.length) {
      recordAiPathFailure('author', `concept stage: nothing usable${res.truncated ? ' (cut off)' : ''}`);
      return null;
    }
    // Farthest from the ledger first; twins go unless they are all there is.
    const scored = c.value.map((concept) => ({ concept, d: conceptDistance(concept, recent) })).sort((a, b) => b.d - a.d);
    const fresh = scored.filter((s) => s.d >= TWIN_DISTANCE);
    const shown = (fresh.length >= CONCEPTS_SHOWN ? fresh : scored).slice(0, CONCEPTS_SHOWN).map((s) => s.concept);
    if (scored.length - fresh.length > 0) {
      repairs.push({ path: 'concepts', message: `${scored.length - fresh.length} candidate(s) were twins of a recent piece and were not offered` });
    }
    const choice = await gate(shown, round);
    if (choice.kind === 'pick') return shown[Math.max(0, Math.min(shown.length - 1, choice.index))] ?? null;
    if (choice.kind === 'surprise') return shown[0] ?? null;
    exclude.push(...shown.map((s) => s.name));
  }
  return null;
}

/** The composer's direction in the words the author brief takes. */
function briefDirection(d: CasterDirection | undefined): AuthorBrief['direction'] {
  if (!d) return undefined;
  const pack = d.lookPackId ? LOOK_PACKS.find((p) => p.id === d.lookPackId) : undefined;
  const energy = d.energy === undefined ? undefined : d.energy < 0.35 ? 'restrained, slow, a lot of air' : d.energy > 0.65 ? 'energetic, fast, punchy' : 'balanced';
  const mood = [pack ? `${pack.displayName} — ${pack.intent}` : '', energy ?? ''].filter(Boolean).join('; ');
  return {
    ...(mood ? { mood } : {}),
    ...(d.accent ? { accent: d.accent } : {}),
    ...(d.mode ? { mode: d.mode } : {}),
  };
}

/** Chunk beat indices into groups of `size`. */
function chunks(n: number, size: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < n; i += size) out.push(Array.from({ length: Math.min(size, n - i) }, (_, k) => i + k));
  return out;
}

/** The raw beat objects a beats-call answered with, by outline index. */
function beatsByIndex(items: readonly unknown[], asked: readonly number[]): Map<number, unknown> {
  const out = new Map<number, unknown>();
  items.forEach((item, k) => {
    if (!item || typeof item !== 'object') return;
    const idx = (item as { index?: unknown }).index;
    // A model that drops `index` still answers in the order it was asked.
    const i = typeof idx === 'number' && asked.includes(idx) ? idx : asked[k];
    if (i !== undefined && !out.has(i)) out.set(i, item);
  });
  return out;
}

export async function runAuthorPipeline(
  o: AuthorRunOptions,
  ctx: ToolContext,
  registry: ToolRegistry,
  writeNames: Set<string>,
  tally?: (toolName: string) => void,
): Promise<AuthorRunResult> {
  const host: AuthorHost = { ...defaultAuthorHost, ...o.host };
  const target = { provider: o.provider, dialect: o.dialect, model: o.model, signal: o.signal };
  const comp = await ctx.comp.get();
  const coerceCtx = { durationSec: comp.durationSeconds, width: comp.width, height: comp.height };
  const brief: AuthorBrief = {
    prompt: o.prompt,
    width: comp.width,
    height: comp.height,
    fps: comp.fps,
    durationSec: comp.durationSeconds,
    ...(briefDirection(o.direction) ? { direction: briefDirection(o.direction) } : {}),
    ...(o.assets?.length ? { assets: o.assets } : {}),
    ...(o.images?.length ? { imageCount: o.images.length } : {}),
    ...(o.history?.recent().length ? { recent: o.history.recent() } : {}),
  };
  const result: AuthorRunResult = { ok: false, toolCallCount: 0, changes: [], problems: [], rounds: 0, revised: [] };
  const repairs: Repair[] = [];

  // ── 0. Concepts (with a gate: the chat panel) ─────────────────────────
  if (o.chooseConcept) {
    const concept = await conceptStage(o, target, brief, o.chooseConcept, repairs);
    if (o.signal.aborted) return result;
    if (concept) {
      brief.concept = concept;
      result.concept = concept;
    }
  }
  // The advisors' view of the brief: DARK_DEFAULT reads its cues, SAME_AS_LAST the recent pieces.
  const adviseOpts = {
    width: comp.width, height: comp.height, fps: comp.fps, brief: o.prompt,
    ...(brief.direction?.mode ? { mode: brief.direction.mode } : {}),
    ...(brief.recent ? { recent: brief.recent } : {}),
  };
  const system = authorSystemPrompt(brief, o.exemplarRandom);

  // ── 1. Design ─────────────────────────────────────────────────────────
  o.events?.onActivity?.('Designing the piece…');
  const designRes = await askJson(target, system, designPrompt(brief), { images: o.images, maxTokens: TOKENS.design, path: 'author' });
  const design = coerceDesign(designRes.value, coerceCtx);
  repairs.push(...design.repairs);
  if (!design.value.beats.length) {
    recordAiPathFailure('author', `design unusable${designRes.truncated ? ' (cut off)' : ''}: ${design.repairs.map((r) => r.message).slice(0, 3).join('; ')}`);
    result.problems.push('The design came back without usable beats.');
    return result;
  }
  const d: DesignResult = design.value;

  // ── 2. Beats, three at a time, resumed when a response is cut off ────
  o.events?.onActivity?.('Writing the beats…');
  const reserved = [...d.beats.map((_, i) => beatRootId(i)), TAIL_ROOT, ...d.globals.map((g) => g.id)];
  const pool = new IdPool(reserved);
  const beats: Beat[] = d.beats.map((b) => ({ ...b, layers: [] }));
  const written: Beat[] = [];
  const queue = chunks(d.beats.length, BEAT_CHUNK);
  let resumesLeft = MAX_RESUMES * queue.length;
  while (queue.length) {
    if (o.signal.aborted) return result;
    const pending = queue.shift()!;
    const res = await askJson(target, system, beatsPrompt(brief, d, pending, written), { maxTokens: TOKENS.beats, path: 'author' });
    const answered = res.value && typeof res.value === 'object' ? (res.value as { beats?: unknown }).beats : undefined;
    const items = Array.isArray(answered) ? answered : res.truncated ? extractJsonArrayItems(res.text, 'beats') : [];
    const got = beatsByIndex(items, pending);
    for (const [i, raw] of got) {
      const c = coerceBeat(raw, d.beats[i]!, d, pool, coerceCtx, i);
      repairs.push(...c.repairs);
      beats[i] = c.value;
      written.push(c.value);
    }
    const missing = pending.filter((i) => !got.has(i));
    if (!missing.length) continue;
    // Only a cut-off answer earns a resume: a complete answer that skipped a
    // beat would skip it again.
    if (!res.truncated) {
      recordAiPathFailure('author', `beats ${missing.join(', ')} missing from the answer`);
      continue;
    }
    if (resumesLeft-- <= 0) {
      recordAiPathFailure('author', `beats ${missing.join(', ')} still cut off after every resume — left empty`);
      continue;
    }
    // Cut off with nothing complete: the chunk is too big for one answer, so
    // its beats go one at a time. Otherwise ask again for just the rest.
    if (got.size === 0 && missing.length > 1) queue.unshift(...missing.map((i) => [i]));
    else queue.unshift(missing);
  }
  const script: SceneScript = { ...d, beats };
  if (!beats.some((b) => b.layers.length)) {
    recordAiPathFailure('author', 'no beat came back with usable layers');
    result.problems.push('No beat came back with usable layers.');
    return result;
  }

  // ── 3. Compile, advise, execute ───────────────────────────────────────
  o.events?.onActivity?.('Building the scene…');
  let compiled = compileScript(script);
  let advice = adviseScript(script, compiled, adviseOpts);
  const rejected: Repair[] = [];
  let n = 0;
  const execute = async (calls: readonly ToolCall[], beatOf: (i: number) => number): Promise<void> => {
    for (const [i, call] of calls.entries()) {
      if (o.signal.aborted) return;
      const id = `author_${n++}`;
      o.events?.onToolStart?.({ id, name: call.name, args: call.args });
      const res = await registry.execute(call.name, call.args, ctx);
      o.events?.onToolEnd?.({ id, name: call.name, args: call.args }, res.ok, res.content);
      tally?.(call.name);
      if (res.ok) {
        result.toolCallCount++;
        if (writeNames.has(call.name)) result.changes.push(res.content);
      } else {
        const b = beatOf(i);
        rejected.push({ path: b >= 0 ? `beats[${b}]` : 'globals', message: `${call.name} rejected: ${res.content.slice(0, 240)}` });
        recordAiPathFailure('author', `${call.name} rejected: ${res.content.slice(0, 160)}`);
      }
    }
  };
  const beatOfIndexIn = (c: CompiledScript) => (i: number) => c.byBeat.find((r) => i >= r.start && i < r.end)?.beatIndex ?? -1;
  await execute(compiled.calls, beatOfIndexIn(compiled));
  if (result.toolCallCount === 0) {
    result.problems.push('Every compiled call was rejected.');
    return result;
  }
  result.ok = true;
  result.script = script;

  // ── 4. Look, critique, revise ─────────────────────────────────────────
  const maxRounds = o.maxRounds ?? MAX_AUTHOR_ROUNDS;
  let critique: Critique | undefined;
  for (let round = 0; round <= maxRounds && !o.signal.aborted; round++) {
    o.events?.onActivity?.('Reviewing the frames…');
    const mechanical = await host.verify(ctx);
    let evidence: { images: AiImage[]; notes: string[] } = { images: [], notes: [] };
    try {
      evidence = await host.evidence(ctx, script.beats, comp.durationSeconds);
    } catch (err) {
      recordAiPathFailure('author', `evidence failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // A critique with no evidence is a critique of nothing.
    if (!evidence.images.length && !mechanical) {
      recordAiPathFailure('author', 'critique skipped — no frames rendered and no mechanical findings');
      break;
    }
    const cRes = await askJson(
      target,
      critiqueSystemPrompt(),
      critiquePrompt({ brief, design: d, evidenceNotes: evidence.notes, mechanical, advice: advice.findings, repairs: [...repairs, ...rejected] }),
      { images: evidence.images, maxTokens: TOKENS.critique, temperature: 0, path: 'author' },
    );
    critique = coerceCritique(cRes.value, script.beats.length);
    const failing = critique.beats.filter((b) => b.verdict === 'revise').map((b) => b.index);
    // The last pass only looks: there is no budget left to act on it.
    if (!failing.length || round === maxRounds) break;

    o.events?.onActivity?.('Revising beats…');
    const revisedNow: number[] = [];
    for (const i of failing) {
      if (o.signal.aborted) break;
      const others = script.beats.flatMap((b, j) => (j === i ? [] : b.layers.map((l) => l.id)));
      const findings = critique.beats.find((b) => b.index === i)!.findings;
      const res = await askJson(
        target,
        system,
        revisePrompt(brief, d, i, script.beats[i]!, findings, advice.byBeat.get(i) ?? [], others),
        { maxTokens: TOKENS.revise, path: 'author' },
      );
      const c = coerceBeat(res.value, script.beats[i]!, d, new IdPool([...reserved, ...others]), coerceCtx, i);
      if (!c.value.layers.length) {
        recordAiPathFailure('author', `revision of beat ${i} came back empty${res.truncated ? ' (cut off)' : ''} — kept the built beat`);
        continue;
      }
      repairs.push(...c.repairs);
      script.beats[i] = { ...c.value, startSec: script.beats[i]!.startSec, endSec: script.beats[i]!.endSec };
      revisedNow.push(i);
    }
    if (!revisedNow.length) break;
    const next = compileScript(script);
    const rebuild = rebuildCalls(next, revisedNow);
    rejected.length = 0;
    // The rebuild's first call wipes; the rest are the revised beats' ranges then the tail.
    await execute(rebuild, () => -1);
    compiled = next;
    advice = adviseScript(script, compiled, adviseOpts);
    result.rounds++;
    result.revised.push(revisedNow);
  }

  if (critique?.overall) result.critique = critique.overall;
  if (critique?.scores) result.scores = critique.scores;
  // What this piece was, for the next run (never fatal: the piece is built).
  // The concept's type pairing and motion language ride along, so the next
  // concept stage can keep its distance from them too.
  try {
    const fp = fingerprintScript(script);
    const c = result.concept;
    o.history?.record(c ? { ...fp, concept: c.name, ...(c.type ? { type: c.type } : {}), ...(c.motion ? { motion: c.motion } : {}) } : fp);
  } catch (err) {
    recordAiPathFailure('author', `piece history: ${err instanceof Error ? err.message : String(err)}`);
  }
  result.problems.push(
    ...repairs.slice(0, 12).map((r) => `[repair ${r.path}] ${r.message}`),
    ...rejected.map((r) => `[rejected ${r.path}] ${r.message}`),
    ...advice.findings.filter((f) => f.severity === 'error').slice(0, 8).map((f) => `[${f.source}/${f.rule}] ${f.message}`),
  );
  return result;
}

/** Internals for tests. */
export const __testables = { briefDirection, chunks, beatsByIndex };
