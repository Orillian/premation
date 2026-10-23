/**
 * The MCP's motion eyes: `analyze_motion` (the numbers) and the data behind
 * `render_motion_sheet` (frame-accurate strip, onion skin, trails).
 *
 * The analysis is motionAnalysis.ts over motionSampling.ts; this file only
 * reads the client's arguments and shapes what goes back.
 */

import { resolveAlias, type ToolContext } from '@motion/ai-tools';
import { analyzeMotion, formatMotionReport, unitName, type MotionReport } from '../motionAnalysis';
import { sampleMotion, type SampledMotion } from '../motionSampling';

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** A trail: one unit's screen centre at every sample of the window. */
export interface MotionTrail {
  name: string;
  points: readonly ({ x: number; y: number } | null)[];
}

interface Window {
  startSec: number;
  endSec: number;
  nodeIds?: string[];
}

async function windowOf(ctx: ToolContext, args: Record<string, unknown>, maxSpan: number): Promise<Window | { error: string }> {
  const comp = await ctx.comp.get();
  const startSec = Math.max(0, Math.min(comp.durationSeconds, num(args.startSec, 0)));
  const endSec = Math.max(0, Math.min(comp.durationSeconds, num(args.endSec, Math.min(comp.durationSeconds, startSec + maxSpan))));
  if (!(endSec > startSec)) return { error: 'endSec must be after startSec (composition seconds, inside the composition).' };
  const ids = Array.isArray(args.nodeIds) ? args.nodeIds.filter((x): x is string => typeof x === 'string').map((id) => resolveAlias(ctx, id)) : undefined;
  if (ids) {
    for (const id of ids) if (!(await ctx.scene.has(id))) return { error: `No layer '${id}' in the active composition.` };
  }
  return { startSec, endSec, ...(ids && ids.length ? { nodeIds: ids } : {}) };
}

/** analyze_motion. */
export async function analyzeMotionText(ctx: ToolContext, rawArgs: unknown): Promise<{ text: string; ok: boolean }> {
  const args = obj(rawArgs);
  const w = await windowOf(ctx, args, Infinity);
  if ('error' in w) return { text: w.error, ok: false };
  const sampled = await sampleMotion(ctx, { ...w, maxSamples: 1200 });
  const report = analyzeMotion(sampled);
  const notes = sampled.skippedLayers > 0 ? `\n(${sampled.skippedLayers} still layer(s) beyond the ${sampled.layers.length}-layer cap were not sampled; pass nodeIds to choose.)` : '';
  return { text: formatMotionReport(report, { maxMoves: Math.max(5, Math.min(200, Math.round(num(args.maxMoves, 60)))) }) + notes, ok: true };
}

/** The busiest units of a window, as trails (at most `max`). */
export function trailsOf(sampled: SampledMotion, report: MotionReport, max = 8): MotionTrail[] {
  const travel = new Map<string, number>();
  const label = new Map<string, string>();
  for (const m of report.moves) {
    if (m.channel !== 'position') continue;
    const lead = m.layerIds[0]!;
    travel.set(lead, (travel.get(lead) ?? 0) + Math.abs(m.amount));
    label.set(lead, unitName(m));
  }
  const top = [...travel.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([id]) => id);
  return top.map((id) => {
    const layer = sampled.layers.find((l) => l.id === id)!;
    return { name: label.get(id) ?? layer.name, points: layer.frames.map((f) => (f ? { x: f.cx, y: f.cy } : null)) };
  });
}

/** What render_motion_sheet draws, and its text. Windows are capped at 4 s: it is a close-up. */
export async function motionSheetData(ctx: ToolContext, rawArgs: unknown): Promise<
  | { error: string }
  | { startSec: number; endSec: number; times: number[]; fps: number; compWidth: number; compHeight: number; trails: MotionTrail[]; text: string }
> {
  const args = obj(rawArgs);
  const w = await windowOf(ctx, args, 1);
  if ('error' in w) return w;
  const endSec = Math.min(w.endSec, w.startSec + 4);
  const sampled = await sampleMotion(ctx, { ...w, endSec, maxSamples: 241 });
  const report = analyzeMotion(sampled);
  return {
    startSec: w.startSec,
    endSec,
    times: [...sampled.times],
    fps: sampled.fps,
    compWidth: sampled.compWidth,
    compHeight: sampled.compHeight,
    trails: trailsOf(sampled, report),
    text: formatMotionReport(report, { maxMoves: 30, maxFindings: 10 }),
  };
}
