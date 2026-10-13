/**
 * The repair dialog's wording: every failure has a sentence and a next step,
 * and none of it leaks jargon a non-technical person cannot act on.
 */

import type { FfmpegProblemCode, FfmpegRepairErrorCode } from '@/types/motionEditor';
import { failureText, fixText, problemText, progressText } from './ffmpegRepairCopy';

const JARGON = /ENOENT|EACCES|EPERM|spawn|stderr|exit code|SHA|errno|0x/i;

const FAILURES: FfmpegRepairErrorCode[] = [
  'offline', 'network-blocked', 'unavailable', 'stalled', 'disk-full', 'no-permission',
  'corrupted', 'blocked-after-install', 'unsupported', 'not-ffmpeg',
];

test.each(FAILURES)('%s: one plain sentence and a next step', (code) => {
  const t = failureText(code, 300 * 1024 * 1024);
  expect(t.message.length).toBeGreaterThan(20);
  expect(t.message).not.toMatch(JARGON);
  expect(t.next).not.toBe('none');
});

test('cancel says nothing', () => {
  expect(failureText('cancelled')).toEqual({ message: '', next: 'none' });
});

test('a full disk names how much space is needed', () => {
  expect(failureText('disk-full', 260 * 1024 * 1024).message).toMatch(/260 MB/);
});

test('a blocked network points at the other-device route', () => {
  expect(failureText('network-blocked').next).toBe('choose');
  expect(failureText('blocked-after-install').next).toBe('recheck');
});

const PROBLEMS: FfmpegProblemCode[] = ['missing', 'blocked', 'wrong-arch', 'damaged', 'timeout', 'incomplete'];

test.each(PROBLEMS)('problem %s is explained without jargon', (code) => {
  expect(problemText(code, 'mp4')).not.toMatch(JARGON);
});

test('the promise names the download size and what still works', () => {
  expect(fixText(194_034_585)).toMatch(/185 MB/);
  expect(fixText(undefined)).toMatch(/PNG/);
});

test('progress lines', () => {
  expect(progressText('downloading', 50 * 1048576, 200 * 1048576)).toBe('Downloading… 25% (50 MB of 200 MB)');
  expect(progressText('testing', 0, 0)).toBe('Making sure it works…');
});
