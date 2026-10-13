/**
 * The "Fix video export" dialog in each state a person can meet it in.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import type { FfmpegStatus } from '@/types/motionEditor';
import { useFfmpegStore } from '@stores/ffmpegStore';
import { FfmpegRepairDialog } from './FfmpegRepairDialog';

const broken: FfmpegStatus = {
  ok: false, canRepair: true, repairBytes: 194_034_585, checkedAt: 1, repairing: false,
  problem: { code: 'missing', source: 'bundled', detail: 'C:\\P\\resources\\ffmpeg\\ffmpeg.exe does not exist' },
  downloadUrl: 'https://example.test/ffmpeg.zip',
};

function open(state: Partial<ReturnType<typeof useFfmpegStore.getState>>): void {
  useFfmpegStore.setState({ status: broken, progress: null, failure: null, fixed: false, dialogOpen: true, dialogFormat: 'mp4', ...state });
  render(<FfmpegRepairDialog />);
}

beforeEach(() => {
  (window as unknown as { motionEditor: unknown }).motionEditor = {
    ffmpeg: {
      status: async () => broken, repair: jest.fn(async () => ({ ok: true, status: { ...broken, ok: true } })), cancelRepair: jest.fn(async () => true),
      chooseFile: jest.fn(async () => null), clearChoice: async () => broken, onStatus: () => () => undefined, onRepairProgress: () => () => undefined,
    },
  };
});
afterEach(() => {
  useFfmpegStore.setState({ dialogOpen: false });
  delete (window as unknown as { motionEditor?: unknown }).motionEditor;
});

test('explains the problem in plain words and offers the download with its size', () => {
  open({});
  expect(screen.getByText(/missing from this computer/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Download and fix (185 MB)' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Choose file…' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Copy download link' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Cancel export' })).toBeTruthy();
});

test('while repairing: progress in words and a Cancel, nothing else to press', () => {
  open({ status: { ...broken, repairing: true }, progress: { phase: 'downloading', receivedBytes: 50 * 1048576, totalBytes: 200 * 1048576, attempt: 1 } });
  expect(screen.getByText('Downloading… 25% (50 MB of 200 MB)')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Cancel download' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Download and fix/ })).toBeNull();
});

test('offline: the reason, and Try again', () => {
  open({ failure: { code: 'offline', detail: 'net::ERR_INTERNET_DISCONNECTED' } });
  expect(screen.getByRole('alert').textContent).toMatch(/not connected to the internet/);
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
});

test('blocked network: Choose file becomes the main action', () => {
  open({ failure: { code: 'network-blocked', detail: 'net::ERR_PROXY_CONNECTION_FAILED' } });
  const footerChoose = screen.getAllByRole('button', { name: 'Choose file…' });
  expect(footerChoose.length).toBe(1);
  expect(screen.getByRole('button', { name: 'Try download again' })).toBeTruthy();
});

test('antivirus blocked the new copy: Check again', () => {
  open({ failure: { code: 'blocked-after-install', detail: 'EPERM' } });
  expect(screen.getByRole('alert').textContent).toMatch(/security software/);
  expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
});

test('fixed: Continue resumes the waiting export', () => {
  open({ fixed: true, status: { ...broken, ok: true } });
  expect(screen.getByText(/Video export works again/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(useFfmpegStore.getState().dialogOpen).toBe(false);
});

test('Download and fix calls the repair', () => {
  open({});
  fireEvent.click(screen.getByRole('button', { name: 'Download and fix (185 MB)' }));
  expect((window.motionEditor!.ffmpeg!.repair as jest.Mock)).toHaveBeenCalled();
});

