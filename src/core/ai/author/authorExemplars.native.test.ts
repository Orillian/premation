/**
 * Every author exemplar builds on the engine: the reference a model is shown
 * must itself be a script the engine takes call for call. A generated image
 * needs a provider this machine does not have, so the calls about such a
 * layer (its generation and what addresses it after) are the only ones
 * allowed to fail.
 */

import type { Command } from '@motion/engine-api';
import { AUTHOR_EXEMPLARS, compileScript } from '@motion/author';
import { sec, settleEdits, setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { runToolTurn } from '../aiTurn';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

let h: Harness;
afterEach(async () => { await h.dispose(); });

/** Ids of layers whose pixels come from a generator (image, video). */
function generatedIds(script: (typeof AUTHOR_EXEMPLARS)[number]['script']): Set<string> {
  const all = [...script.globals, ...script.beats.flatMap((b) => b.layers)];
  return new Set(all.filter((l) => l.kind === 'image' || l.kind === 'video').map((l) => l.id));
}

describe('author exemplars on the engine', () => {
  it.each(AUTHOR_EXEMPLARS.map((e) => [e.id, e]))('%s builds with every call taken', async (_id, ex) => {
    h = await setupAppEngine();
    await h.run({ type: 'setCompositionSettings', comp: 'comp_root', patch: { frameRate: { num: 30, den: 1 }, duration: sec(ex.script.durationSec), width: 1920, height: 1080 } } as Command);
    await settleEdits();
    const generated = generatedIds(ex.script);
    const calls = compileScript(ex.script).calls;
    const r = await runToolTurn(`AI: ${ex.id}`, calls.map((c) => ({ name: c.name, args: c.args })));
    const refused = r.results
      .map((res, i) => ({ res, call: calls[i]! }))
      .filter(({ res }) => !res.ok)
      .filter(({ call }) => {
        const blob = JSON.stringify(call.args);
        return ![...generated].some((id) => blob.includes(`"${id}"`));
      })
      .map(({ res, call }) => `${call.name}: ${res.content.slice(0, 200)}`);
    expect(refused).toEqual([]);
  }, 180_000);
});
