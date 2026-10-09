/**
 * A paused viewport ends a seek on the EXACT footage frame (docs/PROGRAM_PERFORMANCE.md V1).
 *
 * Found 2026-10-10 with the owner's footage (long-GOP H.264 from a phone /
 * stock site): the paused viewport waited 250 ms for a seek's frame on the
 * exact decode lane, then skipped the layer — and nothing drew it again, so
 * a seek deep into a GOP could stay wrong. And every paused seek queued on
 * that FIFO lane: after a scrub across a 4K clip the decoder worked through
 * every stale frame (each from its keyframe) before the one under the
 * playhead.
 *
 * Exact frames are what the frame cache stores, so "the viewport shows the
 * exact frame" is read as "the frame is in the cache's coverage".
 *
 * Needs a GPU adapter (PREMATION_GPU_TESTS=1) and ffmpeg on PATH (the clip is
 * generated: 4K, GOP 250, so a seek decodes hundreds of frames).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessEngineClient, secondsToFlicks, unwrap } from '@motion/engine-api';
import type { EngineFrameMessage } from '../../../electron/engineFraming';
import { nativeEngineExe, startNativeEngine } from './__testHelpers__/nativeEngine';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function longGopClip(): string | null {
  const dir = path.join(os.tmpdir(), 'premation-test-clips');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settle_2160p_gop250.mp4');
  if (existsSync(file)) return file;
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=30:duration=10,noise=alls=6:allf=t',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '40M', '-g', '250', '-bf', '2', '-pix_fmt', 'yuv420p', file], { stdio: 'ignore', timeout: 300_000 });
    return file;
  } catch {
    return null;
  }
}

const clip = process.env.PREMATION_GPU_TESTS === '1' && nativeEngineExe() ? longGopClip() : null;
const suite = clip ? describe : describe.skip;

suite('paused seeks settle on the exact footage frame', () => {
  let native: Awaited<ReturnType<typeof startNativeEngine>>;
  let client: ProcessEngineClient;
  let comp = '';
  const frameDur = secondsToFlicks(1 / 30);

  beforeAll(async () => {
    native = await startNativeEngine({ extraArgs: ['--frame-cache-mb', '1024', '--log-level', 'warn'] });
    client = new ProcessEngineClient(native.bridge);
    native.supervisor.on('frame', (m: EngineFrameMessage) => {
      if (m.type === 'frameReady') native.supervisor.releaseSlot(m.generation, m.slot);
    });
    await client.execute({ type: 'newProject' });
    const doc = unwrap(await client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
    comp = doc.comps[0]!.id;
    await client.execute({ type: 'setCompositionSettings', comp, patch: { frameRate: { num: 30, den: 1 }, duration: secondsToFlicks(10), width: 1920, height: 1080 } });
    await client.execute({ type: 'setActiveComposition', comp });
    const item = unwrap(await client.execute({ type: 'importFiles', files: [{ path: clip!, asSequence: false, createComposition: false }] })).items[0]!;
    unwrap(await client.execute({ type: 'createLayer', comp, kind: 'video', source: item, init: [] }));
    await client.execute({
      type: 'setViewport', viewport: 1, width: 960, height: 540, devicePixelRatio: 1, zoom: 1,
      pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true,
    });
    await sleep(500);
  }, 360_000);
  afterAll(async () => { await native?.stop(); });

  /** Wait until `frame` is in the cache's coverage (drawn exact); ms, or -1 after `limit`. */
  async function exactAfter(frame: number, t0: number, limit = 20_000): Promise<number> {
    while (Date.now() - t0 < limit) {
      const cov = unwrap(await client.query({ type: 'getCacheCoverage', comp }));
      const at = frame * frameDur;
      if (cov.ram.some((r) => r.start <= at && at < r.end)) return Date.now() - t0;
      await sleep(25);
    }
    return -1;
  }

  it('a seek deep into a GOP ends on its exact frame', async () => {
    const t0 = Date.now();
    await client.execute({ type: 'seek', time: 240 * frameDur, mode: 'exact' });
    const ms = await exactAfter(240, t0);
    console.log(`[settle] seek to frame 240 exact after ${ms} ms`);
    expect(ms).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('a scrub does not queue its stale decodes ahead of the frame under the playhead', async () => {
    // 20 seeks across the clip as a playhead drag sends them, then the last one.
    const frames = Array.from({ length: 20 }, (_, i) => 20 + ((i * 113) % 260));
    for (const f of frames.slice(0, -1)) {
      await client.execute({ type: 'seek', time: f * frameDur, mode: 'scrub' });
      await sleep(15);
    }
    const last = 290;
    const t0 = Date.now();
    await client.execute({ type: 'seek', time: last * frameDur, mode: 'scrub' });
    const ms = await exactAfter(last, t0);
    console.log(`[settle] last of 20 scrub seeks exact after ${ms} ms`);
    expect(ms).toBeGreaterThanOrEqual(0);
    // One decode from the keyframe, not nineteen ahead of it.
    expect(ms).toBeLessThan(6000);
  }, 60_000);
});
