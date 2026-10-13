/**
 * The export-side gate: a ready ffmpeg never asks; a broken one opens the
 * repair dialog and the export waits for its outcome.
 */

import type { FfmpegRepairResult, FfmpegStatus } from '@/types/motionEditor';
import { ensureFfmpegFor, ffmpegReadyFor, useFfmpegStore } from './ffmpegStore';

const FULL = ['libx264', 'aac', 'libvpx-vp9', 'libopus', 'prores_ks', 'gif', 'png'];

const okStatus: FfmpegStatus = {
  ok: true, canRepair: true, checkedAt: 1, repairing: false,
  active: { source: 'bundled', path: '/r/ffmpeg', encoders: FULL, missingEncoders: [] },
};
const brokenStatus: FfmpegStatus = {
  ok: false, canRepair: true, repairBytes: 194_000_000, checkedAt: 1, repairing: false,
  problem: { code: 'blocked', source: 'bundled', detail: 'EPERM' },
};

function installBridge(statuses: FfmpegStatus[], repairResult?: FfmpegRepairResult) {
  const calls: string[] = [];
  let current = statuses[0]!;
  const bridge = {
    status: jest.fn(async () => { calls.push('status'); current = statuses.shift() ?? current; return current; }),
    repair: jest.fn(async () => { calls.push('repair'); return repairResult ?? { ok: true as const, status: okStatus }; }),
    cancelRepair: jest.fn(async () => true),
    chooseFile: jest.fn(async () => null),
    clearChoice: jest.fn(async () => current),
    onStatus: jest.fn(() => () => undefined),
    onRepairProgress: jest.fn(() => () => undefined),
  };
  (window as unknown as { motionEditor: unknown }).motionEditor = { ffmpeg: bridge };
  return { bridge, calls };
}

beforeEach(() => {
  useFfmpegStore.setState({ status: null, progress: null, failure: null, fixed: false, dialogOpen: false, dialogFormat: null });
});
afterEach(() => {
  delete (window as unknown as { motionEditor?: unknown }).motionEditor;
});

test('formats the engine writes itself never wait, even with no ffmpeg at all', async () => {
  installBridge([brokenStatus]);
  await expect(ensureFfmpegFor('png-sequence')).resolves.toBe(true);
  await expect(ensureFfmpegFor('wav')).resolves.toBe(true);
  expect(useFfmpegStore.getState().dialogOpen).toBe(false);
});

test('a working ffmpeg: mp4 goes ahead without a dialog', async () => {
  installBridge([okStatus, okStatus]);
  useFfmpegStore.setState({ status: okStatus });
  await expect(ensureFfmpegFor('mp4')).resolves.toBe(true);
  expect(useFfmpegStore.getState().dialogOpen).toBe(false);
});

test('broken: the dialog opens; closing it without fixing cancels the export', async () => {
  installBridge([brokenStatus, brokenStatus, brokenStatus]);
  const pending = ensureFfmpegFor('mp4');
  await new Promise((r) => setTimeout(r, 0));
  expect(useFfmpegStore.getState().dialogOpen).toBe(true);
  expect(useFfmpegStore.getState().dialogFormat).toBe('mp4');
  useFfmpegStore.getState().closeDialog();
  await expect(pending).resolves.toBe(false);
});

test('broken → Download and fix succeeds → Continue lets the export through', async () => {
  installBridge([brokenStatus, brokenStatus, brokenStatus]);
  const pending = ensureFfmpegFor('webm');
  await new Promise((r) => setTimeout(r, 0));
  await expect(useFfmpegStore.getState().repair()).resolves.toBe(true);
  expect(useFfmpegStore.getState().fixed).toBe(true);
  useFfmpegStore.getState().closeDialog();
  await expect(pending).resolves.toBe(true);
});

test('a failed repair keeps the dialog with the reason; cancel is not shown as a failure', async () => {
  installBridge([brokenStatus], { ok: false, code: 'offline', detail: 'net::ERR_INTERNET_DISCONNECTED', status: brokenStatus });
  await useFfmpegStore.getState().repair();
  expect(useFfmpegStore.getState().failure).toMatchObject({ code: 'offline' });

  installBridge([brokenStatus], { ok: false, code: 'cancelled', detail: 'cancelled', status: brokenStatus });
  useFfmpegStore.setState({ failure: null });
  await useFfmpegStore.getState().repair();
  expect(useFfmpegStore.getState().failure).toBeNull();
});

test('a minimal ffmpeg: ready for what it has, not for the rest', () => {
  const minimal: FfmpegStatus = { ...brokenStatus, active: { source: 'system', path: 'ffmpeg', encoders: ['libx264', 'aac'], missingEncoders: [] } };
  expect(ffmpegReadyFor(minimal, 'mp4')).toBe(true);
  expect(ffmpegReadyFor(minimal, 'webm')).toBe(false);
  expect(ffmpegReadyFor(minimal, 'mov')).toBe(false);
});
