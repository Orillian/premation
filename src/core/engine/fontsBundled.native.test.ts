/**
 * T2 (docs/PROGRAM_PLAYBACK_TEXT_INK.md): the fonts Premation ships
 * (resources/fonts, `PREMATION_FONTS_MANIFEST` — electron/engineHost.ts sets it
 * for the app) are registered by the engine: the default Inter renders as
 * Inter on a machine without it (no `font` layer error), and Japanese named in
 * a family nobody has draws from the bundled Noto faces.
 *
 * Needs a GPU adapter (PREMATION_GPU_TESTS=1), like the other full-renderer suites.
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import type { Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { runToolTurn } from '@core/ai/aiTurn';
import { documentMirror } from '@stores/documentMirror';
import { engineIdle } from '@core/engine/engineInstance';
import { sec, settleEdits, setupAppEngine, type Harness } from './__testHelpers__/appEngine';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

const manifest = path.join(__dirname, '..', '..', '..', 'resources', 'fonts', 'fonts.json');
const suite = process.env.PREMATION_GPU_TESTS === '1' && existsSync(manifest) ? describe : describe.skip;

suite('bundled fonts', () => {
  let h: Harness;
  beforeAll(async () => {
    // The engine reads it at start, as the app's engine host passes it.
    process.env.PREMATION_FONTS_MANIFEST = manifest;
    h = await setupAppEngine({ gpu: true });
    await h.run({ type: 'setCompositionSettings', comp: activeCompRootId() as string, patch: { width: 1280, height: 360, duration: sec(2) } } as Command);
    await settleEdits();
  }, 60_000);
  afterAll(async () => {
    await h.dispose();
    delete process.env.PREMATION_FONTS_MANIFEST;
  });

  it('T2: Inter and the Noto set are there — no missing-font report, kanji in an unknown family draw', async () => {
    const r = await runToolTurn('AI: bundled', [
      { name: 'create_layer', args: { id: 'bg', kind: 'shape', name: 'BG', x: 640, y: 180, width: 1280, height: 360, fill: '#ffffff' } },
      { name: 'create_layer', args: { id: 'a', kind: 'text', name: 'Inter title', text: 'The Last Cut', x: 640, y: 90 } },
      { name: 'update_layer', args: { nodeId: 'a', fontFamily: 'Inter', fontSize: 60, fill: '#000000' } },
      { name: 'create_layer', args: { id: 'b', kind: 'text', name: 'Noto JP title', text: '最後の一太刀', x: 640, y: 250 } },
      { name: 'update_layer', args: { nodeId: 'b', fontFamily: 'Noto Sans JP', fontSize: 90, fill: '#000000' } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    await h.run({ type: 'setViewport', viewport: 1, width: 1280, height: 360, devicePixelRatio: 1, zoom: 0, pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true } as Command);
    await settleEdits();
    await engineIdle();
    const m = documentMirror();
    const fontErrors = m.layerErrors(activeCompRootId() as string).filter((e) => e.stage === 'font');
    expect(fontErrors).toEqual([]);
  }, 120_000);
});
