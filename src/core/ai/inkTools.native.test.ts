/**
 * Ink tools on the real engine (docs/PROGRAM_3D_PERF_UX.md I1–I3, and
 * add_scene's half of M1):
 *
 *   I1  `paint.<strokeId>.<param>` keyframes pass the animatable gate and land
 *       on the stroke's own track.
 *   I2  create_layer / update_layer take cap, join, miter, dash, taper and
 *       wave, and inspect_layers reads them back in the tool's units.
 *   I3  paint_strokes takes the brush tip (angle, roundness, spacing, flow)
 *       and the mode, and the stroke carries them.
 *   M1  a second add_scene with the same index replaces the scene.
 */

import type { Command } from '@motion/engine-api';
import { documentMirror } from '@stores/documentMirror';
import { sec, settleEdits, setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { mirrorStrokes } from '@core/mirror/paintFields';
import { mirrorPaintStrokes } from '@core/mirror/paintStrokes';
import { plainValue } from '@core/mirror/trackIndex';
import { runToolTurn } from './aiTurn';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });
jest.setTimeout(60_000);

let h: Harness;
beforeEach(async () => {
  h = await setupAppEngine();
  await h.run({ type: 'setCompositionSettings', comp: 'comp_root', patch: { frameRate: { num: 30, den: 1 }, duration: sec(10) } } as Command);
  await settleEdits();
});
afterEach(async () => { await h.dispose(); });

const named = (name: string): string => {
  const m = documentMirror();
  const id = m.layerIds().find((c) => m.layer(c)?.name === name);
  if (!id) throw new Error(`no layer named ${name}`);
  return id;
};
const namedAll = (name: string): string[] => {
  const m = documentMirror();
  return m.layerIds().filter((c) => m.layer(c)?.name === name);
};
const failures = (r: { results: { ok: boolean; content: string }[] }): string[] => r.results.filter((x) => !x.ok).map((x) => x.content);

/** A stored paint-stroke property, as the mirror holds it. */
async function paintValue(layer: string, strokeId: string, key: string): Promise<unknown> {
  const m = documentMirror();
  await m.loadTree(layer);
  return plainValue(m.tree(layer)?.nodes.get(`paint/${strokeId}/${key}`)?.value);
}

/** AE shows percentages; the model stores fractions. Either is the same answer. */
const pctIs = (v: unknown, percent: number): boolean =>
  typeof v === 'number' && (Math.abs(v - percent) < 0.01 || Math.abs(v - percent / 100) < 0.0001);

describe('I2 — stroke cap / join / miter / dash / taper / wave', () => {
  it('update_layer writes the whole Stroke group and inspect_layers reads it back', async () => {
    const r = await runToolTurn('AI: dashed ring', [
      { name: 'create_layer', args: { id: 'ring', kind: 'shape', shape: 'ellipse', name: 'Ring', width: 400, height: 400, fill: 'none' } },
      {
        name: 'update_layer',
        args: {
          nodeId: 'ring', stroke: '#ffd166', strokeWidth: 6, strokeCap: 'round', strokeJoin: 'bevel', miterLimit: 2,
          strokeDash: [12, 8], strokeDashOffset: 3,
          strokeTaper: { startLength: 30, endLength: 10, endWidth: 50, startEase: -0.5 },
          strokeWave: { amount: 4, wavelength: 40, phase: 90 },
        },
      },
      { name: 'inspect_layers', args: { nodeIds: ['ring'] } },
    ]);
    expect(failures(r)).toEqual([]);
    expect(r.results[1]!.content).toMatch(/strokeCap, strokeJoin, miterLimit, strokeDash, strokeDashOffset, strokeTaper, strokeWave/);

    const s = mirrorStrokes(documentMirror(), named('Ring'))[0]!;
    expect(s).toMatchObject({ color: '#ffd166', width: 6, cap: 'round', join: 'bevel', miterLimit: 2, dash: [12, 8], dashOffset: 3 });
    expect(s.taper).toMatchObject({ startLength: 0.3, endLength: 0.1, startWidth: 0, endWidth: 0.5, startEase: -0.5, endEase: 0 });
    expect(s.wave).toMatchObject({ amount: 4, wavelength: 40, phase: 90 });

    const row = (r.results[2]!.data as { layers: { stroke?: Record<string, unknown> }[] }).layers[0]!.stroke!;
    expect(row).toMatchObject({
      stroke: '#ffd166', strokeWidth: 6, strokeCap: 'round', strokeJoin: 'bevel', miterLimit: 2,
      strokeDash: [12, 8], strokeDashOffset: 3,
      strokeTaper: { startLength: 30, endLength: 10, startWidth: 0, endWidth: 50, startEase: -0.5, endEase: 0 },
      strokeWave: { amount: 4, wavelength: 40, phase: 90 },
    });
    expect(r.results[2]!.content).toMatch(/stroke #ffd166 6px, round cap, bevel join, dash \[12, 8\] offset 3, taper 30%\/10%, wave 4px every 40px/);
  });

  it('create_layer takes the stroke in the same call, and an identity taper is not stored', async () => {
    const r = await runToolTurn('AI: tapered line', [
      { name: 'create_layer', args: { id: 'ln', kind: 'shape', shape: 'rect', name: 'Line', width: 600, height: 4, fill: 'none', stroke: '#ffffff', strokeWidth: 10, strokeCap: 'square', strokeTaper: { startLength: 50, endLength: 50 } } },
      { name: 'update_layer', args: { nodeId: 'ln', strokeTaper: { startLength: 0, endLength: 0 } } },
    ]);
    expect(failures(r)).toEqual([]);
    expect(r.results[0]!.content).toMatch(/Stroke set: stroke, strokeWidth, strokeCap, strokeTaper/);
    const s = mirrorStrokes(documentMirror(), named('Line'))[0]!;
    expect(s).toMatchObject({ width: 10, cap: 'square' });
    expect(s.taper).toBeUndefined();
  });

  it('refuses the shape-only stroke fields on a text layer, by name', async () => {
    const r = await runToolTurn('AI: dashed type', [
      { name: 'create_layer', args: { id: 't', kind: 'text', name: 'T', text: 'DASH' } },
      { name: 'update_layer', args: { nodeId: 't', stroke: '#ffffff', strokeDash: [4, 4] } },
    ]);
    expect(r.results[1]!.ok).toBe(false);
    expect(r.results[1]!.content).toMatch(/strokeDash belong/);
  });
});

describe('I3 — paint_strokes brush tip and mode', () => {
  it('stores angle, roundness, spacing, flow and the mode on the stroke', async () => {
    const r = await runToolTurn('AI: nib', [
      { name: 'create_layer', args: { id: 'paper', kind: 'solid', name: 'Paper', width: 800, height: 600, fill: '#f4efe6' } },
      {
        name: 'paint_strokes',
        args: {
          nodeId: 'paper',
          strokes: [
            { points: [[100, 100], [400, 300], [700, 120]], color: '#1b1b1b', size: 24, angle: 45, roundness: 30, spacing: 25, flow: 60 },
            { points: [[100, 500], [700, 500]], size: 40, mode: 'erase' },
          ],
        },
      },
    ]);
    expect(failures(r)).toEqual([]);
    expect(r.results[1]!.content).toMatch(/paint\/erase stroke\(s\)/);
    const ids = (r.results[1]!.data as { strokes: string[] }).strokes;
    expect(ids).toHaveLength(2);
    const paper = named('Paper');
    expect(await paintValue(paper, ids[0]!, 'angle')).toBe(45);
    expect(pctIs(await paintValue(paper, ids[0]!, 'roundness'), 30)).toBe(true);
    expect(pctIs(await paintValue(paper, ids[0]!, 'spacing'), 25)).toBe(true);
    expect(pctIs(await paintValue(paper, ids[0]!, 'flow'), 60)).toBe(true);
    const strokes = mirrorPaintStrokes(documentMirror(), paper);
    expect(strokes.map((s) => s.mode)).toEqual(['paint', 'erase']);
  });
});

describe('I1 — paint.<strokeId>.<param> keyframes', () => {
  it('set_keyframes accepts the write-on track paint_strokes names and the keys land on it', async () => {
    const made = await runToolTurn('AI: ink', [
      { name: 'create_layer', args: { id: 'paper', kind: 'solid', name: 'Paper', width: 800, height: 600, fill: '#ffffff' } },
      { name: 'paint_strokes', args: { nodeId: 'paper', strokes: [{ points: [[50, 50], [750, 550]], size: 16 }] } },
    ]);
    expect(failures(made)).toEqual([]);
    const sid = (made.results[1]!.data as { strokes: string[] }).strokes[0]!;
    const paper = named('Paper');
    const keyed = await runToolTurn('AI: write on', [
      {
        name: 'set_keyframes',
        args: {
          keyframes: [
            { nodeId: paper, prop: `paint.${sid}.end`, t: 0.5, value: 0, easing: 'easeOut' },
            { nodeId: paper, prop: `paint.${sid}.end`, t: 2, value: 100 },
            { nodeId: paper, prop: `paint.${sid}.opacity`, t: 2, value: 100 },
            { nodeId: paper, prop: `paint.${sid}.opacity`, t: 3, value: 0 },
          ],
        },
      },
      { name: 'read_tracks', args: { nodeId: paper } },
    ]);
    expect(failures(keyed)).toEqual([]);
    expect(keyed.results[0]!.content).toMatch(/Set 4 keyframes across 2 properties/);
    const m = documentMirror();
    await m.loadTree(paper);
    expect(m.keyframes(paper, `paint/${sid}/end`)).toHaveLength(2);
    expect(m.keyframes(paper, `paint/${sid}/opacity`)).toHaveLength(2);
    expect(keyed.results[1]!.content).toMatch(new RegExp(`paint\\.${sid}\\.end`));
  });

  it('still refuses the Path as a scalar track', async () => {
    const made = await runToolTurn('AI: ink', [
      { name: 'create_layer', args: { id: 'paper', kind: 'solid', name: 'Paper', width: 800, height: 600 } },
      { name: 'paint_strokes', args: { nodeId: 'paper', strokes: [{ points: [[50, 50], [750, 550]] }] } },
    ]);
    const sid = (made.results[1]!.data as { strokes: string[] }).strokes[0]!;
    const r = await runToolTurn('AI: bad key', [
      { name: 'set_keyframes', args: { keyframes: [{ nodeId: named('Paper'), prop: `paint.${sid}.path`, t: 0, value: 0 }] } },
    ]);
    expect(r.results[0]!.ok).toBe(false);
    expect(r.results[0]!.content).toMatch(/not animatable/);
  });
});

describe('M1 — add_scene replaces a scene built before', () => {
  it('a second add_scene with the same index removes the first scene and its content', async () => {
    const r = await runToolTurn('AI: scenes', [
      { name: 'add_scene', args: { index: 1, startSec: 0, durationSec: 4, background: '#101020' } },
      { name: 'add_title', args: { text: 'First take', scene: 1 } },
      { name: 'add_scene', args: { index: 1, startSec: 0, durationSec: 4, background: '#201010' } },
      { name: 'add_title', args: { text: 'Second take', scene: 1 } },
      { name: 'add_scene', args: { index: 2, startSec: 4, durationSec: 4, background: '#102010' } },
    ]);
    expect(failures(r)).toEqual([]);
    expect(r.results[2]!.content).toMatch(/Replaced the scene 1 built earlier \(2 layer\(s\) removed/);
    expect(namedAll('Scene 1 BG')).toHaveLength(1);
    expect(namedAll('Scene 2 BG')).toHaveLength(1);
    const m = documentMirror();
    const texts = m.layerIds().map((id) => m.layer(id)?.name ?? '');
    expect(texts.some((n) => /First take/.test(n))).toBe(false);
    expect(texts.some((n) => /Second take/.test(n))).toBe(true);
  });

  it('append: true keeps the earlier scene', async () => {
    const r = await runToolTurn('AI: scenes', [
      { name: 'add_scene', args: { index: 1, startSec: 0, durationSec: 4, background: '#101020' } },
      { name: 'add_scene', args: { index: 1, startSec: 0, durationSec: 4, background: '#201010', append: true } },
    ]);
    expect(failures(r)).toEqual([]);
    expect(namedAll('Scene 1 BG')).toHaveLength(2);
  });
});
