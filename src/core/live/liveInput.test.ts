import type { LiveHand } from '@motion/engine-api';
import { useLiveInputStore } from '@stores/liveInputStore';
import { applyLiveInputEvent, latestLiveFrame, onLiveFrame, resetLiveInputForTests } from './liveInput';

const hand = (pinch: number): LiveHand => ({ landmarks: new Array(63).fill(0.5), handedness: 0.3, presence: 0.9, pinch });

const ev = (over: Partial<Parameters<typeof applyLiveInputEvent>[0]> = {}): Parameters<typeof applyLiveInputEvent>[0] => ({
  state: 'running', message: '', camera: 'Cam', width: 640, height: 360, fps: 30, seq: 1, latencyMs: 52.4, hands: [], ...over,
});

beforeEach(() => resetLiveInputForTests());

describe('liveInput', () => {
  it('hands every running frame to the listeners, and remembers the newest', () => {
    const seen: number[] = [];
    const off = onLiveFrame((f) => seen.push(f.hands[0]?.pinch ?? -1));
    applyLiveInputEvent(ev({ seq: 1, hands: [hand(0.1)] }));
    applyLiveInputEvent(ev({ seq: 2, hands: [hand(0.6)] }));
    expect(seen).toEqual([0.1, 0.6]);
    expect(latestLiveFrame()).toMatchObject({ seq: 2, width: 640, height: 360 });
    off();
    applyLiveInputEvent(ev({ seq: 3, hands: [hand(0.2)] }));
    expect(seen).toHaveLength(2);
  });

  it('a state change reaches the store at once; frames in between are paced', () => {
    applyLiveInputEvent(ev({ state: 'starting', seq: 0, camera: '' }));
    expect(useLiveInputStore.getState().state).toBe('starting');
    applyLiveInputEvent(ev({ seq: 1, hands: [hand(0.3)] }));
    expect(useLiveInputStore.getState()).toMatchObject({ state: 'running', camera: 'Cam', hands: 1, latencyMs: 52 });
    // Within the readout interval a second frame does not touch the store.
    const before = useLiveInputStore.getState();
    applyLiveInputEvent(ev({ seq: 2, hands: [hand(0.3), hand(0.4)] }));
    expect(useLiveInputStore.getState()).toBe(before);
  });

  it('failed carries the reason and clears the last frame; a throwing listener does not stop the others', () => {
    const seen: number[] = [];
    onLiveFrame(() => { throw new Error('bug'); });
    onLiveFrame((f) => seen.push(f.seq));
    applyLiveInputEvent(ev({ seq: 7, hands: [hand(0.3)] }));
    expect(seen).toEqual([7]);
    applyLiveInputEvent(ev({ state: 'failed', message: 'The camera could not be opened: busy', seq: 0 }));
    expect(useLiveInputStore.getState()).toMatchObject({ state: 'failed', message: 'The camera could not be opened: busy', hands: 0 });
    expect(latestLiveFrame()).toBeNull();
  });
});
