/**
 * Traps hit building films through the Premation MCP (2026-10-12 … 10-20),
 * at the compiler / advisor / card level: what the script said must be what
 * the calls carry. The engine-side half is src/core/ai/mcp/mcpTraps.native.test.ts.
 */

import { ALL_TOOL_DEFS, validate } from '@motion/ai-tools';
import { adviseScript } from './advisors';
import { coerceScript } from './coerce';
import { beatRootId, compileScript } from './compile';
import type { SceneScript, ToolCall } from './types';
import { vocabularyCard } from './vocabulary';

const CTX = { durationSec: 6, width: 1920, height: 1080 };

const base = (over: Partial<SceneScript> = {}): SceneScript => ({
  title: 't', intent: 'i', durationSec: 6, background: '$bg',
  palette: { bg: '#101014', ink: '#fafafa', hot: '#ff3355' },
  grid: { columns: 12, gutter: 24, margin: 120, baseline: 8 },
  type: { h1: { family: 'Inter', weight: 700, size: 120 } },
  globals: [],
  beats: [],
  ...over,
});

const calls = (c: ToolCall[], name: string): ToolCall[] => c.filter((x) => x.name === name);
const schemaOk = (c: ToolCall): boolean => validate(ALL_TOOL_DEFS.find((d) => d.name === c.name)!.inputSchema, c.args).ok;

describe('compiler traps', () => {
  it('resolves a stroke palette reference on the creation call, as it does a fill (Operand)', () => {
    const out = compileScript(base({
      beats: [{
        name: 'A', purpose: '', startSec: 0, endSec: 6,
        layers: [{ id: 'u', kind: 'shape', name: 'Underline', shape: 'line', props: { width: 600, height: 0, stroke: '$hot', strokeWidth: 6, fill: '$ink' } }],
      }],
    }));
    const created = calls(out.calls, 'create_layer').find((c) => c.args.id === 'u')!;
    expect(created.args).toMatchObject({ stroke: '#ff3355', fill: '#fafafa', strokeWidth: 6 });
  });

  it('sends a text layer\'s width as its paragraph box (ChatGPT film)', () => {
    const out = compileScript(base({
      beats: [{ name: 'A', purpose: '', startSec: 0, endSec: 6, layers: [{ id: 't', kind: 'text', name: 'Body', text: 'Copy', props: { x: 400, y: 300, width: 600, align: 'left' } }] }],
    }));
    const all = out.calls.filter((c) => c.args.id === 't' || c.args.nodeId === 't');
    expect(all.some((c) => c.args.boxWidth === 600)).toBe(true);
    expect(all.some((c) => c.args.width !== undefined)).toBe(false);
    for (const c of all) expect([c.name, schemaOk(c)]).toEqual([c.name, true]);
  });

  it('keeps a pre-compose layer under its beat root and on the beat\'s bar (The Last Blade)', () => {
    const out = compileScript(base({
      beats: [
        { name: 'A', purpose: '', startSec: 0, endSec: 2, layers: [] },
        {
          name: 'B', purpose: '', startSec: 2, endSec: 5,
          layers: [
            { id: 'a', kind: 'shape', name: 'A', shape: 'rect', props: { width: 10, height: 10 } },
            { id: 'b', kind: 'shape', name: 'B', shape: 'rect', props: { width: 10, height: 10 } },
          ],
          precompose: [{ id: 'rig', name: 'Rig', layers: ['a', 'b'] }],
        },
      ],
    }));
    expect(out.calls).toContainEqual({ name: 'reparent_layer', args: { nodeId: 'rig', parentId: beatRootId(1) } });
    const bars = calls(out.calls, 'set_layer_timing').flatMap((c) => c.args.items as Array<{ nodeId: string }>);
    expect(bars).toContainEqual({ nodeId: 'rig', inSec: 2, outSec: 5 });
    // The bar comes after the pre-compose that made the layer.
    const made = out.calls.findIndex((c) => c.name === 'create_precomp');
    const timed = out.calls.findIndex((c) => c.name === 'set_layer_timing' && (c.args.items as Array<{ nodeId: string }>).some((i) => i.nodeId === 'rig'));
    expect(timed).toBeGreaterThan(made);
  });

  it('carries a stroke dash, taper and wave through coerce and compile to update_layer (card: stroke look)', () => {
    const raw = base({
      beats: [{
        name: 'A', purpose: '', startSec: 0, endSec: 6,
        layers: [{
          id: 'r', kind: 'shape', name: 'Ring', shape: 'ellipse',
          props: { width: 300, height: 300, fill: 'none', stroke: '$ink', strokeWidth: 4, strokeDash: [12, 8], strokeTaper: { startLength: 30, endLength: 10 }, strokeWave: { amount: 4, wavelength: 40 } },
        }],
      }],
    });
    const c = coerceScript(raw, CTX);
    expect(c.repairs.filter((r) => /stroke/.test(r.path))).toEqual([]);
    const update = calls(compileScript(c.value).calls, 'update_layer').find((u) => u.args.nodeId === 'r')!;
    expect(update.args).toMatchObject({ strokeDash: [12, 8], strokeTaper: { startLength: 30, endLength: 10 }, strokeWave: { amount: 4, wavelength: 40 } });
    expect(schemaOk(update)).toBe(true);
    // A malformed one is dropped and said, not sent.
    const bad = coerceScript(base({ beats: [{ name: 'A', purpose: '', startSec: 0, endSec: 6, layers: [{ id: 'r', kind: 'shape', name: 'R', shape: 'rect', props: { strokeDash: ['x'] as never } }] }] }), CTX);
    expect(bad.repairs.map((r) => r.message).join('\n')).toMatch(/strokeDash/);
  });
});

describe('advisor traps', () => {
  const reveal = (shape: string): SceneScript => base({
    beats: [{
      name: 'A', purpose: '', startSec: 0, endSec: 6,
      layers: [{ id: 't', kind: 'text', name: 'Title', text: 'OPERAND', textAnimators: [{ shape: shape as never, opacity: 0, sweep: { from: 0.5, to: 1.5 } }] }],
    }],
  });

  it('flags a reveal swept with a ramp or bump shape: hidden text shows before and after (Operand, The Last Blade)', () => {
    for (const shape of ['smooth', 'rampUp', 'triangle']) {
      const s = reveal(shape);
      const f = adviseScript(s, compileScript(s), { width: 1920, height: 1080, fps: 30 }).findings.filter((x) => x.rule === 'SWEEP_SHAPE_LEAKS');
      expect([shape, f.length, f[0]?.severity]).toEqual([shape, 1, 'error']);
    }
  });

  it('leaves a square reveal and a ramp wave over visible text alone', () => {
    const square = reveal('square');
    expect(adviseScript(square, compileScript(square), { width: 1920, height: 1080, fps: 30 }).findings.filter((x) => x.rule === 'SWEEP_SHAPE_LEAKS')).toEqual([]);
    const wave = base({
      beats: [{ name: 'A', purpose: '', startSec: 0, endSec: 6, layers: [{ id: 't', kind: 'text', name: 'T', text: 'WAVE', textAnimators: [{ shape: 'smooth', y: -40, sweep: { from: 0, to: 2, fromOffset: -100, toOffset: 100 } }] }] }],
    });
    expect(adviseScript(wave, compileScript(wave), { width: 1920, height: 1080, fps: 30 }).findings.filter((x) => x.rule === 'SWEEP_SHAPE_LEAKS')).toEqual([]);
  });

  it('leaves an AE soft reveal alone: Ramp Up swept −100 → 100, Ramp Down 100 → −100', () => {
    for (const [shape, fromOffset, toOffset] of [['rampUp', -100, 100], ['rampDown', 100, -100]] as const) {
      const s = base({
        beats: [{ name: 'A', purpose: '', startSec: 0, endSec: 6, layers: [{ id: 't', kind: 'text', name: 'T', text: 'SOFT', textAnimators: [{ shape, opacity: 0, sweep: { from: 0.5, to: 1.5, fromOffset, toOffset } }] }] }],
      });
      expect([shape, adviseScript(s, compileScript(s), { width: 1920, height: 1080, fps: 30 }).findings.filter((x) => x.rule === 'SWEEP_SHAPE_LEAKS')]).toEqual([shape, []]);
    }
  });
});

describe('the vocabulary card tells the model what the engine does', () => {
  const card = vocabularyCard();

  it('describes expressions as AE rigs with statements, not a "single JS expression" (statements landed 2026-10-20)', () => {
    expect(card).not.toMatch(/single JS expression/);
    expect(card).toMatch(/var \/ let \/ const/);
    expect(card).toMatch(/effect\("Name"\)\("Param"\)/);
  });

  it('says text width is a paragraph box and how align uses it', () => {
    expect(card).toMatch(/`width` makes it paragraph text/);
  });

  it('lists curve, layer and mask params on the effect lines, and how to write a curve', () => {
    expect(card).toMatch(/^ {2}curves \(.*points:curve/m);
    expect(card).toMatch(/A curve param takes its points \[\[x, y\]/);
    expect(card).toMatch(/displacement-map \(.*mapLayerId:layer id/);
  });

  it('says a reveal needs a square selector and how svg size works', () => {
    expect(card).toMatch(/A REVEAL .* needs shape square/);
    expect(card).toMatch(/svg: your own vector .* the size the markup width \/ height say/);
  });
});
