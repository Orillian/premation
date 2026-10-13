/**
 * The ffmpeg health check against FAKE binaries: which copy wins, and what a
 * missing / blocked / wrong-CPU / damaged / minimal ffmpeg is reported as.
 */

import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
  checkFfmpeg, classifyExit, classifySpawnError, encodersForFormat, formatBlocker, parseEncoders,
  REQUIRED_ENCODERS, type FfmpegCandidate, type FfmpegHealthDeps,
} from './ffmpegHealth';

const listing = (names: readonly string[]): string =>
  ['Encoders:', ' V..... = Video', ' ------', ...names.map((n) => ` V....D ${n.padEnd(20)} ${n} encoder`)].join('\n');

type Behaviour =
  | { kind: 'ok'; encoders?: readonly string[] }
  | { kind: 'spawn-error'; code: string; message?: string }
  | { kind: 'exit'; code: number | null; signal?: NodeJS.Signals }
  | { kind: 'hang' };

function fakeSpawn(table: Record<string, Behaviour>): FfmpegHealthDeps['spawn'] {
  return ((cmd: string) => {
    const b = table[cmd] ?? { kind: 'spawn-error', code: 'ENOENT' };
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => undefined;
    setTimeout(() => {
      if (b.kind === 'ok') {
        proc.stdout.emit('data', Buffer.from(listing(b.encoders ?? REQUIRED_ENCODERS)));
        proc.emit('close', 0, null);
      } else if (b.kind === 'spawn-error') {
        proc.emit('error', Object.assign(new Error(b.message ?? `spawn ${cmd} ${b.code}`), { code: b.code }));
      } else if (b.kind === 'exit') {
        proc.stderr.emit('data', Buffer.from('boom'));
        proc.emit('close', b.code, b.signal ?? null);
      }
    }, 0);
    return proc as unknown as ChildProcess;
  }) as FfmpegHealthDeps['spawn'];
}

const BUNDLED: FfmpegCandidate = { source: 'bundled', path: '/res/ffmpeg/ffmpeg' };
const REPAIRED: FfmpegCandidate = { source: 'repaired', path: '/ud/tools/ffmpeg/abc/ffmpeg' };
const SYSTEM: FfmpegCandidate = { source: 'system', path: 'ffmpeg' };

function deps(table: Record<string, Behaviour>, candidates: FfmpegCandidate[], present: string[] = candidates.map((c) => c.path)): FfmpegHealthDeps {
  return { candidates: () => candidates, spawn: fakeSpawn(table), exists: (p) => present.includes(p), repairBytes: 1000, now: () => 1, timeoutMs: 50 };
}

describe('parseEncoders', () => {
  test('reads names after the dashes only', () => {
    expect(parseEncoders(listing(['libx264', 'aac']))).toEqual(['libx264', 'aac']);
    expect(parseEncoders('V....D notreal before the header')).toEqual([]);
  });
});

describe('classification', () => {
  test('spawn errors', () => {
    expect(classifySpawnError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe('missing');
    expect(classifySpawnError(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe('blocked');
    expect(classifySpawnError(Object.assign(new Error('x'), { code: 'EPERM' }))).toBe('blocked');
    expect(classifySpawnError(Object.assign(new Error('spawn Unknown system error -86'), { code: 'Unknown system error -86' }))).toBe('wrong-arch');
    // Real Windows: a garbage .exe is UNKNOWN, a truncated one EFTYPE (checked against real files).
    expect(classifySpawnError(Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN' }))).toBe('damaged');
    expect(classifySpawnError(Object.assign(new Error('spawn EFTYPE'), { code: 'EFTYPE' }))).toBe('damaged');
  });
  test('Windows NTSTATUS exits and macOS kills', () => {
    expect(classifyExit(-1073741790, null)).toBe('blocked');       // 0xC0000022 access denied
    expect(classifyExit(-1073741701, null)).toBe('wrong-arch');    // 0xC000007B bad image
    expect(classifyExit(-1073741515, null)).toBe('damaged');       // 0xC0000135 DLL not found
    expect(classifyExit(null, 'SIGKILL')).toBe('blocked');
    expect(classifyExit(1, null)).toBe('damaged');
  });
});

describe('checkFfmpeg', () => {
  test('the bundled copy wins and nothing else is run', async () => {
    const { status, results } = await checkFfmpeg(deps({ [BUNDLED.path]: { kind: 'ok' } }, [BUNDLED, REPAIRED, SYSTEM]));
    expect(status.ok).toBe(true);
    expect(status.active?.source).toBe('bundled');
    expect(status.problem).toBeUndefined();
    expect(results).toHaveLength(1);
  });

  test('a quarantined bundled copy is "missing"; the repaired copy is used', async () => {
    const d = deps({ [REPAIRED.path]: { kind: 'ok' } }, [BUNDLED, REPAIRED, SYSTEM], [REPAIRED.path]);
    const { status } = await checkFfmpeg(d);
    expect(status.ok).toBe(true);
    expect(status.active?.source).toBe('repaired');
  });

  test('blocked bundled copy and no other: not ok, the problem is the bundled one', async () => {
    const { status } = await checkFfmpeg(deps({ [BUNDLED.path]: { kind: 'spawn-error', code: 'EPERM' } }, [BUNDLED, SYSTEM]));
    expect(status.ok).toBe(false);
    expect(status.active).toBeUndefined();
    expect(status.problem).toMatchObject({ code: 'blocked', source: 'bundled' });
    expect(status.canRepair).toBe(true);
    expect(status.repairBytes).toBe(1000);
  });

  test('a hung binary times out instead of hanging the export', async () => {
    const { status } = await checkFfmpeg(deps({ [BUNDLED.path]: { kind: 'hang' } }, [BUNDLED]));
    expect(status.problem?.code).toBe('timeout');
  });

  test('a minimal system ffmpeg is used for what it can do, reported incomplete', async () => {
    const { status } = await checkFfmpeg(deps({ ffmpeg: { kind: 'ok', encoders: ['libx264', 'aac', 'gif'] } }, [SYSTEM]));
    expect(status.ok).toBe(false);
    expect(status.active?.source).toBe('system');
    expect(status.problem?.code).toBe('incomplete');
    expect(formatBlocker(status, 'mp4')).toBeNull();
    expect(formatBlocker(status, 'gif')).toBeNull();
    expect(formatBlocker(status, 'webm')).toEqual({ code: 'incomplete', missingEncoders: ['libvpx-vp9', 'libopus'] });
  });

  test('nothing anywhere (development without ffmpeg): missing', async () => {
    const { status } = await checkFfmpeg(deps({}, [SYSTEM]));
    expect(status.ok).toBe(false);
    expect(status.problem?.code).toBe('missing');
    expect(formatBlocker(status, 'mov')?.code).toBe('missing');
  });
});

test('formats the engine writes itself never need ffmpeg', () => {
  for (const f of ['png', 'png-sequence', 'jpg-sequence', 'exr-sequence', 'wav', 'plugin:x/y']) expect(encodersForFormat(f)).toBeNull();
  const none = { ok: false, canRepair: true, checkedAt: 0 };
  expect(formatBlocker(none, 'png-sequence')).toBeNull();
});
