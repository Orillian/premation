/**
 * Footage imported by a Git-Bash / MSYS path (`/c/Users/...`) is footage every
 * reader can open (docs/PROGRAM_PERFORMANCE.md V7). The import probe used to
 * accept such a path and store it as given, and the motion tracker then failed
 * on it: "cannot open '/c/...': No such file or directory".
 *
 * Windows only; needs a GPU adapter (PREMATION_GPU_TESTS=1) and ffmpeg on PATH.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { documentMirror } from '@stores/documentMirror';
import { sec, settleEdits, setupAppEngine, type Harness } from './__testHelpers__/appEngine';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function clip(): string | null {
  const dir = path.join(os.tmpdir(), 'premation-test-clips');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'msyspath_360p.mp4');
  if (existsSync(file)) return file;
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=2',
      '-pix_fmt', 'yuv420p', file], { stdio: 'ignore', timeout: 120_000 });
    return file;
  } catch {
    return null;
  }
}

const file = process.platform === 'win32' && process.env.PREMATION_GPU_TESTS === '1' ? clip() : null;
const suite = file ? describe : describe.skip;

suite('footage imported by an MSYS drive path', () => {
  let h: Harness;
  beforeAll(async () => { h = await setupAppEngine({ gpu: true }); }, 60_000);
  afterAll(async () => { await h.dispose(); });

  it('the motion tracker reads it', async () => {
    const msys = `/${file![0]!.toLowerCase()}${file!.slice(2).replace(/\\/g, '/')}`;
    const comp = activeCompRootId() as string;
    await h.run({ type: 'setCompositionSettings', comp, patch: { width: 640, height: 360, frameRate: { num: 30, den: 1 }, duration: sec(2) } } as Command);
    const finished = new Map<string, { status: string; error: string }>();
    const off = h.client.subscribe((b) => {
      for (const e of b.events) if (e.type === 'jobFinished') finished.set(e.job.id, { status: e.job.status, error: JSON.stringify(e.error ?? '') });
    });
    const items = (await h.run({ type: 'importFiles', files: [{ path: msys, asSequence: false, createComposition: false }] } as Command)) as unknown as { items: string[] };
    await settleEdits();
    const video = ((await h.run({ type: 'createLayer', comp, kind: 'video', source: items.items[0], init: [] } as Command)) as unknown as { layer: string }).layer;
    await settleEdits();
    expect(documentMirror().layer(video)).toBeTruthy();
    const job = (await h.run({ type: 'startJob', apply: false, job: { kind: 'trackMotion', value: {
      layer: video, kind: 'position', direction: 'forward', stabilize: false, excludeMasks: [], range: { start: 0, duration: sec(1) },
      points: [{ feature: { x: 320, y: 180, width: 31, height: 31 }, search: { x: 320, y: 180, width: 91, height: 91 }, attach: { x: 320, y: 180 } }],
    } } } as Command)) as unknown as { job: string };
    const t0 = Date.now();
    while (!finished.has(job.job) && Date.now() - t0 < 60_000) await sleep(50);
    off();
    expect(finished.get(job.job)).toMatchObject({ status: 'done' });
  }, 120_000);
});
