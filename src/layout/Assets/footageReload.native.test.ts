/**
 * reloadItems (AE's Reload Footage; Edit Original's save): the engine drops
 * what it decoded from those files and draws them again, without touching the
 * document — no history entry, nothing to undo. An unknown id is refused.
 */

import { setupAppEngine, historyLabels, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { buildScene } from '@core/engine/__testHelpers__/scene';

let h: Harness;
beforeEach(async () => { h = await setupAppEngine(); });
afterEach(async () => { await h.dispose(); });

it('reloads footage without a history entry or a document change', async () => {
  const s = await buildScene(h);
  const before = await h.doc();
  const entries = (await historyLabels()).length;
  await h.run({ type: 'reloadItems', items: [s.footage, s.footage2, s.comp2] });
  expect((await historyLabels()).length).toBe(entries);
  expect(await h.doc()).toBe(before);
});

it('refuses an item that does not exist', async () => {
  await buildScene(h);
  await expect(h.run({ type: 'reloadItems', items: ['item_nope'] })).rejects.toThrow(/item_nope/);
});
