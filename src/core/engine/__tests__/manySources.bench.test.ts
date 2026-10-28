/**
 * Many sources on the GPU engine: 150 video layers, each on its OWN source
 * file, laid end to end on a 5-minute 30 fps timeline — a multicam / b-roll
 * edit, where what the engine holds per source (decoder, probe, thread,
 * cache) is multiplied by the clip count. Printed, one `[sources] {json}`
 * line each:
 *
 *   media   the clips (generated once with ffmpeg: 2 s, 320×180, H.264,
 *           a different hue each, reused on the next run)
 *   open    importFiles of every clip + one layer per clip (wall ms)
 *   scrub   seek → frameReady at 10 points across the timeline (a different
 *           clip each): wall ms per point, p50 / max
 *   process the engine process after the scrub: its own memory
 *           (getRenderStats engineMemoryBytes) and its thread count read
 *           from the OS (PowerShell Get-Process on Windows, /proc on Linux,
 *           ps on macOS)
 *
 * Recorded for the ratchet as `manySources/150clips-5min`.
 *
 *   PREMATION_BENCH_CLIPS=<n>           clip / layer count (default 150)
 *   PREMATION_BENCH_MEDIA_DIR=<dir>     where the clips live (default
 *                                       native/build/media-clips/many-sources, git-ignored)
 *   FFMPEG=<exe>                        the ffmpeg to generate them with (default: the
 *                                       copy scripts/fetchFfmpeg.cjs cached under
 *                                       build/.cache/ffmpeg, else `ffmpeg` on PATH)
 *
 * Skips (printing why) when the engine is not built or no ffmpeg can make
 * the clips. Run with the bench jest config — the default suite ignores
 * `*.bench.test.ts`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ProcessEngineClient, secondsToFlicks, unwrap } from '@motion/engine-api';
import type { EngineFrameMessage } from '../../../../electron/engineFraming';
import { recordBench } from '../../perf/bench/benchRecord';
import { nativeEngineExe, startNativeEngine } from '../__testHelpers__/nativeEngine';

type FrameReady = Extract<EngineFrameMessage, { type: 'frameReady' }>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function pct(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
}

const REPO = path.resolve(__dirname, '../../../..');
const CLIPS = Number(process.env.PREMATION_BENCH_CLIPS ?? '150');
const CLIP_SECONDS = 2;
const FPS = 30;
const POINTS = 10;
const SCENARIO = `manySources/${CLIPS}clips-${Math.round((CLIPS * CLIP_SECONDS) / 60)}min`;
const MEDIA_DIR = process.env.PREMATION_BENCH_MEDIA_DIR ?? path.join(REPO, 'native', 'build', 'media-clips', 'many-sources');

/** The ffmpeg to generate clips with, or null when none runs. */
function findFfmpeg(): string | null {
  const candidates = [
    process.env.FFMPEG,
    path.join(REPO, 'build', '.cache', 'ffmpeg', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    'ffmpeg',
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    const r = spawnSync(c, ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) return c;
  }
  return null;
}

/**
 * The clip files, generating the missing ones: testsrc2 (sharp edges, moving
 * text) at a per-clip hue so no two sources are the same picture; tiny, so
 * decode is not what this bench measures.
 */
function ensureClips(ffmpeg: string): { files: string[]; generated: number; ms: number } {
  mkdirSync(MEDIA_DIR, { recursive: true });
  const files: string[] = [];
  let generated = 0;
  const t0 = performance.now();
  for (let i = 0; i < CLIPS; i++) {
    const file = path.join(MEDIA_DIR, `clip-${String(i).padStart(3, '0')}.mp4`);
    files.push(file);
    if (existsSync(file)) continue;
    const hue = Math.round((i * 360) / Math.max(1, CLIPS));
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=s=320x180:r=${FPS}:d=${CLIP_SECONDS},hue=h=${hue},format=yuv420p`,
      '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', String(FPS),
      file,
    ];
    const r = spawnSync(ffmpeg, args, { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    if (r.status !== 0) throw new Error(`ffmpeg failed on ${file} (${ffmpeg} ${args.join(' ')})`);
    generated += 1;
  }
  return { files, generated, ms: performance.now() - t0 };
}

/** The engine process's thread count from the OS; -1 when the platform gives none. */
function threadCount(pid: number): number {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).Threads.Count`], { encoding: 'utf8', windowsHide: true });
      return Number(out.trim());
    }
    if (process.platform === 'linux') {
      const m = /^Threads:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
      return m ? Number(m[1]) : -1;
    }
    const out = execFileSync('ps', ['-M', '-p', String(pid)], { encoding: 'utf8' });
    return Math.max(0, out.trim().split('\n').length - 1);
  } catch {
    return -1;
  }
}

describe('many sources: 150 video layers on 150 clips', () => {
  it('opens them, scrubs across the timeline and reports the engine process after', async () => {
    if (!nativeEngineExe()) {
      console.log('[sources] premation-engine is not built');
      return;
    }
    const ffmpeg = findFfmpeg();
    if (!ffmpeg) {
      console.log('[sources] no ffmpeg to generate the clips (set FFMPEG=<exe> or run scripts/fetchFfmpeg.cjs)');
      return;
    }
    const media = ensureClips(ffmpeg);
    console.log('[sources] ' + JSON.stringify({ step: 'media', dir: MEDIA_DIR, clips: media.files.length, generated: media.generated, generateMs: Number(media.ms.toFixed(0)) }));

    const native = await startNativeEngine({ extraArgs: ['--log-level', 'warn'] });
    const client = new ProcessEngineClient(native.bridge);
    const waiters = new Set<(m: FrameReady) => void>();
    native.supervisor.on('frame', (m: EngineFrameMessage) => {
      if (m.type !== 'frameReady') return;
      native.supervisor.releaseSlot(m.generation, m.slot);
      for (const w of [...waiters]) w(m);
    });
    const nextFrame = (pred: (m: FrameReady) => boolean, timeoutMs = 120_000): Promise<FrameReady | null> =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(on);
          resolve(null);
        }, timeoutMs);
        const on = (m: FrameReady): void => {
          if (!pred(m)) return;
          clearTimeout(timer);
          waiters.delete(on);
          resolve(m);
        };
        waiters.add(on);
      });
    const metrics: Parameters<typeof recordBench>[0] = [];
    const metric = (name: string, unit: 'ms' | 'fps' | 'count', value: number, samples = 1): void => {
      metrics.push({ name: SCENARIO, metric: name, unit, value, samples });
    };
    try {
      // ── open: import every clip, one layer each, end to end ──────────────
      const duration = CLIPS * CLIP_SECONDS;
      const t0 = performance.now();
      await client.execute({ type: 'newProject' });
      const doc = unwrap(await client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
      const comp = doc.comps[0]!.id;
      await client.execute({
        type: 'setCompositionSettings',
        comp,
        patch: { frameRate: { num: FPS, den: 1 }, duration: secondsToFlicks(duration), width: 1920, height: 1080 },
      });
      await client.execute({ type: 'setActiveComposition', comp });
      const ti = performance.now();
      const items = unwrap(await client.execute({
        type: 'importFiles',
        files: media.files.map((p) => ({ path: p, asSequence: false, createComposition: false })),
      })).items;
      const importMs = performance.now() - ti;
      expect(items.length).toBe(CLIPS);
      const tl = performance.now();
      for (let i = 0; i < items.length; i++) {
        await client.execute({
          type: 'createLayer', comp, kind: 'video', name: `V${i}`, source: items[i]!, startTime: secondsToFlicks(i * CLIP_SECONDS),
          init: [{ path: 'transform/scale', value: { kind: 'vec2', value: { x: 600, y: 600 } } }],
        });
      }
      const layersMs = performance.now() - tl;
      const openMs = performance.now() - t0;
      console.log('[sources] ' + JSON.stringify({ step: 'open', wallMs: Number(openMs.toFixed(0)), importMs: Number(importMs.toFixed(0)), createLayersMs: Number(layersMs.toFixed(0)), clips: CLIPS }));
      metric('open.wall', 'ms', Number(openMs.toFixed(1)));
      metric('open.import', 'ms', Number(importMs.toFixed(1)));

      // ── scrub: 10 points, each inside a different clip ────────────────────
      const firstGot = nextFrame(() => true);
      await client.execute({
        type: 'setViewport',
        viewport: 1, width: 1920, height: 1080, devicePixelRatio: 1, zoom: 1,
        pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false,
        displayTransform: '', layerRenderEffects: true,
      });
      await client.execute({ type: 'setPreviewQuality', resolution: 'full', fastPreview: 'off', draft3d: false, motionBlur: false, adaptiveFloor: 'full' });
      expect(await firstGot).not.toBeNull();
      const seeks: number[] = [];
      for (let k = 0; k < POINTS; k++) {
        // Half a second into clip k·(CLIPS/POINTS): never the first frame of a clip or of the comp.
        const seconds = Math.floor((k * CLIPS) / POINTS) * CLIP_SECONDS + 0.5;
        const frame = Math.round(seconds * FPS);
        const got = nextFrame((m) => m.frame === frame);
        const ts = performance.now();
        await client.execute({ type: 'seek', time: Math.round((frame / FPS) * 705_600_000), mode: 'exact' });
        const m = await got;
        const wallMs = performance.now() - ts;
        seeks.push(wallMs);
        const stats = unwrap(await client.query({ type: 'getRenderStats' }));
        console.log('[sources] ' + JSON.stringify({
          step: 'scrub', point: k, seconds, frame, wallMs: Number(wallMs.toFixed(1)),
          drawMs: m ? Number(((m.renderDoneUs - m.renderStartUs) / 1000).toFixed(2)) : -1,
          buildMs: Number(stats.cpuFrameMs.toFixed(1)), decodeMs: Number(stats.decodeMs.toFixed(1)),
        }));
        expect(m).not.toBeNull();
      }
      await sleep(500);
      const stats = unwrap(await client.query({ type: 'getRenderStats' }));
      const pid = native.pid();
      const threads = pid ? threadCount(pid) : -1;
      const line = {
        step: 'process',
        seekP50Ms: Number(pct(seeks, 0.5).toFixed(1)),
        seekMaxMs: Number(Math.max(...seeks).toFixed(1)),
        engineMemoryMB: stats.engineMemoryBytes !== undefined ? Number((stats.engineMemoryBytes / 1048576).toFixed(1)) : null,
        ramCacheMB: Number((stats.ramCacheBytes / 1048576).toFixed(1)),
        vramMB: Number((stats.vramBytes / 1048576).toFixed(1)),
        threads,
      };
      console.log('[sources] ' + JSON.stringify(line));
      metric('scrub.p50', 'ms', line.seekP50Ms, seeks.length);
      metric('scrub.max', 'ms', line.seekMaxMs, seeks.length);
      if (line.engineMemoryMB !== null) metric('engineMemory.MB', 'count', line.engineMemoryMB, 0);
      metric('threads', 'count', threads, 0);
    } finally {
      await native.stop();
      if (metrics.length > 0) recordBench(metrics);
    }
  }, 300_000);
});
