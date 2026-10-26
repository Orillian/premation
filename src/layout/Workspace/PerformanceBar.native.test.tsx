/**
 * The Performance bar's states (plan §10): hidden when off, ready / recording
 * / done in Perform, Set Key and the target menu in Pose, and the controls a
 * running take disables.
 */

import { render, screen, act } from '@testing-library/react';
import type { Command as EngineCommand } from '@motion/engine-api';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { useLiveInputStore } from '@stores/liveInputStore';
import { usePerformanceStore } from '@stores/performanceStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { closePerformance } from '@providers/commands/performanceSession';
import { PerformanceBar } from './PerformanceBar';

let h: Awaited<ReturnType<typeof setupAppEngine>>;
let ID = '';

beforeEach(async () => {
  h = await setupAppEngine();
  ID = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'Hero', init: [] } as EngineCommand) as { layer: string }).layer;
  await engineIdle();
  await documentMirror().whenIdle();
});
afterEach(async () => {
  act(() => closePerformance());
  usePreferenceStore.getState().set('performanceMode', 'perform');
  usePreferenceStore.getState().set('performanceReduction', 'smart');
  usePreferenceStore.getState().set('performanceSource', 'mouse');
  useLiveInputStore.setState({ state: 'stopped', message: '', hands: 0 });
  await h.dispose();
});

const show = (patch: Partial<ReturnType<typeof usePerformanceStore.getState>>): void => {
  act(() => usePerformanceStore.setState({ nodeId: ID, target: 'position', lastKeys: 0, poseKeys: 0, takeStart: 0, ...patch }));
};

it('renders nothing while off', () => {
  const { container } = render(<PerformanceBar />);
  expect(container.querySelector('[data-performance-bar]')).toBeNull();
});

it('Perform: names the layer and property, and shows Detail for the smart fit', () => {
  render(<PerformanceBar />);
  show({ phase: 'armed' });
  expect(screen.getByRole('toolbar', { name: 'Performance recording' })).toBeTruthy();
  expect(screen.getByText('Ready — drag the layer')).toBeTruthy();
  expect(screen.getByText('Hero')).toBeTruthy();
  expect(screen.getByText('Position')).toBeTruthy();
  expect(screen.getByText('Detail')).toBeTruthy();
  expect(screen.getByText('100%')).toBeTruthy();
});

it('hides Detail when the reduction is After Effects\' every frame', () => {
  usePreferenceStore.getState().set('performanceReduction', 'everyFrame');
  render(<PerformanceBar />);
  show({ phase: 'armed' });
  expect(screen.queryByText('Detail')).toBeNull();
});

it('while recording: the clock runs, the hint says how to finish, the controls are disabled', () => {
  render(<PerformanceBar />);
  show({ phase: 'recording' });
  const bar = screen.getByRole('toolbar');
  expect(bar.getAttribute('data-phase')).toBe('recording');
  expect(screen.getByText('Release to finish · Esc to cancel')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);
  expect(bar.querySelector('[data-take-clock]')?.textContent).toMatch(/^0:\d\d\.\d\d$/);
});

it('after a take: the key count and Record again', () => {
  render(<PerformanceBar />);
  show({ phase: 'done', lastKeys: 7 });
  expect(screen.getByText('7 keys')).toBeTruthy();
  expect(screen.getByRole('button', { name: /Record again/ })).toBeTruthy();
});

it('the source toggle offers Mouse and Hand; with the hand: the camera state, Record, and how to grab', () => {
  const { container } = render(<PerformanceBar />);
  show({ phase: 'armed' });
  expect(screen.getByText('Mouse')).toBeTruthy();
  expect(screen.getByText('Hand')).toBeTruthy();
  expect(screen.queryByText('Camera off')).toBeNull();
  act(() => usePreferenceStore.getState().set('performanceSource', 'hand'));
  expect(screen.getByText('Ready — pinch to grab')).toBeTruthy();
  expect(screen.getByText('Camera off')).toBeTruthy();
  expect(container.querySelector('[data-hand-record]')?.textContent).toMatch(/Record/);
  act(() => useLiveInputStore.setState({ state: 'running', hands: 1, trackedFps: 30, fps: 30 }));
  expect(screen.getByText('1 hand(s) · 30 fps')).toBeTruthy();
  act(() => useLiveInputStore.setState({ state: 'failed', message: 'The camera could not be opened: busy' }));
  expect(screen.getByText('The camera could not be opened: busy')).toBeTruthy();
  // A pinch-driven target asks for Record first; recording by hand says how to finish.
  show({ phase: 'armed', target: 'scale' });
  expect(screen.getByText('Ready — press Record, then open and close your hand')).toBeTruthy();
  show({ phase: 'recording', target: 'position' });
  expect(screen.getByText('Open your hand to finish · Esc to cancel')).toBeTruthy();
  expect(container.querySelector('[data-hand-record]')?.textContent).toMatch(/Stop/);
});

it('Pose by hand says to tap or make a fist', () => {
  usePreferenceStore.getState().set('performanceMode', 'pose');
  usePreferenceStore.getState().set('performanceSource', 'hand');
  const { container } = render(<PerformanceBar />);
  show({ phase: 'armed' });
  expect(screen.getByText('Move your hand, then tap or make a fist')).toBeTruthy();
  expect(container.querySelector('[data-hand-record]')).toBeNull();
});

it('Pose: Set Key with its shortcut, the step, and the target as a menu', () => {
  usePreferenceStore.getState().set('performanceMode', 'pose');
  render(<PerformanceBar />);
  show({ phase: 'armed' });
  expect(screen.getByRole('button', { name: /Set Key/ })).toBeTruthy();
  expect(screen.getByText('Step 10f')).toBeTruthy();
  expect(screen.getByText('Move the layer, then Set Key')).toBeTruthy();
  expect(screen.queryByText('Detail')).toBeNull();
});
