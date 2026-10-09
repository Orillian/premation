/**
 * P11 (docs/PROGRAM_PLAYBACK_TEXT_INK.md): a layer whose effect stack falls to
 * the CPU bake (Skia, every frame) is reported on `layerErrors` with the reason
 * the GPU route refused it — the samurai session's playback cliff was one such
 * stack nobody could see. Advisory only: the frame still draws (and an export
 * does not refuse it, export_job.cpp).
 *
 * Needs a GPU adapter (PREMATION_GPU_TESTS=1), like the other full-renderer suites.
 */

import type { Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { runToolTurn } from '@core/ai/aiTurn';
import { documentMirror } from '@stores/documentMirror';
import { engineIdle } from '@core/engine/engineInstance';
import { sec, settleEdits, setupAppEngine, type Harness } from './__testHelpers__/appEngine';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

const suite = process.env.PREMATION_GPU_TESTS === '1' ? describe : describe.skip;

suite('CPU-baked effect stacks are reported', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setupAppEngine({ gpu: true });
    await h.run({ type: 'setCompositionSettings', comp: activeCompRootId() as string, patch: { width: 640, height: 360, duration: sec(2) } } as Command);
    await settleEdits();
  }, 60_000);
  afterAll(async () => { await h.dispose(); });

  it('P11: a Canvas2D-only effect sends its layer to the CPU, with the reason; a GPU stack is not reported', async () => {
    const r = await runToolTurn('AI: two stacks', [
      // Vegas traces the content's contours on the GPU only for a shape layer's own raster: on text it bakes.
      { name: 'create_layer', args: { id: 'cpu', kind: 'text', name: 'Vegas title', text: 'SAMURAI', x: 320, y: 180 } },
      { name: 'add_effect', args: { nodeId: 'cpu', type: 'vegas' } },
      { name: 'add_effect', args: { nodeId: 'cpu', type: 'glow' } },
      { name: 'create_layer', args: { id: 'gpu', kind: 'shape', name: 'Glow plate', x: 320, y: 180, width: 200, height: 100, fill: '#e0c080' } },
      { name: 'add_effect', args: { nodeId: 'gpu', type: 'glow' } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    // Layer errors are announced with viewport frames.
    await h.run({ type: 'setViewport', viewport: 1, width: 640, height: 360, devicePixelRatio: 1, zoom: 0, pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true } as Command);
    await settleEdits();
    await engineIdle();
    const m = documentMirror();
    const id = (name: string): string => m.layerIds().find((x) => m.layer(x)?.name === name)!;
    const errs = m.layerErrors(activeCompRootId() as string).filter((e) => e.stage === 'cpu-effects');
    expect(errs.filter((e) => e.layer === id('Vegas title')).map((e) => e.message).join()).toContain('a Canvas2D-only effect');
    expect(errs.filter((e) => e.layer === id('Glow plate'))).toEqual([]);
  }, 120_000);
});
