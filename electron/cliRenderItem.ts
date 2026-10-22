/**
 * `premation render-item <pack-dir>` — the main-process half: the engine
 * process, the pack's files, ffmpeg. The pack is laid into a new document by
 * the Library's own interpreters, which live in the renderer sources
 * (src/core/library/premium/renderItem.ts); electron/ is its own TypeScript
 * project and cannot import them, so they arrive as one bundle built by
 * scripts/buildRenderItem.cjs (`npm run electron:compile`) and are required at
 * run time. The contract between the halves is `RenderItemModule` below, kept
 * small enough to read beside the renderer's.
 *
 * Writes the card's loop (H.264 .mp4, faststart) and its still (.webp at the
 * rest frame). Fails — nothing kept — when the pack does not parse, a layer
 * records an error, or ffmpeg refuses.
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { CliRenderItemJob } from './cliArgs';
import { EngineGoneError } from './engineTransport';
import { EngineSupervisor, type EngineChild } from './engineSupervisor';

/** The bridge shape `ProcessEngineClient` reads (@motion/engine-api EngineBridge). */
interface ItemBridge {
  request(bytes: Uint8Array): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: 'gone' | 'invalid'; message: string }>;
  status(): Promise<{ enabled: boolean; state: string; engine?: string; engineVersion?: string; revision?: number }>;
  onEvents(h: (bytes: Uint8Array) => void): () => void;
  onState(h: (s: string) => void): () => void;
  onRestarted(h: (i: unknown) => void): () => void;
  onUnavailable(h: (i: { reason: string; fatal: boolean; logTail?: string[] }) => void): () => void;
}

/** What the bundle exports (src/core/library/premium/renderItem.ts). */
interface RenderItemModule {
  renderItem(
    input: { meta: Uint8Array; payload: Uint8Array; card: { bytes: Uint8Array; mime: string; width: number; height: number }; size: number; fps: number; posterTime?: number },
    bridge: ItemBridge,
    sink: { frame(i: number, bytes: Uint8Array, format: string): Promise<void>; log?(m: string): void; progress?(f: number): void },
  ): Promise<{
    id: string; kind: string; frames: number; width: number; height: number; durationSec: number; posterTime: number;
    poster: { bytes: Uint8Array; format: string };
    layerErrors: Array<{ layer: string; stage: string; message: string }>;
  }>;
}

export interface RenderItemDeps {
  enginePath: string | null;
  ffmpegPath: string;
  /** build/cli/render-item.cjs. */
  bundlePath: string;
  /** The fonts the app ships (resources/fonts): the demo card's type. */
  fontsDir: string;
  /** Variables for the engine (the bundled fonts manifest, PREMATION_FFMPEG). */
  engineEnv: Record<string, string>;
  log(message: string): void;
  progress(fraction: number): void;
}

export type RenderItemOutcome =
  | { kind: 'done'; id: string; itemKind: string; frames: number; width: number; height: number; fps: number; durationSec: number; posterTime: number }
  | { kind: 'failed'; message: string };

const CARD = { width: 1280, height: 720 };

/** A path inside an ffmpeg filter argument (`:` and `\` escaped, quoted). */
const filterPath = (p: string): string => `'${p.replace(/\\/g, '/').replace(/:/g, '\\:')}'`;

/**
 * The demo card a transition plays on: a graded plate with grain, a hairline
 * grid, a headline and a caption — detail, so blurs, splits, wipes and pushes
 * read on it the way they will on a real shot.
 */
function demoCard(ffmpeg: string, fontsDir: string): Uint8Array {
  const { width: w, height: h } = CARD;
  const display = path.join(fontsDir, 'Anton-Regular.ttf');
  const body = path.join(fontsDir, 'Inter-opsz-wght.ttf');
  const type = existsSync(display) && existsSync(body)
    ? [
        `drawtext=fontfile=${filterPath(display)}:text='NEW SEASON':fontsize=168:fontcolor=white:x=88:y=h-th-150`,
        `drawtext=fontfile=${filterPath(body)}:text='PREMATION  ·  DEMO CARD  ·  01':fontsize=26:fontcolor=white@0.85:x=92:y=h-112`,
        `drawtext=fontfile=${filterPath(body)}:text='24 — 10':fontsize=26:fontcolor=white@0.85:x=w-tw-88:y=72`,
      ]
    : [];
  const filter = [
    `gradients=s=${w}x${h}:c0=0x0b1a3a:c1=0x2c5ce6:c2=0xff7a4d:c3=0xffd9a8:nb_colors=4:seed=11:x0=0:y0=${h}:x1=${w}:y1=0`,
    'format=yuv444p', 'noise=alls=8:allf=t', 'vignette=PI/4.2', 'format=rgb24',
    'drawgrid=w=80:h=80:t=1:c=white@0.12',
    `drawbox=x=88:y=72:w=64:h=6:color=white@0.95:t=fill`,
    `drawbox=x=0:y=0:w=${w}:h=${h}:color=white@0.35:t=2`,
    ...type,
  ].join(',');
  return new Uint8Array(execFileSync(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', filter, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-'], { maxBuffer: 64 * 1024 * 1024 }));
}

function startEngine(exe: string, env: Record<string, string>): { supervisor: EngineSupervisor; bridge: ItemBridge } {
  const supervisor = new EngineSupervisor(
    {
      spawn: (file, args) => spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...env } }) as unknown as EngineChild,
      resolveExe: () => exe,
      gpuVendor: async () => undefined,
      hostPid: process.pid,
      hello: { client: 'premation-cli', clientVersion: '0', capabilities: [] },
    },
    // A card renders a few hundred frames back to back: generous hang limits.
    { hangMs: 120_000, stuckMs: 300_000 },
  );
  const bridge: ItemBridge = {
    request: async (bytes) => {
      try {
        return { ok: true, bytes: await supervisor.request(Uint8Array.from(bytes)) };
      } catch (e) {
        return { ok: false, reason: e instanceof EngineGoneError ? 'gone' : 'invalid', message: e instanceof Error ? e.message : String(e) };
      }
    },
    status: async () => {
      const w = supervisor.welcome;
      return { enabled: true, state: supervisor.state, ...(w ? { engine: w.engine, engineVersion: w.engineVersion, revision: w.revision } : {}) };
    },
    onEvents: (h) => supervisor.on('events', (b) => h(b.bytes)),
    onState: (h) => supervisor.on('state', (s) => h(String(s))),
    onRestarted: (h) => supervisor.on('engine-restarted', (i) => h(i)),
    onUnavailable: (h) => supervisor.on('unavailable', (i) => h({ reason: i.reason, fatal: i.fatal, logTail: i.logTail })),
  };
  return { supervisor, bridge };
}

/** An ffmpeg reading encoded frames on stdin. Resolves when it has written `out`. */
function encoder(ffmpeg: string, args: string[]): { proc: ChildProcess; done: Promise<void> } {
  const proc = spawn(ffmpeg, ['-y', '-loglevel', 'error', ...args], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let err = '';
  proc.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
  const done = new Promise<void>((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.trim().slice(-400)}`))));
  });
  return { proc, done };
}

function write(proc: ChildProcess, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!proc.stdin) return reject(new Error('ffmpeg has no stdin'));
    proc.stdin.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), (e) => (e ? reject(e) : resolve()));
  });
}

const codecOf = (format: string): string => (/jpe?g/i.test(format) ? 'mjpeg' : 'png');

/** Render one pack's card media. Never rejects. */
export async function runRenderItem(job: CliRenderItemJob, deps: RenderItemDeps): Promise<RenderItemOutcome> {
  const metaPath = path.join(job.packDir, 'meta.json');
  const payloadPath = path.join(job.packDir, 'payload.json');
  if (!existsSync(metaPath) || !existsSync(payloadPath)) return { kind: 'failed', message: `"${job.packDir}" is not a pack: it needs meta.json and payload.json.` };
  if (!deps.enginePath) return { kind: 'failed', message: 'premation-engine is not available (reinstall Premation).' };
  if (!existsSync(deps.bundlePath)) return { kind: 'failed', message: `The render-item bundle is missing at "${deps.bundlePath}" — run "npm run electron:compile".` };
  // A runtime-built bundle (see the file header).
  const mod = require(deps.bundlePath) as RenderItemModule;

  let card: Uint8Array;
  try {
    card = demoCard(deps.ffmpegPath, deps.fontsDir);
  } catch (e) {
    return { kind: 'failed', message: `ffmpeg could not make the demo card: ${(e as Error).message}` };
  }
  const tmpOut = `${job.outPath}.partial.mp4`;
  const tmpPoster = `${job.posterPath}.partial.webp`;
  const { supervisor, bridge } = startEngine(deps.enginePath, deps.engineEnv);
  let enc: ReturnType<typeof encoder> | null = null;
  try {
    await supervisor.start();
    if (supervisor.state !== 'running') return { kind: 'failed', message: `premation-engine did not start (${supervisor.state}).` };
    const result = await mod.renderItem(
      { meta: readFileSync(metaPath), payload: readFileSync(payloadPath), card: { bytes: card, mime: 'image/png', ...CARD }, size: job.size, fps: job.fps, ...(job.posterTime !== undefined ? { posterTime: job.posterTime } : {}) },
      bridge,
      {
        frame: async (_i, bytes, format) => {
          enc ??= encoder(deps.ffmpegPath, [
            '-f', 'image2pipe', '-framerate', String(job.fps), '-c:v', codecOf(format), '-i', '-',
            '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
            '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-an', '-f', 'mp4', tmpOut,
          ]);
          await write(enc.proc, bytes);
        },
        log: deps.log,
        progress: deps.progress,
      },
    );
    if (!enc) return { kind: 'failed', message: 'the item rendered no frames' };
    const e = enc as ReturnType<typeof encoder>;
    e.proc.stdin?.end();
    await e.done;
    if (result.layerErrors.length > 0) {
      const first = result.layerErrors.slice(0, 4).map((x) => `${x.stage}: ${x.message}`).join('; ');
      return { kind: 'failed', message: `${result.id}: ${result.layerErrors.length} layer error(s) — ${first}` };
    }
    const still = encoder(deps.ffmpegPath, ['-f', 'image2pipe', '-c:v', codecOf(result.poster.format), '-i', '-', '-c:v', 'libwebp', '-quality', '86', '-f', 'webp', tmpPoster]);
    await write(still.proc, result.poster.bytes);
    still.proc.stdin?.end();
    await still.done;
    // Temp file + rename: a failed run never leaves a half card in the pack.
    renameSync(tmpOut, job.outPath);
    renameSync(tmpPoster, job.posterPath);
    return { kind: 'done', id: result.id, itemKind: result.kind, frames: result.frames, width: result.width, height: result.height, fps: job.fps, durationSec: result.durationSec, posterTime: result.posterTime };
  } catch (e) {
    return { kind: 'failed', message: e instanceof Error ? e.message : String(e) };
  } finally {
    const open = enc as ReturnType<typeof encoder> | null;
    if (open && open.proc.exitCode === null) open.proc.kill();
    rmSync(tmpOut, { force: true });
    rmSync(tmpPoster, { force: true });
    await supervisor.stop().catch(() => undefined);
  }
}
