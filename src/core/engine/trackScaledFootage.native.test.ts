/**
 * The motion tracker on footage larger than its 960 px analysis size reads the
 * luma plane scaled straight to grey (docs/PROGRAM_PERFORMANCE.md V6: 4x faster
 * than converting every frame to RGBA first) — and still lands on the feature.
 * A textured 1080p picture panned left 300 px/s; the track must follow it.
 *
 * Needs a GPU adapter (PREMATION_GPU_TESTS=1) and ffmpeg on PATH.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { sec, settleEdits, setupAppEngine, type Harness } from './__testHelpers__/appEngine';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function clip(): string | null {
  const dir = path.join(os.tmpdir(), 'premation-test-clips');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'track_scroll_1080p.mp4');
  if (existsSync(file)) return file;
  const still = path.join(dir, 'track_scroll_texture.png');
  try {
    // A fixed noise texture twice the frame wide, panned left 300 px/s: every
    // point of the picture moves exactly x = x0 - 300 t.
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=3840x1080,noise=alls=80:allf=u,boxblur=2',
      '-frames:v', '1', still], { stdio: 'ignore', timeout: 120_000 });
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-framerate', '30', '-i', still, '-t', '2',
      '-vf', 'crop=1920:1080:300*t:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', file], { stdio: 'ignore', timeout: 120_000 });
    return file;
  } catch {
    return null;
  }
}

const file = process.env.PREMATION_GPU_TESTS === '1' ? clip() : null;
const suite = file ? describe : describe.skip;

suite('tracking footage above the analysis size', () => {
  let h: Harness;
  beforeAll(async () => { h = await setupAppEngine({ gpu: true }); }, 60_000);
  afterAll(async () => { await h.dispose(); });

  it('follows a 1080p picture panning 300 px/s', async () => {
    const comp = activeCompRootId() as string;
    await h.run({ type: 'setCompositionSettings', comp, patch: { width: 1920, height: 1080, frameRate: { num: 30, den: 1 }, duration: sec(2) } } as Command);
    const results = new Map<string, string>();
    const off = h.client.subscribe((b) => {
      for (const e of b.events) if (e.type === 'jobFinished') results.set(e.job.id, e.job.result);
    });
    const items = (await h.run({ type: 'importFiles', files: [{ path: file!, asSequence: false, createComposition: false }] } as Command)) as unknown as { items: string[] };
    const video = ((await h.run({ type: 'createLayer', comp, kind: 'video', source: items.items[0], init: [] } as Command)) as unknown as { layer: string }).layer;
    await settleEdits();
    const job = (await h.run({ type: 'startJob', apply: false, job: { kind: 'trackMotion', value: {
      layer: video, kind: 'position', direction: 'forward', stabilize: false, excludeMasks: [], range: { start: 0, duration: sec(1.5) },
      points: [{ feature: { x: 430, y: 540, width: 61, height: 61 }, search: { x: 430, y: 540, width: 121, height: 121 }, attach: { x: 430, y: 540 } }],
    } } } as Command)) as unknown as { job: string };
    const t0 = Date.now();
    while (!results.has(job.job) && Date.now() - t0 < 60_000) await sleep(50);
    off();
    // Samples are [t, x, y, confidence, coasted] (result.sample).
    const result = JSON.parse(results.get(job.job) ?? '{}') as { tracks?: number[][][] };
    const track = result.tracks?.[0] ?? [];
    expect(track.length).toBeGreaterThan(30);
    for (const [t, x, y] of track) {
      expect(Math.abs(x! - (430 - 300 * t!))).toBeLessThan(6);
      expect(Math.abs(y! - 540)).toBeLessThan(6);
    }
  }, 120_000);
});
