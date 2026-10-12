/**
 * `add_sfx` inside a `begin_edit` group (docs/PROGRAM_3D_PERF_UX.md B2): the
 * timed insert joins the gesture the caller holds instead of opening one of
 * its own, which the engine refuses while a gesture is open.
 */

import { setupAppEngine, historyLabels, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { buildScene } from '@core/engine/__testHelpers__/scene';
import { engine, engineIdle } from '@core/engine/engineInstance';
import { flicksToSeconds } from '@motion/engine-api';
import { importPathsEdit } from '@layout/Assets/assetEdits';
import { documentMirror } from '@stores/documentMirror';
import { insertSfxAtEdit } from './sfxInsertEdits';

let h: Harness;

beforeEach(async () => {
  h = await setupAppEngine();
  await buildScene(h);
  // The project holds the item already (as after a first insert), so the
  // gesture under test is the layer and its timing alone.
  await importPathsEdit(['C:/sfx/UI Click.wav']);
  await engineIdle();
});
afterEach(async () => {
  await h.dispose();
});

describe('insertSfxAtEdit inside an open gesture', () => {
  it('joins the caller\'s gesture: the layer lands at its time, in the caller\'s one entry', async () => {
    const before = await h.doc();
    const n = (await historyLabels()).length;
    const opened = await engine().beginGesture('Claude: sound pass');
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const layer = await insertSfxAtEdit('sfx-click', 1.5, { joinGesture: true });
    expect(layer).not.toBeNull();

    const closed = await engine().endGesture(opened.value.gesture, true);
    expect(closed.ok).toBe(true);
    await engineIdle();

    const labels = await historyLabels();
    expect(labels.length).toBe(n + 1);
    expect(labels.at(-1)).toBe('Claude: sound pass');
    const info = documentMirror().layer(layer!);
    expect(info?.kind).toBe('audio');
    expect(flicksToSeconds(info!.timing.startTime)).toBeCloseTo(1.5, 3);

    // The caller's undo takes the insert with it.
    await h.run({ type: 'undo' });
    expect(await h.doc()).toBe(before);
  });

  it('without joinGesture an open gesture refuses the insert (the bug as reported)', async () => {
    const opened = await engine().beginGesture('Claude: sound pass');
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const layer = await insertSfxAtEdit('sfx-click', 1.5);
    await engine().endGesture(opened.value.gesture, false);
    await engineIdle();
    expect(layer).toBeNull();
  });
});
