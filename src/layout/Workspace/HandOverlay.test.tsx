/**
 * The hand overlay (plan P1.4): shown only while the bar is up with the hand
 * as its source, draws from the live-frame listener without a React render
 * per frame (state lands on the canvas element), and the drawing itself —
 * the 21-point skeleton, the state colour — exercised on a recording context.
 */

import { render, act } from '@testing-library/react';
import { syntheticHand } from '@core/live/gestures';
import { applyLiveInputEvent, resetLiveInputForTests } from '@core/live/liveInput';
import { usePerformanceStore } from '@stores/performanceStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { drawHandFrame, HandOverlay } from './HandOverlay';

beforeEach(() => {
  resetLiveInputForTests();
  // jsdom has no 2D canvas: the overlay must cope with a null context.
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    cb(0);
    return 1;
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  usePerformanceStore.setState({ phase: 'off', nodeId: null });
  usePreferenceStore.getState().set('performanceSource', 'mouse');
});

const frame = (hands: ReturnType<typeof syntheticHand>[], seq = 1): void => {
  applyLiveInputEvent({ state: 'running', message: '', camera: 'Cam', width: 640, height: 360, fps: 30, seq, latencyMs: 0, hands });
};

it('renders nothing while the bar is off or the source is the mouse', () => {
  const { container, rerender } = render(<HandOverlay />);
  expect(container.querySelector('[data-hand-overlay]')).toBeNull();
  act(() => usePerformanceStore.setState({ phase: 'armed', nodeId: 'L' }));
  rerender(<HandOverlay />);
  expect(container.querySelector('[data-hand-overlay]')).toBeNull();
  act(() => usePreferenceStore.getState().set('performanceSource', 'hand'));
  expect(container.querySelector('[data-hand-overlay]')).not.toBeNull();
});

it('is pointer-transparent chrome sized to the camera, and takes its state from the hand source per frame', () => {
  usePreferenceStore.getState().set('performanceSource', 'hand');
  act(() => usePerformanceStore.setState({ phase: 'armed', nodeId: 'L' }));
  const { container } = render(<HandOverlay />);
  const canvas = container.querySelector('[data-hand-overlay]') as HTMLCanvasElement;
  expect(canvas).toBeTruthy();
  expect(canvas.getAttribute('aria-hidden')).toBe('true');
  expect(canvas.dataset.present).toBe('false');
  // 192 wide, the camera's 16:9 → 108 high.
  act(() => frame([syntheticHand({ x: 0.5, y: 0.5 })]));
  expect(canvas.style.width).toBe('192px');
  expect(canvas.style.height).toBe('108px');
  // Frames do not re-render React: the same element, its data attributes rewritten.
  expect(container.querySelector('[data-hand-overlay]')).toBe(canvas);
  expect(canvas.dataset.recording).toBe('false');
});

it('draws the skeleton and colours it by state', () => {
  const calls: string[] = [];
  const ctx = new Proxy({} as CanvasRenderingContext2D, {
    get: (_t, prop: string) => {
      if (prop === 'strokeStyle' || prop === 'fillStyle') return undefined;
      return (...args: unknown[]) => { calls.push(`${prop}${args.length ? ':' + String(args[0]) : ''}`); };
    },
    set: (_t, prop: string, v: unknown) => { calls.push(`${prop}=${String(v)}`); return true; },
  });
  const palette = { frame: '#333', bone: '#eee', joint: '#eee', grab: '#4f8cff', record: '#e5484d', text: '#eee' };
  const labels = { noHand: 'No hand', left: 'Left', right: 'Right' };
  const hand = syntheticHand({ x: 0.5, y: 0.5, handedness: 0.2 });
  const f = { seq: 1, latencyMs: 0, width: 640, height: 360, hands: [hand] };
  drawHandFrame(ctx, { w: 192, h: 108, dpr: 1 }, f, { present: true, grabbed: true, recording: false, hand: 'right' }, true, palette, labels);
  // 21 bones = 21 moveTo / lineTo pairs, 21 joints, the grab colour on the driving hand's strokes.
  expect(calls.filter((c) => c.startsWith('moveTo')).length).toBe(21);
  expect(calls.filter((c) => c.startsWith('arc')).length).toBeGreaterThanOrEqual(22);
  expect(calls).toContain('strokeStyle=#4f8cff');
  expect(calls.some((c) => c.startsWith('fillText:Right'))).toBe(true);
  calls.length = 0;
  drawHandFrame(ctx, { w: 192, h: 108, dpr: 1 }, f, { present: true, grabbed: true, recording: true, hand: 'right' }, true, palette, labels);
  expect(calls).toContain('strokeStyle=#e5484d');
  calls.length = 0;
  drawHandFrame(ctx, { w: 192, h: 108, dpr: 1 }, null, { present: false, grabbed: false, recording: false, hand: 'right' }, true, palette, labels);
  expect(calls.some((c) => c.startsWith('fillText:No hand'))).toBe(true);
  expect(calls.filter((c) => c.startsWith('moveTo')).length).toBe(0);
});
