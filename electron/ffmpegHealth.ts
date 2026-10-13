/**
 * Is there an ffmpeg that can export, and if not, why not — in terms a person
 * who has never heard of ffmpeg can act on.
 *
 * Export runs ffmpeg as a separate program (electron/ffmpegBinary.ts). The
 * installer ships a verified copy (scripts/fetchFfmpeg.cjs), but on a real
 * machine that copy can still be gone or unusable: antivirus quarantined or
 * blocked it, a disk error damaged it, an x64 copy landed on a machine that
 * cannot run it. Finding that out at the END of a long render is the worst
 * time, so this runs at startup and before every export that encodes.
 *
 * Every candidate is RUN (`ffmpeg -hide_banner -encoders`), not just looked
 * for: a file that exists but is blocked or damaged is the case that matters.
 * Candidates, in order: FFMPEG_PATH, the copy the person chose, the bundled
 * copy, the repaired copy (electron/ffmpegRepair.ts), `ffmpeg` on PATH. The
 * first that runs with every required encoder wins; failing that, the first
 * that runs at all (some formats may still export); failing that, nothing.
 *
 * Electron-free: spawning, the filesystem and the clock are injected.
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import manifest from './ffmpegManifest.json';

export type FfmpegSource = 'override' | 'chosen' | 'bundled' | 'repaired' | 'system';

/**
 * Why a copy does not work. Each maps to one plain-language explanation and
 * one fix in the UI (src/stores/ffmpegStore.ts):
 *   missing     — the file is not there (deleted, quarantined, never installed)
 *   blocked     — the OS or security software refused to run it
 *   wrong-arch  — built for a different processor than this computer's
 *   damaged     — it starts but crashes / a library inside it is missing
 *   timeout     — it did not answer in time (hung, or scanned forever by antivirus)
 *   incomplete  — it runs but lacks encoders some formats need (a minimal ffmpeg the person chose)
 */
export type FfmpegProblemCode = 'missing' | 'blocked' | 'wrong-arch' | 'damaged' | 'timeout' | 'incomplete';

export interface FfmpegCandidate {
  source: FfmpegSource;
  path: string;
}

export interface FfmpegCandidateResult extends FfmpegCandidate {
  runs: boolean;
  encoders: string[];
  missingEncoders: string[];
  code?: FfmpegProblemCode;
  /** Technical detail for "Copy details" / logs; never the headline. */
  detail?: string;
}

export interface FfmpegStatus {
  /** An ffmpeg runs AND has every encoder export can use. */
  ok: boolean;
  /** The copy exports will use (ok, or runs-with-gaps); absent when none runs. */
  active?: { source: FfmpegSource; path: string; encoders: string[]; missingEncoders: string[] };
  /** Why the copy that SHOULD work does not — the bundled one when there is one. */
  problem?: { code: FfmpegProblemCode; source: FfmpegSource; detail: string };
  /** A pinned build exists for this platform + arch, so "Download and fix" can work. */
  canRepair: boolean;
  /** Download size of that repair, for the button label. */
  repairBytes?: number;
  checkedAt: number;
}

export const REQUIRED_ENCODERS: readonly string[] = manifest.requiredEncoders;

/** The encoders a format cannot be written without (beyond these, choices fall back — see encoderProbe.ts). */
export function encodersForFormat(format: string): string[] | null {
  switch (format) {
    case 'mp4':
    case 'hdr10':
    case 'hlg':
      return ['libx264', 'aac'];
    case 'webm':
      return ['libvpx-vp9', 'libopus'];
    case 'mov':
      return ['prores_ks'];
    case 'gif':
      return ['gif'];
    default:
      return null;  // image sequences, stills, WAV, plugin outputs: the engine writes them itself
  }
}

/** null when `status` can export `format`; otherwise the problem to show. */
export function formatBlocker(status: FfmpegStatus, format: string): { code: FfmpegProblemCode; missingEncoders: string[] } | null {
  const needs = encodersForFormat(format);
  if (!needs) return null;
  if (!status.active) return { code: status.problem?.code ?? 'missing', missingEncoders: needs };
  const have = new Set(status.active.encoders);
  const missing = needs.filter((e) => !have.has(e));
  return missing.length ? { code: 'incomplete', missingEncoders: missing } : null;
}

/** Parse `ffmpeg -encoders` output: lines like ` V....D libx264   libx264 H.264 …`. */
export function parseEncoders(text: string): string[] {
  const out: string[] = [];
  let started = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!started) {
      if (line.startsWith('------')) started = true;
      continue;
    }
    const m = /^[VAS][A-Z.]{5}\s+(\S+)/.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

// Windows NTSTATUS exit codes a blocked or broken exe dies with, as Node reports them (unsigned).
const STATUS_ACCESS_DENIED = 0xc0000022;
const STATUS_INVALID_IMAGE_FORMAT = 0xc000007b;
const STATUS_DLL_NOT_FOUND = 0xc0000135;
const STATUS_ENTRYPOINT_NOT_FOUND = 0xc0000139;
const STATUS_VIRUS_INFECTED = 0xc0000906;

/** A spawn `error` event → problem code. */
export function classifySpawnError(err: NodeJS.ErrnoException): FfmpegProblemCode {
  const code = String(err.code ?? '');
  const msg = String(err.message ?? '');
  if (code === 'ENOENT') return 'missing';
  if (code === 'EACCES' || code === 'EPERM') return 'blocked';
  // macOS: "spawn Unknown system error -86" is EBADARCH (bad CPU type in executable).
  if (code === 'EBADARCH' || /-86\b|bad CPU type/i.test(msg)) return 'wrong-arch';
  if (/blocked|policy|virus/i.test(msg)) return 'blocked';
  // Windows reports a corrupt image as UNKNOWN or EFTYPE — and some policy
  // refusals as UNKNOWN too. "Damaged" is the honest first answer: the fix is
  // the same download, and if a fresh, hash-checked copy then still cannot run,
  // the repair says it is security software (ffmpegRepair 'blocked-after-install').
  return 'damaged';
}

/** A non-zero exit / signal → problem code. */
export function classifyExit(exitCode: number | null, signal: NodeJS.Signals | null): FfmpegProblemCode {
  if (signal === 'SIGKILL') return 'blocked';  // macOS kills a binary whose signature it rejects
  const u = exitCode === null ? null : exitCode >>> 0;
  if (u === STATUS_ACCESS_DENIED || u === STATUS_VIRUS_INFECTED) return 'blocked';
  if (u === STATUS_INVALID_IMAGE_FORMAT) return 'wrong-arch';
  if (u === STATUS_DLL_NOT_FOUND || u === STATUS_ENTRYPOINT_NOT_FOUND) return 'damaged';
  return 'damaged';
}

export interface FfmpegHealthDeps {
  candidates: () => FfmpegCandidate[];
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  exists: (p: string) => boolean;
  now?: () => number;
  /** Per-probe limit. Antivirus scanning a 160 MB exe on first run can take seconds. */
  timeoutMs?: number;
  /** For the "Download and fix" button. */
  repairBytes: number | null;
  log?: (m: string) => void;
}

/** Run one candidate. Never rejects. */
export function probeCandidate(c: FfmpegCandidate, deps: Pick<FfmpegHealthDeps, 'spawn' | 'exists' | 'timeoutMs'>): Promise<FfmpegCandidateResult> {
  const base = { ...c, runs: false, encoders: [] as string[], missingEncoders: [...REQUIRED_ENCODERS] };
  // An absolute path that is not there: say so without spawning (`ffmpeg` on PATH has to be tried).
  if (c.source !== 'system' && !deps.exists(c.path)) {
    return Promise.resolve({ ...base, code: 'missing', detail: `${c.path} does not exist` });
  }
  return new Promise((resolve) => {
    let child: ChildProcess;
    let out = '';
    let err = '';
    let done = false;
    const finish = (r: FfmpegCandidateResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    try {
      child = deps.spawn(c.path, ['-hide_banner', '-encoders'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ...base, code: classifySpawnError(e as NodeJS.ErrnoException), detail: String((e as Error).message) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ ...base, code: 'timeout', detail: `no answer from ${c.path} within ${Math.round((deps.timeoutMs ?? 20_000) / 1000)}s` });
    }, deps.timeoutMs ?? 20_000);
    child.stdout?.on('data', (d: Buffer) => { if (out.length < 1_000_000) out += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { if (err.length < 8_000) err += d.toString('utf8'); });
    child.on('error', (e: NodeJS.ErrnoException) => {
      // On PATH, "not found" just means there is no system ffmpeg.
      finish({ ...base, code: classifySpawnError(e), detail: `${e.code ?? ''} ${e.message}`.trim() });
    });
    child.on('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (exitCode !== 0) {
        const hex = exitCode === null ? '' : ` (0x${(exitCode >>> 0).toString(16)})`;
        finish({ ...base, code: classifyExit(exitCode, signal), detail: `exited ${exitCode ?? signal}${hex}: ${err.trim().slice(-500)}` });
        return;
      }
      const encoders = parseEncoders(out);
      if (encoders.length === 0) {
        finish({ ...base, code: 'damaged', detail: 'ran but listed no encoders' });
        return;
      }
      const have = new Set(encoders);
      const missingEncoders = REQUIRED_ENCODERS.filter((e) => !have.has(e));
      finish({ ...c, runs: true, encoders, missingEncoders, ...(missingEncoders.length ? { code: 'incomplete' as const, detail: `no ${missingEncoders.join(', ')}` } : {}) });
    });
  });
}

/** Check every candidate in order (stopping at the first fully-capable one) and summarise. */
export async function checkFfmpeg(deps: FfmpegHealthDeps): Promise<{ status: FfmpegStatus; results: FfmpegCandidateResult[] }> {
  const results: FfmpegCandidateResult[] = [];
  for (const c of deps.candidates()) {
    const r = await probeCandidate(c, deps);
    results.push(r);
    deps.log?.(`ffmpeg ${c.source} ${c.path}: ${r.runs && !r.code ? 'ok' : `${r.code}${r.detail ? ` — ${r.detail}` : ''}`}`);
    if (r.runs && r.missingEncoders.length === 0) break;
  }
  const full = results.find((r) => r.runs && r.missingEncoders.length === 0);
  const partial = results.find((r) => r.runs);
  const active = full ?? partial;
  // The problem to explain: the bundled copy's, when it failed (that is the
  // one that was supposed to work); else the active copy's gaps; else the
  // first failure. A missing system ffmpeg is not "a problem" on its own.
  const bundledFail = results.find((r) => r.source === 'bundled' && r.code);
  const firstFail = results.find((r) => r.code && !(r.source === 'system' && r.code === 'missing'));
  const pick = full ? undefined : bundledFail ?? (partial?.code ? partial : undefined) ?? firstFail ?? results.find((r) => r.code);
  const status: FfmpegStatus = {
    ok: Boolean(full),
    ...(active ? { active: { source: active.source, path: active.path, encoders: active.encoders, missingEncoders: active.missingEncoders } } : {}),
    ...(pick?.code ? { problem: { code: pick.code, source: pick.source, detail: pick.detail ?? '' } } : {}),
    canRepair: deps.repairBytes !== null,
    ...(deps.repairBytes !== null ? { repairBytes: deps.repairBytes } : {}),
    checkedAt: (deps.now ?? Date.now)(),
  };
  if (!full && !active && !status.problem) status.problem = { code: 'missing', source: 'bundled', detail: 'no ffmpeg found' };
  return { status, results };
}
