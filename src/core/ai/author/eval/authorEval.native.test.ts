/**
 * The author-mode eval harness: fifteen prompts × {author, library}, on the
 * app's engine with the full renderer, judged by two vision judges.
 *
 * Skipped unless `AI_EVAL=1` — it costs model calls (when recording) and
 * minutes of rendering, and it is a measurement, not a test that gates a
 * merge. Environment:
 *
 *   AI_EVAL=1               run it
 *   AI_EVAL_RECORD=1        call the Anthropic API for real (ANTHROPIC_API_KEY) and
 *                           write fixtures; otherwise replay recorded fixtures
 *   AI_EVAL_STRICT=1        replay fails when a request no longer matches its recording
 *   AI_EVAL_CASES=a,b       only these case ids
 *   AI_EVAL_MODES=author    only these modes (default author,library)
 *   AI_EVAL_MODEL           authoring model (default claude-opus-5)
 *   AI_EVAL_JUDGE_MODEL     judge model (default: the authoring model)
 *   AI_EVAL_OUT             artifact folder (default .ai-eval/<timestamp>)
 *
 * After the cases, one DIVERSITY case per mode fingerprints the pieces of the
 * ten DIVERSITY_CASES (@motion/author variety.ts: value, accent hue, medium,
 * camera, light) and FAILS when they read as one template — most pieces one
 * look, mostly dark, too few media or hues, no 3D (`diversityOf`). It writes
 * `diversity.<mode>.json`; it runs only when all ten cases ran in this mode.
 *
 * Per run it writes `<case>.<mode>.json` (what was built, what failed, the
 * judges' verdicts) and `<case>.<mode>.png` (the contact sheet). Compare two
 * folders — or both modes in one — with `node scripts/ai-eval/compare.mjs`.
 *
 * Each pipeline runs the way `runAgent` runs it (one transaction, the shared
 * registry), without the direct loop's polish pass, so the comparison is
 * between the two generators themselves.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { mutates, type AiImage } from '@motion/ai-tools';
import type { Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { sec, settleEdits, setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { getAiPathFailures, getAiRegistry } from '../../AgentLoop';
import { beginAiTransaction } from '../../aiTransaction';
import { setTransportOverride } from '../../aiTransport';
import { runCasterPipeline } from '../../CasterRunner';
import { createToolContext } from '../../toolContext';
import { runAuthorPipeline, type AuthorHost } from '../AuthorRunner';
import { diversityOf, fingerprintOf, fingerprintScript, type PieceFingerprint } from '@motion/author';
import { liveDepthScene } from '../../mcp/designTools';
import { contactSheet, sampleTimes, type SheetFrame } from './contactSheet';
import { DIVERSITY_CASES, EVAL_CASES, type EvalCase } from './evalPrompts';
import { runJudge, type JudgeVerdict } from './judges';
import { anthropicSend, emptyFixture, recordingTransport, replayTransport, type Fixture } from './recordReplay';

const ENABLED = process.env.AI_EVAL === '1';
const RECORD = process.env.AI_EVAL_RECORD === '1';
const STRICT = process.env.AI_EVAL_STRICT === '1';
const MODEL = process.env.AI_EVAL_MODEL ?? 'claude-opus-5';
const JUDGE_MODEL = process.env.AI_EVAL_JUDGE_MODEL ?? MODEL;
const ONLY = process.env.AI_EVAL_CASES?.split(',').map((s) => s.trim()).filter(Boolean);
const MODES = (process.env.AI_EVAL_MODES?.split(',').map((s) => s.trim()) ?? ['author', 'library']).filter((m): m is 'author' | 'library' => m === 'author' || m === 'library');
const REPO = path.resolve(__dirname, '../../../../..');
const OUT = process.env.AI_EVAL_OUT ?? path.join(REPO, '.ai-eval', new Date().toISOString().replace(/[:.]/g, '-'));
const FIXTURES = path.join(__dirname, 'fixtures');

const cases = EVAL_CASES.filter((c) => !ONLY || ONLY.includes(c.id));
const suite = ENABLED ? describe : describe.skip;
if (!ENABLED) console.log('[ai eval] skipped — set AI_EVAL=1 to run it');

/** Rendered frames of the active comp, as PNG bytes. */
async function frames(h: Harness, times: readonly number[]): Promise<SheetFrame[]> {
  const comp = activeCompRootId() as string;
  const out: SheetFrame[] = [];
  for (const t of times) {
    const th = await h.query({ type: 'getThumbnail', item: comp, time: sec(t), maxSize: 640 });
    if (th.format === 'png' && th.data.length) out.push({ png: th.data, t });
  }
  return out;
}

const asImage = (png: Uint8Array): AiImage => ({ mediaType: 'image/png', dataBase64: Buffer.from(png).toString('base64') });

/** The author run's eyes in Node: engine thumbnails tiled with pngjs instead of a canvas. */
function evalHost(h: Harness, c: EvalCase): Partial<AuthorHost> {
  return {
    async evidence(_ctx, beats, durationSec) {
      const images: AiImage[] = [];
      const notes: string[] = [];
      const whole = await frames(h, sampleTimes(durationSec, c.fps, 12));
      if (whole.length >= 3) {
        images.push(asImage(contactSheet(whole, durationSec)));
        notes.push('Contact sheet of the whole piece, twelve evenly spaced frames in reading order; the bar under each is its time.');
      }
      for (const [i, b] of beats.entries()) {
        const span = b.endSec - b.startSec;
        const ts = Array.from({ length: 8 }, (_, k) => b.startSec + ((span - 1 / c.fps) * k) / 7);
        const fs8 = await frames(h, ts);
        if (fs8.length >= 3) {
          images.push(asImage(contactSheet(fs8, durationSec)));
          notes.push(`Beat ${i} "${b.name}" (${b.startSec}–${b.endSec}s), eight evenly spaced frames.`);
        }
      }
      return { images, notes };
    },
  };
}

function loadFixture(file: string): Fixture | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Fixture;
  } catch {
    return null;
  }
}

suite('AI eval: author vs library', () => {
  jest.setTimeout(45 * 60_000);
  let h: Harness;
  /** mode → case id → what the piece was (for the DIVERSITY case). */
  const looks = new Map<string, Map<string, PieceFingerprint>>();

  beforeAll(() => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(FIXTURES, { recursive: true });
    if (RECORD && !process.env.ANTHROPIC_API_KEY) throw new Error('AI_EVAL_RECORD=1 needs ANTHROPIC_API_KEY');
  });
  afterEach(async () => {
    setTransportOverride(null);
    await h?.dispose();
  });

  for (const c of cases) {
    for (const mode of MODES) {
      it(`${c.id} · ${mode}`, async () => {
        h = await setupAppEngine({ gpu: true });
        const comp = activeCompRootId() as string;
        await h.run({
          type: 'setCompositionSettings',
          comp,
          patch: { width: c.width, height: c.height, frameRate: { num: c.fps, den: 1 }, duration: sec(c.durationSec) },
        } as Command);
        await settleEdits();

        // ── transport ──
        const fixtureFile = path.join(FIXTURES, `${c.id}.${mode}.json`);
        let fixture: Fixture;
        let mismatches: string[] = [];
        if (RECORD) {
          fixture = emptyFixture('anthropic', MODEL);
          setTransportOverride(recordingTransport(fixture, anthropicSend(process.env.ANTHROPIC_API_KEY!)));
        } else {
          const f = loadFixture(fixtureFile);
          if (!f) throw new Error(`no fixture ${path.relative(REPO, fixtureFile)} — record it with AI_EVAL_RECORD=1`);
          fixture = f;
          const r = replayTransport(f, STRICT);
          mismatches = r.mismatches;
          setTransportOverride(r.transport);
        }

        // ── run the pipeline, as runAgent runs it ──
        const failuresBefore = getAiPathFailures().length;
        const started = Date.now();
        const signal = new AbortController().signal;
        const tx = await beginAiTransaction(`AI eval: ${c.id}`);
        const ctx = createToolContext(signal, undefined, tx.session);
        const reg = getAiRegistry();
        const writeNames = new Set(reg.list().filter((t) => mutates(t.kind)).map((t) => t.name));
        const target = { provider: 'anthropic' as const, dialect: 'anthropic' as const, model: MODEL, signal };
        const run: Record<string, unknown> = {};
        if (mode === 'author') {
          const r = await runAuthorPipeline({ ...target, prompt: c.prompt, host: evalHost(h, c) }, ctx, reg, writeNames);
          Object.assign(run, { ok: r.ok, toolCalls: r.toolCallCount, rounds: r.rounds, revised: r.revised, critique: r.critique, problems: r.problems, beats: r.script?.beats.length ?? 0, script: r.script });
        } else {
          const r = await runCasterPipeline({ ...target, prompt: c.prompt }, ctx, reg, writeNames);
          Object.assign(run, { ok: r.ok, toolCalls: r.toolCallCount, problems: r.problems, report: { lookPackId: r.report.lookPackId, techniques: r.report.techniques, templates: r.report.templates, designScore: r.report.designScore, craftScore: r.report.craftScore } });
        }
        // What the piece is: the authored script when there is one, else the built scene.
        const script = (run.script ?? null) as Parameters<typeof fingerprintScript>[0] | null;
        const fingerprint: PieceFingerprint = { ...(script ? fingerprintScript(script) : fingerprintOf(await liveDepthScene(ctx))), title: c.id };
        if (!looks.has(mode)) looks.set(mode, new Map());
        looks.get(mode)!.set(c.id, fingerprint);
        await tx.commit();
        await settleEdits();
        const wallMs = Date.now() - started;

        // ── look and judge ──
        const shots = await frames(h, sampleTimes(c.durationSec, c.fps, 12));
        const sheetFile = path.join(OUT, `${c.id}.${mode}.png`);
        let judges: JudgeVerdict[] = [];
        if (shots.length >= 3) {
          const sheet = contactSheet(shots, c.durationSec);
          fs.writeFileSync(sheetFile, sheet);
          const jt = { ...target, model: JUDGE_MODEL };
          judges = [await runJudge(jt, 'craft', c.prompt, asImage(sheet)), await runJudge(jt, 'fit', c.prompt, asImage(sheet))];
        }

        if (RECORD) fs.writeFileSync(fixtureFile, JSON.stringify(fixture, null, 1));
        const artifact = {
          case: c.id,
          mode,
          model: MODEL,
          judgeModel: JUDGE_MODEL,
          prompt: c.prompt,
          frame: { width: c.width, height: c.height, fps: c.fps, durationSec: c.durationSec },
          wallMs,
          recorded: RECORD,
          replayMismatches: mismatches,
          pathFailures: getAiPathFailures().slice(failuresBefore).map((f) => `${f.path}: ${f.message}`),
          frames: shots.length,
          sheet: shots.length >= 3 ? path.basename(sheetFile) : null,
          judges,
          fingerprint,
          ...run,
        };
        fs.writeFileSync(path.join(OUT, `${c.id}.${mode}.json`), JSON.stringify(artifact, null, 1));

        // A measurement, not a gate: it fails only when the run produced nothing to measure.
        expect(run.ok).toBe(true);
        expect(shots.length).toBeGreaterThanOrEqual(3);
      });
    }
  }

  // Across the briefs: does the generator vary with the brief, or answer every one with one look?
  for (const mode of MODES) {
    it(`diversity · ${mode}`, () => {
      const got = looks.get(mode) ?? new Map<string, PieceFingerprint>();
      const missing = DIVERSITY_CASES.filter((id) => !got.has(id));
      if (missing.length) {
        console.log(`[ai eval] diversity · ${mode}: not judged — ${missing.length} of the ten cases did not run (${missing.join(', ')})`);
        return;
      }
      const report = diversityOf(DIVERSITY_CASES.map((id) => got.get(id)!));
      fs.writeFileSync(path.join(OUT, `diversity.${mode}.json`), JSON.stringify({ mode, cases: DIVERSITY_CASES, pieces: DIVERSITY_CASES.map((id) => got.get(id)), report }, null, 1));
      console.log(`[ai eval] diversity · ${mode}: ${report.pass ? 'pass' : `FAIL — ${report.reasons.join('; ')}`}`);
      expect(report.reasons).toEqual([]);
    });
  }
});
