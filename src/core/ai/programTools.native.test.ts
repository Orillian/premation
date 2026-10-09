/**
 * The AI tools the 2026-10 program added or repaired (docs/PROGRAM_PLAYBACK_TEXT_INK.md,
 * phase M / T5 / I1), on the app's engine.
 */

import type { Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { setupAppEngine, settleEdits, sec, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { documentMirror } from '@stores/documentMirror';
import { runToolTurn } from './aiTurn';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

let h: Harness;
beforeAll(async () => {
  h = await setupAppEngine();
  await h.run({ type: 'setCompositionSettings', comp: activeCompRootId() as string, patch: { duration: sec(5) } } as Command);
  await settleEdits();
}, 60_000);
afterAll(async () => { await h.dispose(); });

const idNamed = (name: string): string => {
  const m = documentMirror();
  return m.layerIds().find((c) => m.layer(c)?.name === name) ?? '';
};

async function value(layer: string, path: string): Promise<unknown> {
  const r = (await h.query({ type: 'getPropertyValues', props: [{ layer, path }], time: 0, evaluated: false } as never)) as {
    values: { value: { value: unknown } }[];
  };
  return r.values[0]?.value.value;
}

describe('add_effect params (M3)', () => {
  it('applies initial values and reports unknown keys', async () => {
    const r = await runToolTurn('AI: fx params', [
      { name: 'create_layer', args: { id: 'b', kind: 'shape', name: 'FxBox' } },
      { name: 'add_effect', args: { nodeId: 'b', type: 'gaussian-blur', id: 'soft', params: { blurriness: 42, nonsense: 3 } } },
    ]);
    expect(r.results[1]!.ok).toBe(true);
    expect(String(r.results[1]!.content)).toContain('blurriness=42');
    expect(String(r.results[1]!.content)).toContain('NOT set');
    expect(String(r.results[1]!.content)).toContain('nonsense');
    await settleEdits();
    expect(await value(idNamed('FxBox'), 'effects/soft/blurriness')).toBe(42);
  });
});
