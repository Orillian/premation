/**
 * `update_layer` strokes TYPE (docs/PROGRAM_PERFORMANCE.md T6): stroke /
 * strokeWidth / strokeOpacity on a text layer land where the Character panel
 * writes them — `text/stroke` (opacity is its alpha) and the Text component's
 * `strokeWidth` — instead of the old refusal ("give type an outline with a
 * text_animator or an effect").
 */

import type { Command } from '@motion/engine-api';
import { documentMirror } from '@stores/documentMirror';
import { sec, settleEdits, setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { propRefForTrack } from '@core/engine/propRefs';
import { runToolTurn } from './aiTurn';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

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

async function strokeOf(id: string): Promise<{ color: unknown; width: unknown; noStroke: unknown }> {
  const m = documentMirror();
  await m.loadTree(id);
  const tree = m.tree(id);
  const widthPath = propRefForTrack(id, 'strokeWidth')?.ref.path;
  return {
    color: tree?.nodes.get('text/stroke')?.value,
    width: widthPath ? (m.valueAt(id, widthPath, 0) ?? m.property(id, widthPath)?.value) : undefined,
    noStroke: tree?.nodes.get('text/noStroke')?.value,
  };
}

describe('update_layer strokes text', () => {
  it('sets the Character stroke colour and width', async () => {
    const r = await runToolTurn('AI: outline', [
      { name: 'create_layer', args: { id: 't', kind: 'text', name: 'T', text: 'OUTLINE' } },
      { name: 'update_layer', args: { nodeId: 't', stroke: '#ffd166', strokeWidth: 4 } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    const s = await strokeOf(named('T'));
    expect(s.color).toMatchObject({ kind: 'color', value: { r: 1, a: 1 } });
    expect((s.color as { value: { g: number } }).value.g).toBeCloseTo(0xd1 / 255, 2);
    expect(s.width).toMatchObject({ value: 4 });
    expect(s.noStroke).toMatchObject({ value: false });
  });

  it('strokeOpacity alone keeps the colour and sets its alpha', async () => {
    const r = await runToolTurn('AI: fade outline', [
      { name: 'create_layer', args: { id: 't', kind: 'text', name: 'T', text: 'OUTLINE' } },
      { name: 'update_layer', args: { nodeId: 't', stroke: '#00ff00', strokeWidth: 2 } },
      { name: 'update_layer', args: { nodeId: 't', strokeOpacity: 50 } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    const c = (await strokeOf(named('T'))).color as { value: { r: number; g: number; b: number; a: number } };
    expect(c.value.g).toBeCloseTo(1, 2);
    expect(c.value.r).toBeCloseTo(0, 2);
    expect(c.value.a).toBeCloseTo(0.5, 2);
  });

  it('still refuses a stroke on a layer with no outline', async () => {
    const r = await runToolTurn('AI: stroke a null', [
      { name: 'create_layer', args: { id: 'n', kind: 'null', name: 'N' } },
      { name: 'update_layer', args: { nodeId: 'n', stroke: '#ffffff' } },
    ]);
    expect(r.results[1]!.ok).toBe(false);
  });
});
