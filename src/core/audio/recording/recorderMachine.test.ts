import { captureErrorKind, INITIAL_RECORDER_STATE, inputOpen, recorderReducer, takeInProgress, type RecorderEvent, type RecorderState } from './recorderMachine';

const run = (events: RecorderEvent[], from: RecorderState = INITIAL_RECORDER_STATE): RecorderState => events.reduce(recorderReducer, from);

describe('recorder state machine', () => {
  it('opens, counts in 3-2-1, records, pauses, resumes and stops', () => {
    let s = run([{ type: 'open' }, { type: 'opened' }]);
    expect(s.phase).toBe('ready');
    expect(inputOpen(s)).toBe(true);
    s = run([{ type: 'record', countIn: 3 }], s);
    expect(s).toMatchObject({ phase: 'countIn', countdown: 3 });
    expect(takeInProgress(s)).toBe(true);
    s = run([{ type: 'tick' }, { type: 'tick' }], s);
    expect(s.countdown).toBe(1);
    s = run([{ type: 'tick' }], s);
    expect(s.phase).toBe('recording');
    s = run([{ type: 'pause' }], s);
    expect(s.phase).toBe('paused');
    s = run([{ type: 'resume' }, { type: 'stop' }], s);
    expect(s.phase).toBe('finishing');
    s = run([{ type: 'finished' }], s);
    expect(s.phase).toBe('ready');
  });

  it('records at once without a count-in, and a stop during the count-in cancels it', () => {
    const ready = run([{ type: 'open' }, { type: 'opened' }]);
    expect(run([{ type: 'record', countIn: 0 }], ready).phase).toBe('recording');
    expect(run([{ type: 'record', countIn: 3 }, { type: 'stop' }], ready).phase).toBe('ready');
  });

  it('a failed open returns to off with the reason', () => {
    const s = run([{ type: 'open' }, { type: 'openFailed', kind: 'permission' }]);
    expect(s).toEqual({ phase: 'off', countdown: 0, error: { kind: 'permission' } });
    expect(run([{ type: 'dismissError' }], s).error).toBeNull();
  });

  it('a device lost mid-take finishes the take (kept) and says so', () => {
    const s = run([{ type: 'open' }, { type: 'opened' }, { type: 'record', countIn: 0 }, { type: 'deviceLost' }]);
    expect(s).toMatchObject({ phase: 'finishing', error: { kind: 'deviceLost' } });
    expect(run([{ type: 'finished' }], s).phase).toBe('ready');
  });

  it('a device lost while idle closes the input', () => {
    expect(run([{ type: 'open' }, { type: 'opened' }, { type: 'deviceLost' }]).phase).toBe('off');
  });

  it('the length ceiling stops and keeps the take', () => {
    expect(run([{ type: 'open' }, { type: 'opened' }, { type: 'record', countIn: 0 }, { type: 'limitReached' }]))
      .toMatchObject({ phase: 'finishing', error: { kind: 'tooLong' } });
  });

  it('ignores events that do not apply', () => {
    expect(run([{ type: 'record', countIn: 0 }]).phase).toBe('off');
    expect(run([{ type: 'pause' }, { type: 'finished' }]).phase).toBe('off');
  });

  it('classifies getUserMedia errors', () => {
    expect(captureErrorKind({ name: 'NotAllowedError' })).toBe('permission');
    expect(captureErrorKind({ name: 'NotFoundError' })).toBe('noDevice');
    expect(captureErrorKind({ name: 'OverconstrainedError' })).toBe('noDevice');
    expect(captureErrorKind({ name: 'NotReadableError' })).toBe('busy');
    expect(captureErrorKind({ name: 'UnsupportedError' })).toBe('unsupported');
    expect(captureErrorKind(new Error('x'))).toBe('failed');
  });
});
