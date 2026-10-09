/**
 * P1 (docs/PROGRAM_PLAYBACK_TEXT_INK.md): a composition with video footage
 * reaches the frame cache. Cache Work Area used to build its frames as
 * "playing", and a playing frame with footage was never stored — so a comp
 * with a video layer cached nothing and every loop played live.
 *
 * Needs a GPU adapter (PREMATION_GPU_TESTS=1), like the other full-renderer suites.
 */

import path from 'node:path';
import { ProcessEngineClient, secondsToFlicks, unwrap } from '@motion/engine-api';
import type { EngineFrameMessage } from '../../../electron/engineFraming';
import { nativeEngineExe, startNativeEngine } from './__testHelpers__/nativeEngine';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const suite = process.env.PREMATION_GPU_TESTS === '1' && nativeEngineExe() ? describe : describe.skip;

suite('video footage in the frame cache', () => {
  it('Cache Work Area stores every frame of a comp with a video layer', async () => {
    const native = await startNativeEngine({ extraArgs: ['--frame-cache-mb', '1024', '--log-level', 'warn'] });
    const client = new ProcessEngineClient(native.bridge);
    let phase = 'idle';
    native.supervisor.on('frame', (m: EngineFrameMessage) => {
      if (m.type === 'frameReady') native.supervisor.releaseSlot(m.generation, m.slot);
    });
    client.subscribe((batch) => {
      for (const e of batch.events) if (e.type === 'transportChanged') phase = e.state;
    });
    try {
      await client.execute({ type: 'newProject' });
      const doc = unwrap(await client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
      const comp = doc.comps[0]!.id;
      await client.execute({ type: 'setCompositionSettings', comp, patch: { frameRate: { num: 30, den: 1 }, duration: secondsToFlicks(2), width: 640, height: 360 } });
      await client.execute({ type: 'setActiveComposition', comp });
      const clip = path.resolve(__dirname, '../../../packages/render-tests/scenes/video-decoded-frame.media/media-0.mp4');
      const item = unwrap(await client.execute({ type: 'importFiles', files: [{ path: clip, asSequence: false, createComposition: false }] })).items[0]!;
      unwrap(await client.execute({ type: 'createLayer', comp, kind: 'video', source: item, init: [] }));
      await client.execute({
        type: 'setViewport', viewport: 1, width: 640, height: 360, devicePixelRatio: 1, zoom: 1,
        pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true,
      });
      await client.execute({ type: 'setLoop', mode: 'once' });
      await client.execute({
        type: 'play', rate: 1, range: 'custom', custom: { start: 0, duration: secondsToFlicks(1) },
        audio: false, cacheFirst: true, cacheOnly: true,
      });
      const until = Date.now() + 60_000;
      await sleep(200);
      while (phase !== 'stopped' && Date.now() < until) await sleep(50);
      const cov = unwrap(await client.query({ type: 'getCacheCoverage', comp }));
      const frame = secondsToFlicks(1 / 30);
      const cached = cov.ram.reduce((n, r) => n + Math.round((r.end - r.start) / frame), 0);
      expect(phase).toBe('stopped');
      expect(cached).toBeGreaterThanOrEqual(30);
    } finally {
      await native.stop();
    }
  }, 120_000);
});
