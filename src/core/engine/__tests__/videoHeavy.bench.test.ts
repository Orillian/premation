/**
 * The owner's "uploaded a video, gave it effects and motion tracks — it became
 * super slow" (2026-10-10): footage as people shoot it (long-GOP H.264 1080p
 * and 4K, 10-bit HEVC), an effect stack on it, a title riding a motion track,
 * and the work an editor does on that — play, scrub, track, tweak. Prints one
 * JSON line per measurement; the numbers the performance program (docs/
 * PROGRAM_PERFORMANCE.md) is measured against.
 *
 * The clips are generated with ffmpeg into the OS temp folder on first run
 * (testsrc2 + grain at camera bitrates, GOP 250). No ffmpeg on PATH: skipped.
 * Run with the bench jest config (`npm run bench`). Needs the full engine (GPU).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { documentMirror } from '@stores/documentMirror';
import { runToolTurn } from '@core/ai/aiTurn';
import { onSharedEngineFrames, openMainViewport, sec, settleEdits, setupAppEngine, type Harness } from '../__testHelpers__/appEngine';
import { nativeEngineIsHeadless } from '../__testHelpers__/nativeEngine';

// hrtime / performance / Date real: the bench measures wall time.
jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate', 'hrtime', 'performance', 'Date'] });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const now = (): number => Number(process.hrtime.bigint()) / 1e6;
const pct = (xs: number[], q: number): number => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))]! : 0);
const r1 = (v: number): number => Number(v.toFixed(1));

const CLIPS: { name: string; size: string; args: string[] }[] = [
  { name: 'h264_1080p', size: '1920x1080', args: ['-c:v', 'libx264', '-profile:v', 'high', '-preset', 'fast', '-b:v', '20M', '-maxrate', '25M', '-bufsize', '50M', '-g', '250', '-pix_fmt', 'yuv420p'] },
  { name: 'h264_2160p', size: '3840x2160', args: ['-c:v', 'libx264', '-profile:v', 'high', '-preset', 'fast', '-b:v', '50M', '-maxrate', '60M', '-bufsize', '100M', '-g', '250', '-pix_fmt', 'yuv420p'] },
  { name: 'hevc10_1080p', size: '1920x1080', args: ['-c:v', 'libx265', '-preset', 'fast', '-b:v', '15M', '-x265-params', 'log-level=error:keyint=250', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1'] },
];

function clip(name: string): string | null {
  const dir = process.env.PREMATION_BENCH_CLIPS ?? path.join(os.tmpdir(), 'premation-bench-clips');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.mp4`);
  if (existsSync(file)) return file;
  const c = CLIPS.find((x) => x.name === name)!;
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
      `testsrc2=size=${c.size}:rate=30:duration=10,noise=alls=6:allf=t`, ...c.args, file], { stdio: 'ignore', timeout: 600_000 });
    return file;
  } catch {
    return null;
  }
}

describe('video + effects + tracking', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setupAppEngine({ gpu: true });
  }, 60_000);
  afterAll(async () => { await h.dispose(); });

  // PREMATION_BENCH_FILES=a.mp4,b.mov: the user's own footage instead of the generated clips.
  const files = process.env.PREMATION_BENCH_FILES?.split(',').filter(Boolean);
  const which = files ?? (process.env.PREMATION_BENCH_VIDEO ?? CLIPS.map((c) => c.name).join(',')).split(',');
  for (const entry of which) {
    const name = files ? path.basename(entry) : entry;
    it(`${name}: play, scrub, track, edit`, async () => {
      if (nativeEngineIsHeadless()) return;
      const file = files ? entry : clip(name);
      if (!file) {
        console.log(`[video] ${name}: no ffmpeg — skipped`);
        return;
      }
      // The clip's own length bounds the comp and the seeks (a long recording seeks far).
      let clipSecs = 10;
      try {
        clipSecs = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim()) || 10;
      } catch { /* no ffprobe: 10 s */ }
      const compSecs = Math.min(clipSecs, 600);
      const comp = activeCompRootId() as string;
      // PREMATION_BENCH_COMP=3840x2160@60: the comp size and rate (default 1920x1080@30).
      const [cw, ch, cfps] = (process.env.PREMATION_BENCH_COMP ?? '1920x1080@30').split(/[x@]/).map(Number) as [number, number, number];
      await h.run({ type: 'setCompositionSettings', comp, patch: { width: cw, height: ch, frameRate: { num: cfps, den: 1 }, duration: sec(compSecs) } } as Command);
      const items = (await h.run({ type: 'importFiles', files: [{ path: file, asSequence: false, createComposition: false }] } as Command)) as unknown as { items: string[] };
      const video = ((await h.run({ type: 'createLayer', comp, kind: 'video', source: items.items[0], init: [] } as Command)) as unknown as { layer: string }).layer;
      await settleEdits();
      await openMainViewport(h.client);

      const frames: { frame: number; at: number; ms: number; dropped: number }[] = [];
      const off = onSharedEngineFrames((f) => {
        if (f.type === 'frameReady') frames.push({ frame: f.frame, at: now(), ms: (f.renderDoneUs - f.renderStartUs) / 1000, dropped: f.dropped });
      });
      let phase = 'idle';
      let stats = { decodeMs: 0, gpuFrameMs: 0, cpuFrameMs: 0 };
      const finished = new Map<string, string>();
      const unsub = h.client.subscribe((b) => {
        for (const e of b.events) {
          if (e.type === 'transportChanged') phase = e.state;
          if (e.type === 'renderStatsUpdated') stats = { decodeMs: e.stats.decodeMs, gpuFrameMs: e.stats.gpuFrameMs, cpuFrameMs: e.stats.cpuFrameMs };
          if (e.type === 'jobFinished') { finished.set(e.job.id, e.job.status); if (e.error) console.log('[video] job error', e.job.kind, JSON.stringify(e.error).slice(0, 400), e.job.message); }
        }
      });
      const log = (what: string, o: Record<string, unknown>): void => console.log(`[video] ${JSON.stringify({ clip: name, what, ...o })}`);

      /** Play `secs` from 0 once; frames, drops, fps, frame times, UI latency. */
      const play = async (label: string, secs: number): Promise<void> => {
        await h.run({ type: 'seek', time: 0, mode: 'exact' } as Command);
        await sleep(300);
        frames.length = 0;
        await h.run({ type: 'setLoop', mode: 'once' } as Command);
        const t0 = now();
        await h.run({ type: 'play', rate: 1, range: 'custom', custom: { start: 0, duration: sec(secs) }, audio: false, cacheFirst: false, cacheOnly: false } as Command);
        const ui: number[] = [];
        await sleep(100);
        while (phase !== 'stopped' && now() - t0 < 60_000) {
          const q0 = now();
          await h.query({ type: 'getHistory' });
          ui.push(now() - q0);
          await sleep(25);
        }
        const shown = frames.filter((f) => f.at >= t0);
        const span = shown.length > 1 ? (shown[shown.length - 1]!.at - shown[0]!.at) / 1000 : 1;
        const gaps = shown.slice(1).map((f, i) => f.at - shown[i]!.at);
        log(label, {
          frames: shown.length, of: Math.round(secs * 30), dropped: shown.reduce((n, f) => n + f.dropped, 0),
          fps: r1(shown.length / span), gapP95Ms: r1(pct(gaps, 0.95)), worstGapMs: r1(Math.max(0, ...gaps)),
          renderP50Ms: r1(pct(shown.map((f) => f.ms), 0.5)), decodeMs: r1(stats.decodeMs), cpuFrameMs: r1(stats.cpuFrameMs),
          uiP95Ms: r1(pct(ui, 0.95)), uiWorstMs: r1(Math.max(0, ...ui)),
        });
      };

      /** Seek to random frames: when a frame for it is first shown (a nearest
       *  decoded stand-in may come first), and when it settles (the last
       *  redraw of that frame — the exact decode — with 400 ms quiet after it). */
      const scrub = async (label: string, mode: 'scrub' | 'exact'): Promise<void> => {
        const first: number[] = [];
        const settled: number[] = [];
        let seed = 7;
        for (let i = 0; i < 16; i++) {
          seed = (seed * 48271) % 2147483647;
          const f = 15 + (seed % Math.max(1, Math.floor(compSecs * 30) - 30));
          const t0 = now();
          frames.length = 0;
          await h.run({ type: 'seek', time: Math.round(f * sec(1) / 30), mode } as Command);
          while (!frames.some((x) => x.frame === f) && now() - t0 < 5000) await sleep(2);
          first.push(now() - t0);
          let last = frames.filter((x) => x.frame === f).pop()?.at ?? now();
          while (now() - last < 400 && now() - t0 < 8000) {
            await sleep(10);
            last = frames.filter((x) => x.frame === f).pop()?.at ?? last;
          }
          settled.push(last - t0);
        }
        log(label, {
          seeks: first.length, firstP50Ms: r1(pct(first, 0.5)), firstP95Ms: r1(pct(first, 0.95)),
          settledP50Ms: r1(pct(settled, 0.5)), settledP95Ms: r1(pct(settled, 0.95)), settledWorstMs: r1(Math.max(...settled)),
        });
      };

      await play('play plain (first pass)', 3);
      await scrub('scrub plain', 'scrub');

      // The effect stack an editor puts on footage, and a title riding a track.
      const fx = await runToolTurn('bench: grade + fx', [
        { name: 'add_effect', args: { nodeId: video, type: 'curves' } },
        { name: 'add_effect', args: { nodeId: video, type: 'gaussian-blur', params: { blurriness: 6 } } },
        { name: 'add_effect', args: { nodeId: video, type: 'glow' } },
        { name: 'add_effect', args: { nodeId: video, type: 'turbulent-displace' } },
        { name: 'add_effect', args: { nodeId: video, type: 'vignette' } },
        { name: 'create_layer', args: { id: 'title', kind: 'text', name: 'Tracked title', text: 'TRACKED', x: 960, y: 540 } },
        { name: 'update_layer', args: { nodeId: 'title', fontSize: 90, fill: '#ffffff' } },
        { name: 'add_effect', args: { nodeId: 'title', type: 'drop-shadow' } },
      ]);
      const failed = fx.results.filter((x) => !x.ok).map((x) => x.content);
      if (failed.length) console.log('[video] tool failures', failed.slice(0, 5));
      await settleEdits();
      // Tool ids are the turn's own: the title by name from here on.
      const m = documentMirror();
      const title = m.layerIds().find((x) => m.layer(x)?.name === 'Tracked title')!;

      // Motion tracking: one point, 3 s forward, while the UI keeps asking.
      const job = (await h.run({ type: 'startJob', apply: false, job: { kind: 'trackMotion', value: {
        layer: video, kind: 'position', direction: 'forward', stabilize: false, excludeMasks: [], range: { start: 0, duration: sec(3) },
        points: [{ feature: { x: 960, y: 540, width: 31, height: 31 }, search: { x: 960, y: 540, width: 91, height: 91 }, attach: { x: 960, y: 540 } }],
      } } } as Command)) as unknown as { job: string };
      const tj = now();
      const ui: number[] = [];
      while (!finished.has(job.job) && now() - tj < 300_000) {
        const q0 = now();
        await h.query({ type: 'getHistory' });
        ui.push(now() - q0);
        await sleep(25);
      }
      log('track 90 frames', { ms: r1(now() - tj), status: finished.get(job.job) ?? 'timeout', fps: r1(90 / ((now() - tj) / 1000)), uiP95Ms: r1(pct(ui, 0.95)), uiWorstMs: r1(Math.max(0, ...ui)) });

      // The title follows a track: 90 position keys.
      const keys = Array.from({ length: 90 }, (_, i) => ({ nodeId: title, prop: 'x', t: i / 30, value: 960 + Math.sin(i / 9) * 300 }));
      const k = await runToolTurn('bench: track keys', [{ name: 'set_keyframes', args: { keyframes: keys } }]);
      if (!k.results.every((x) => x.ok)) console.log('[video] keys failed', k.results.map((x) => String(x.content).slice(0, 200)));
      await settleEdits();

      await play('play fx (first pass)', 3);
      await play('play fx (second pass)', 3);
      await scrub('scrub fx', 'scrub');
      await scrub('seek fx exact', 'exact');

      // An effect tweak while paused: edit → its frame on screen.
      const edits: number[] = [];
      for (let i = 0; i < 8; i++) {
        const t0 = now();
        frames.length = 0;
        const before = frames.length;
        const tw = await runToolTurn('bench: tweak', [{ name: 'update_layer', args: { nodeId: title, fontSize: 91 + i } }]);
        if (!tw.results.every((x) => x.ok)) console.log('[video] tweak failed', tw.results.map((x) => String(x.content).slice(0, 200)));
        while (frames.length === before && now() - t0 < 5000) await sleep(2);
        edits.push(now() - t0);
      }
      log('edit → frame', { p50Ms: r1(pct(edits, 0.5)), worstMs: r1(Math.max(...edits)) });

      off();
      unsub();
      await h.run({ type: 'newProject' } as Command);
      await settleEdits();
    }, 600_000);
  }
});
