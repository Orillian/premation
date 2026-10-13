/**
 * The main-process owner of "can this app export video": one cached health
 * status (electron/ffmpegHealth.ts), one repair at a time
 * (electron/ffmpegRepair.ts), the person's own choice of ffmpeg, and the IPC
 * the renderer's repair dialog talks to (src/stores/ffmpegStore.ts).
 *
 *   ffmpeg:status     (force?)  → FfmpegStatusView      cached unless forced
 *   ffmpeg:repair               → FfmpegRepairResult    joins a running repair
 *   ffmpeg:cancelRepair
 *   ffmpeg:chooseFile           → FfmpegRepairResult    an ffmpeg executable, or the pinned zip downloaded elsewhere
 *   ffmpeg:clearChoice          → FfmpegStatusView
 *   push ffmpeg:statusChanged   FfmpegStatusView
 *   push ffmpeg:repairProgress  RepairProgress
 *
 * Export asks `ensure()` before it renders (electron/exportProcess.ts), so a
 * broken ffmpeg is reported in seconds with a Fix button instead of after the
 * whole render.
 */

import { app, BrowserWindow, dialog, net } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { bundledFfmpegPath, ffmpegToolsDir, repairedFfmpegPath, setVerifiedFfmpeg } from './ffmpegBinary';
import { checkFfmpeg, probeCandidate, type FfmpegCandidate, type FfmpegStatus } from './ffmpegHealth';
import { installFromArchive, pinnedBuild, repairFfmpeg, RepairError, type RepairDeps, type RepairErrorCode, type RepairProgress } from './ffmpegRepair';
import { handle } from './ipcGuard';

export interface FfmpegStatusView extends FfmpegStatus {
  repairing: boolean;
  /** Where the pinned archive downloads from. */
  downloadUrl?: string;
}

export type FfmpegRepairResult =
  | { ok: true; status: FfmpegStatusView }
  | { ok: false; code: RepairErrorCode | 'not-ffmpeg'; detail: string; neededBytes?: number; status: FfmpegStatusView };

const STATUS_CHANNEL = 'ffmpeg:statusChanged';
const PROGRESS_CHANNEL = 'ffmpeg:repairProgress';

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send(channel, payload);
  }
}

async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

export class FfmpegService {
  private status: FfmpegStatus | null = null;
  private checking: Promise<FfmpegStatus> | null = null;
  private repairing: Promise<FfmpegRepairResult> | null = null;
  private repairAbort: AbortController | null = null;

  constructor(private readonly userData: () => string, private readonly log: (m: string) => void = (m) => console.log(`[ffmpeg] ${m}`)) {}

  private get dir(): string {
    return ffmpegToolsDir(this.userData());
  }

  private readChoice(): string | null {
    try {
      const raw = JSON.parse(readFileSync(path.join(this.dir, 'choice.json'), 'utf8')) as { path?: unknown };
      return typeof raw.path === 'string' && raw.path ? raw.path : null;
    } catch {
      return null;
    }
  }

  private async writeChoice(bin: string | null): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(path.join(this.dir, 'choice.json'), JSON.stringify(bin ? { path: bin } : {}));
  }

  private candidates(): FfmpegCandidate[] {
    const out: FfmpegCandidate[] = [];
    const override = process.env.FFMPEG_PATH;
    if (override) out.push({ source: 'override', path: override });
    const chosen = this.readChoice();
    if (chosen) out.push({ source: 'chosen', path: chosen });
    // Development has no bundled copy; trying it would only report a "missing" nobody can fix.
    if (app.isPackaged) out.push({ source: 'bundled', path: bundledFfmpegPath(process.resourcesPath ?? '', process.platform) });
    const repaired = repairedFfmpegPath(this.userData(), process.platform, process.arch);
    if (repaired && existsSync(repaired)) out.push({ source: 'repaired', path: repaired });
    out.push({ source: 'system', path: 'ffmpeg' });
    return out;
  }

  private view(repairing: boolean = this.repairing !== null): FfmpegStatusView {
    const build = pinnedBuild(process.platform, process.arch);
    const s = this.status ?? { ok: false, canRepair: build !== null, checkedAt: 0 };
    // The link is shown so someone on a network that blocks it can fetch the
    // same file on another device and pick it with "Choose file…" (hash-checked).
    return { ...s, repairing, ...(build ? { downloadUrl: build.urls[0] } : {}) };
  }

  /** Run the health check (once at a time) and publish the result. */
  check(): Promise<FfmpegStatus> {
    if (this.checking) return this.checking;
    const build = pinnedBuild(process.platform, process.arch);
    this.checking = checkFfmpeg({
      candidates: () => this.candidates(),
      spawn,
      exists: existsSync,
      repairBytes: build ? build.bytes : null,
      log: this.log,
    }).then(({ status }) => {
      this.status = status;
      setVerifiedFfmpeg(status.active?.path ?? null);
      broadcast(STATUS_CHANNEL, this.view());
      return status;
    }).finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  async getStatus(force = false): Promise<FfmpegStatusView> {
    if (force || !this.status) await this.check();
    return this.view();
  }

  /**
   * Before an export: the cached answer while its copy is still on disk,
   * otherwise a fresh check. A failed answer is always re-checked — the person
   * may have just fixed it outside the app.
   */
  async ensure(): Promise<FfmpegStatus> {
    const s = this.status;
    if (s?.ok && s.active && (s.active.path === 'ffmpeg' || existsSync(s.active.path))) return s;
    return this.check();
  }

  private repairDeps(signal: AbortSignal): RepairDeps {
    return {
      userDataPath: this.userData(),
      platform: process.platform,
      arch: process.arch,
      // Chromium's network stack: the system proxy (incl. PAC) and certificate store, like a browser download.
      fetch: (url, init) => net.fetch(url, { headers: init.headers, signal: init.signal, cache: 'no-store' }),
      freeBytes: async (dir) => {
        const s = await statfs(dir);
        return Number(s.bavail) * Number(s.bsize);
      },
      verify: (bin) => probeCandidate({ source: 'repaired', path: bin }, { spawn, exists: existsSync, timeoutMs: 60_000 }),
      onProgress: (p: RepairProgress) => broadcast(PROGRESS_CHANNEL, p),
      signal,
      log: this.log,
    };
  }

  private async failed(err: unknown): Promise<FfmpegRepairResult> {
    const e = err instanceof RepairError ? err : new RepairError('corrupted', String((err as Error)?.message ?? err));
    this.log(`repair failed: ${e.code} — ${e.detail}`);
    return { ok: false, code: e.code, detail: e.detail, ...(e.neededBytes ? { neededBytes: e.neededBytes } : {}), status: this.view() };
  }

  /** Download and install the pinned build. A second call while one runs joins it. */
  repair(): Promise<FfmpegRepairResult> {
    if (this.repairing) return this.repairing;
    const ctrl = new AbortController();
    this.repairAbort = ctrl;
    const run = (async (): Promise<FfmpegRepairResult> => {
      try {
        const installed = await repairFfmpeg(this.repairDeps(ctrl.signal));
        this.log(`repaired: ${installed}`);
        // A broken choice of the person's own would still win the order: the repair is the answer now.
        if (this.readChoice()) await this.writeChoice(null).catch(() => undefined);
        await this.check();
        return { ok: true as const, status: this.view(false) };
      } catch (err) {
        return this.failed(err);
      }
    })().finally(() => {
      this.repairing = null;
      this.repairAbort = null;
      broadcast(STATUS_CHANNEL, this.view());
    });
    this.repairing = run;
    broadcast(STATUS_CHANNEL, this.view());
    return run;
  }

  cancelRepair(): void {
    this.repairAbort?.abort();
  }

  /**
   * "I have ffmpeg already" / "I downloaded it on another computer": an
   * executable (checked by running it), or the pinned zip (checked by hash).
   */
  async chooseFile(win: BrowserWindow | null): Promise<FfmpegRepairResult | null> {
    const exe = process.platform === 'win32' ? ['exe', 'zip'] : [];
    const opts = {
      title: 'Choose FFmpeg',
      properties: ['openFile' as const],
      filters: exe.length ? [{ name: 'FFmpeg (ffmpeg.exe or the downloaded .zip)', extensions: exe }, { name: 'All files', extensions: ['*'] }] : [],
    };
    const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const file = picked.canceled ? undefined : picked.filePaths[0];
    if (!file) return null;
    if (file.toLowerCase().endsWith('.zip')) {
      const build = pinnedBuild(process.platform, process.arch);
      if (!build) return { ok: false, code: 'unsupported', detail: `no ffmpeg is published for ${process.platform}-${process.arch}`, status: this.view() };
      if ((await sha256File(file)) !== build.sha256) {
        return { ok: false, code: 'not-ffmpeg', detail: 'that .zip is not the FFmpeg download Premation expects (its SHA-256 differs)', status: this.view() };
      }
      try {
        await installFromArchive(file, build, this.repairDeps(new AbortController().signal));
      } catch (err) {
        return this.failed(err);
      }
      await this.writeChoice(null).catch(() => undefined);
      await this.check();
      return { ok: true, status: this.view(false) };
    }
    const result = await probeCandidate({ source: 'chosen', path: file }, { spawn, exists: existsSync, timeoutMs: 60_000 });
    if (!result.runs) {
      return { ok: false, code: 'not-ffmpeg', detail: `that file does not run as FFmpeg (${result.code}${result.detail ? `: ${result.detail}` : ''})`, status: this.view() };
    }
    await this.writeChoice(file);
    await this.check();
    return { ok: true, status: this.view(false) };
  }

  async clearChoice(): Promise<FfmpegStatusView> {
    await this.writeChoice(null);
    await this.check();
    return this.view();
  }
}

/** The app's one instance: main registers its IPC; export asks it before rendering. */
export const ffmpegService = new FfmpegService(() => app.getPath('userData'));

export function registerFfmpegIpc(service: FfmpegService = ffmpegService): void {
  handle('ffmpeg:status', (_e, force?: boolean) => service.getStatus(force === true));
  handle('ffmpeg:repair', () => service.repair());
  handle('ffmpeg:cancelRepair', () => { service.cancelRepair(); return true; });
  handle('ffmpeg:chooseFile', (e) => service.chooseFile(BrowserWindow.fromWebContents(e.sender)));
  handle('ffmpeg:clearChoice', () => service.clearChoice());
}
