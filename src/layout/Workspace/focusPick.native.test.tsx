/**
 * U6: pick focus on canvas — the crosshair beside Focus Distance (or the Shot
 * header's Focus on Layer) arms a ONE-SHOT pick; the viewport's next click
 * (`completeFocusPick`, what useWorkspace calls with the layer under the
 * pointer) puts the focal plane on that layer as ONE undo entry and disarms;
 * Esc or a second press cancels without writing.
 */

import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';
import { Project3D } from '@motion/scene';
import { CameraSection } from '@layout/Inspector/CameraSection';
import { clearHistory, setupAppEngine, historyLabels, storedTrack } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useFocusPickStore, completeFocusPick } from './focusPickStore';

jest.useFakeTimers();

const FOCAL = Project3D.defaultCamera(1920, 1080).focalLength;

let h: Harness;
let CAM = '';
let SUBJECT = '';

beforeEach(async () => {
  h = await setupAppEngine();
  usePreferenceStore.getState().set('inspectorSections', {});
  usePreferenceStore.getState().set('timelineAutoKeyframe', false);
  await act(async () => {
    ({ layer: CAM } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'camera', name: 'Pick camera', init: [] }));
    ({ layer: SUBJECT } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'Subject', init: [] }));
    await h.run({ type: 'setLayerSwitches', layers: [SUBJECT], patch: { threeD: true } });
    await h.run({ type: 'setProperty', prop: { layer: SUBJECT, path: 'transform/position' }, value: { kind: 'vec3', value: { x: 960, y: 540, z: 400 } } });
    await engineIdle();
    await documentMirror().loadTree(CAM);
  });
  await clearHistory();
  useSelectionStore.setState({ ids: [CAM] } as never);
});
afterEach(async () => {
  cleanup();
  act(() => { useFocusPickStore.getState().cancel(); });
  await h.dispose();
});

const idle = async (): Promise<void> => { await act(async () => { await engineIdle(); await documentMirror().whenIdle(); }); };
const settle = (): void => { act(() => { jest.advanceTimersByTime(2000); }); };
const armed = (): string | null => useFocusPickStore.getState().camera;

async function dofOn(): Promise<void> {
  render(<CameraSection nodeId={CAM} />);
  fireEvent.click(screen.getByRole('button', { name: 'Depth of Field' }));
  await idle();
  await clearHistory();
}

describe('pick focus on canvas', () => {
  it('the crosshair arms a one-shot pick; the next viewport click focuses on the layer as ONE entry', async () => {
    await dofOn();
    const pick = screen.getByRole('button', { name: 'Pick focus on canvas' });
    expect(pick.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(pick);
    expect(armed()).toBe(CAM);
    expect(screen.getByRole('button', { name: 'Pick focus on canvas' }).getAttribute('aria-pressed')).toBe('true');

    let depth: number | null = null;
    await act(async () => { depth = await completeFocusPick(SUBJECT, 0); });
    await idle();
    expect(depth).toBeCloseTo(FOCAL + 400, 3);
    expect(await storedTrack(CAM, 'focusDistance')).toBeCloseTo(FOCAL + 400, 1);
    // One-shot: disarmed after the click.
    expect(armed()).toBeNull();
    expect(screen.getByRole('button', { name: 'Pick focus on canvas' }).getAttribute('aria-pressed')).toBe('false');
    settle();
    expect(await historyLabels()).toEqual(['Set Focus Distance to Layer']);
  });

  it('Esc cancels, as does a second press — and a click on empty canvas only cancels', async () => {
    await dofOn();
    const before = await storedTrack(CAM, 'focusDistance');
    fireEvent.click(screen.getByRole('button', { name: 'Pick focus on canvas' }));
    expect(armed()).toBe(CAM);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(armed()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Pick focus on canvas' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick focus on canvas' }));
    expect(armed()).toBeNull();

    // The Shot header's verb arms the same pick (Depth of Field need not be on to aim it).
    fireEvent.click(screen.getByRole('button', { name: 'Focus on Layer' }));
    expect(armed()).toBe(CAM);
    await act(async () => { expect(await completeFocusPick(undefined, 0)).toBeNull(); });
    expect(armed()).toBeNull();
    await idle();
    settle();
    expect(await storedTrack(CAM, 'focusDistance')).toBe(before);
    expect(await historyLabels()).toEqual([]);
  });
});
