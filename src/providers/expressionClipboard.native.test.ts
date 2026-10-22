/**
 * After Effects' expression gestures on the engine: Copy Expression Only →
 * Paste onto another layer (ONE entry), and Alt-click on a stopwatch, which
 * adds an expression where there is none and removes the one that is there.
 */

import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { trackExpressionFacts } from '@core/mirror/memberExpressions';
import { documentMirror } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';
import { usePropertySelectionStore } from '@stores/propertySelectionStore';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { canCopyExpression, clearHeldClipboard, copyExpressionOnlyEdit, pasteEdit } from './clipboardEdits';
import { altClickStopwatchEdit } from './commands/expressionCommands';

let h: Harness;

beforeEach(async () => {
  h = await setupAppEngine();
  clearHeldClipboard();
  useSelectionStore.getState().clear();
  usePropertySelectionStore.getState().clear();
  useKeyframeSelectionStore.getState().set(new Set());
});

afterEach(async () => {
  clearHeldClipboard();
  await h.dispose();
});

async function addShape(name: string): Promise<string> {
  const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name, init: [] });
  await engineIdle();
  return layer;
}

async function rotationExpression(layer: string): Promise<string | null> {
  await documentMirror().loadTree(layer);
  return trackExpressionFacts(documentMirror(), layer, 'rotation')?.source ?? null;
}

const RIG = 'var speed = 90;\ntime * speed';

describe('Copy Expression Only → Paste', () => {
  it('copies the source and pastes it onto the same property of the selected layer, as one entry', async () => {
    const a = await addShape('A');
    const b = await addShape('B');
    await h.run({ type: 'setExpression', prop: { layer: a, path: 'transform/rotation' }, source: RIG, enabled: true });
    await engineIdle();

    expect(await copyExpressionOnlyEdit({ nodeId: a, prop: 'rotation' })).toBe('expression');
    useSelectionStore.getState().set([b]);
    expect(await pasteEdit()).toBe('expression');
    await engineIdle();

    expect(await rotationExpression(b)).toBe(RIG);
    expect((await historyLabels()).slice(-1)).toEqual(['Paste Expression']);
  });

  it('has nothing to copy when the selected property carries no expression', async () => {
    const a = await addShape('A');
    usePropertySelectionStore.getState().select({ nodeId: a, prop: 'rotation' });
    expect(canCopyExpression()).toBe(false);
    expect(await copyExpressionOnlyEdit()).toBeNull();
  });
});

describe('Alt-click on a stopwatch', () => {
  it('adds `value` where there is no expression, and removes the one that is there', async () => {
    const a = await addShape('A');
    const opened: string[] = [];
    await altClickStopwatchEdit([{ nodeId: a, prop: 'rotation' }], (ref) => opened.push(ref.prop));
    await engineIdle();
    expect(await rotationExpression(a)).toBe('value');
    expect(opened).toEqual(['rotation']);

    await altClickStopwatchEdit([{ nodeId: a, prop: 'rotation' }], (ref) => opened.push(ref.prop));
    await engineIdle();
    expect(await rotationExpression(a)).toBeNull();
    expect(opened).toEqual(['rotation']);
  });
});
