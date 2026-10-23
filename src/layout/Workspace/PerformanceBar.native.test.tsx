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

it('Pose: Set Key with its shortcut, the step, and the target as a menu', () => {
  usePreferenceStore.getState().set('performanceMode', 'pose');
  render(<PerformanceBar />);
  show({ phase: 'armed' });
  expect(screen.getByRole('button', { name: /Set Key/ })).toBeTruthy();
  expect(screen.getByText('Step 10f')).toBeTruthy();
  expect(screen.getByText('Move the layer, then Set Key')).toBeTruthy();
  expect(screen.queryByText('Detail')).toBeNull();
});
