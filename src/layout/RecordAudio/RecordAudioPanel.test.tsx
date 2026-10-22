/**
 * The Record Audio panel's state machine, driven through the panel with a
 * fake microphone: open → (count-in) → record → stop makes a take that
 * starts at the playhead; a refused permission and an unplugged device are
 * reported; a device lost mid-take keeps what was captured; "play while
 * recording" drives the transport; Add to Composition hands the take on.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CaptureCallbacks, CaptureOptions } from '@core/audio/recording/captureSession';

interface FakeSession {
  channelCount: number;
  sampleRate: number;
  deviceId: string | null;
  deviceLabel: string;
  setRecording: jest.Mock;
  setInputGainDb: jest.Mock;
  flush: jest.Mock;
  close: jest.Mock;
}

const fake: { cb: CaptureCallbacks | null; session: FakeSession | null; opts: CaptureOptions | null; fail: Error | null } = { cb: null, session: null, opts: null, fail: null };

jest.mock('@core/audio/recording/captureSession', () => ({
  listInputDevices: jest.fn(async () => [{ id: 'mic-1', label: 'USB Mic' }]),
  CaptureSession: {
    open: jest.fn(async (opts: CaptureOptions, cb: CaptureCallbacks) => {
      if (fake.fail) throw fake.fail;
      fake.cb = cb;
      fake.opts = opts;
      fake.session = {
        channelCount: 2,
        sampleRate: 48000,
        deviceId: opts.deviceId,
        deviceLabel: 'USB Mic',
        setRecording: jest.fn(),
        setInputGainDb: jest.fn(),
        flush: jest.fn(async () => undefined),
        close: jest.fn(async () => undefined),
      };
      return fake.session;
    }),
  },
}));

const transport = { playhead: 2.5, play: jest.fn(), pause: jest.fn() };
jest.mock('@core/timeline/timelineView', () => ({
  playheadSeconds: () => transport.playhead,
  playTransport: () => transport.play(),
  pauseTransport: () => transport.pause(),
}));

jest.mock('@hooks/usePremiumAccess', () => ({ usePremiumAccess: () => 'local' }));

const inserted: Array<{ name: string; startSec: number }> = [];
jest.mock('./takeInsertEdits', () => ({
  hasComposition: () => true,
  editedSpan: () => ({ offsetSec: 0, durationSec: 0 }),
  takeBlobForUse: jest.fn(async () => null),
  addTakeToProject: jest.fn(async () => null),
  addTakeToComposition: jest.fn(async (take: { name: string; startSec: number }) => {
    inserted.push({ name: take.name, startSec: take.startSec });
    return 'layer_1';
  }),
}));

import { TooltipProvider } from '@components/Tooltip';
import { RecordAudioPanel as Panel, recordAudioAllowed } from './RecordAudioPanel';

const RecordAudioPanel = (): JSX.Element => <TooltipProvider><Panel /></TooltipProvider>;
import { useRecordAudioPrefsStore } from '@stores/recordAudioPrefsStore';
import { useRecordAudioTakesStore } from '@stores/recordAudioTakesStore';

const block = (frames: number): Float32Array[] => [new Float32Array(frames).fill(0.25), new Float32Array(frames).fill(-0.25)];

beforeEach(() => {
  fake.cb = null;
  fake.session = null;
  fake.fail = null;
  transport.playhead = 2.5;
  transport.play.mockClear();
  transport.pause.mockClear();
  inserted.length = 0;
  useRecordAudioTakesStore.setState({ takes: [], selectedId: null });
  useRecordAudioPrefsStore.getState().set({ countIn: false, playWhileRecording: false, deviceId: null });
});

afterEach(() => {
  cleanup();
});

async function openInput(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Turn On Input' }));
  await screen.findByText(/Stereo · 48 kHz/);
}

it('opens the input without echo cancellation or auto gain by default', async () => {
  useRecordAudioPrefsStore.getState().set({ echoCancellation: false, autoGainControl: false });
  render(<RecordAudioPanel />);
  await openInput();
  expect(fake.opts).toMatchObject({ echoCancellation: false, autoGainControl: false });
});

it('records a take that starts at the playhead, and lists it', async () => {
  render(<RecordAudioPanel />);
  await openInput();
  fireEvent.click(screen.getByRole('button', { name: 'Record' }));
  expect(fake.session!.setRecording).toHaveBeenCalledWith(true);
  act(() => {
    fake.cb!.onLevel([0.5, 0.4]);
    fake.cb!.onChunk(block(24000));
    fake.cb!.onChunk(block(24000));
  });
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  await screen.findByTitle('Voice-over 1');
  const take = useRecordAudioTakesStore.getState().takes[0]!;
  expect(take).toMatchObject({ startSec: 2.5, channelCount: 2, sampleRate: 48000, durationSec: 1, partial: false });
  expect(fake.session!.setRecording).toHaveBeenLastCalledWith(false);
  expect(fake.session!.flush).toHaveBeenCalled();
  // The take is selected: its Edit section is open.
  expect(screen.getByRole('button', { name: 'Add to Composition' })).toBeInTheDocument();
});

it('counts in 3-2-1 before capturing', async () => {
  useRecordAudioPrefsStore.getState().set({ countIn: true });
  render(<RecordAudioPanel />);
  await openInput();
  jest.useFakeTimers();
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(fake.session!.setRecording).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(1000); });
    expect(screen.getByText('2')).toBeInTheDocument();
    act(() => { jest.advanceTimersByTime(2000); });
    expect(fake.session!.setRecording).toHaveBeenCalledWith(true);
  } finally {
    jest.useRealTimers();
  }
});

it('plays the composition while recording when asked, and stops it with the take', async () => {
  useRecordAudioPrefsStore.getState().set({ playWhileRecording: true });
  render(<RecordAudioPanel />);
  await openInput();
  fireEvent.click(screen.getByRole('button', { name: 'Record' }));
  expect(transport.play).toHaveBeenCalledTimes(1);
  act(() => { fake.cb!.onChunk(block(4800)); });
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  expect(transport.pause).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
  expect(transport.play).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  await screen.findByTitle('Voice-over 1');
  expect(transport.pause).toHaveBeenCalledTimes(2);
});

it('keeps what was captured when the device is unplugged mid-take', async () => {
  render(<RecordAudioPanel />);
  await openInput();
  fireEvent.click(screen.getByRole('button', { name: 'Record' }));
  act(() => { fake.cb!.onChunk(block(9600)); });
  await act(async () => { fake.cb!.onEnded(); });
  await screen.findByTitle('Voice-over 1');
  expect(useRecordAudioTakesStore.getState().takes[0]).toMatchObject({ partial: true, durationSec: 0.2 });
  expect(screen.getByRole('alert')).toHaveTextContent('The input went away');
  expect(fake.session!.close).toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Turn On Input' })).toBeInTheDocument();
});

it('reports a refused permission and records nothing', async () => {
  fake.fail = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
  render(<RecordAudioPanel />);
  fireEvent.click(screen.getByRole('button', { name: 'Turn On Input' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Microphone access was refused');
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('reports a missing device', async () => {
  fake.fail = Object.assign(new Error('none'), { name: 'NotFoundError' });
  render(<RecordAudioPanel />);
  fireEvent.click(screen.getByRole('button', { name: 'Turn On Input' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No microphone found');
});

it('Record from off opens the input, then records', async () => {
  render(<RecordAudioPanel />);
  fireEvent.click(screen.getByRole('button', { name: 'Record' }));
  await waitFor(() => expect(fake.session?.setRecording).toHaveBeenCalledWith(true));
});

it('adds the take to the composition at its start', async () => {
  transport.playhead = 4;
  render(<RecordAudioPanel />);
  await openInput();
  fireEvent.click(screen.getByRole('button', { name: 'Record' }));
  act(() => { fake.cb!.onChunk(block(4800)); });
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  await screen.findByTitle('Voice-over 1');
  fireEvent.click(screen.getByRole('button', { name: 'Add to Composition' }));
  await waitFor(() => expect(inserted).toEqual([{ name: 'Voice-over 1', startSec: 4 }]));
});

it('renames a take by double-clicking it', async () => {
  render(<RecordAudioPanel />);
  await openInput();
  fireEvent.click(screen.getByRole('button', { name: 'Record' }));
  act(() => { fake.cb!.onChunk(block(4800)); });
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  fireEvent.doubleClick(await screen.findByTitle('Voice-over 1'));
  const input = screen.getByRole('textbox', { name: 'Rename take' });
  fireEvent.change(input, { target: { value: 'Intro VO' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.blur(input);
  expect(await screen.findByTitle('Intro VO')).toBeInTheDocument();
});

it('the Pro gate is one switch', () => {
  expect(recordAudioAllowed('free')).toBe(true);
  expect(recordAudioAllowed('free', true)).toBe(false);
  expect(recordAudioAllowed('local', true)).toBe(true);
  expect(recordAudioAllowed('pro', true)).toBe(true);
});
