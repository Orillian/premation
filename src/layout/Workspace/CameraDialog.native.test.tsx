/**
 * U4: New Camera, task-led — the app Dropdown lens picker with a live angle
 * of view, "Aim at a target / Free", and "Make all layers 3D" (on by default
 * when the comp has no 3D layer) landing in the SAME undo entry as the camera.
 */

import { render, cleanup, fireEvent, screen, act, waitFor } from '@testing-library/react';
import { setupAppEngine, historyLabels, clearHistory, storedTrack } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { POI_PATH } from '@core/engine/pointOfInterest';
import { uiKindOf } from '@core/mirror/layerKinds';
import { focalPxForMm, fovForMm } from '@core/scene/lensPresets';
import { CameraDialog } from './SceneInsertDialogs';

let h: Harness;

beforeEach(async () => { h = await setupAppEngine(); });
afterEach(async () => {
  cleanup();
  await h.dispose();
});

const idle = async (): Promise<void> => { await act(async () => { await engineIdle(); await documentMirror().whenIdle(); }); };

async function shapeLayer(name: string, threeD = false): Promise<string> {
  let id = '';
  await act(async () => {
    ({ layer: id } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name, init: [] }));
    if (threeD) await h.run({ type: 'setLayerSwitches', layers: [id], patch: { threeD: true } });
    await engineIdle();
  });
  await idle();
  await clearHistory();
  return id;
}

const cameras = (): string[] => documentMirror().layerIds().filter((id) => uiKindOf(documentMirror().layer(id)) === 'camera');
const makeAll3D = (): HTMLInputElement => screen.getByRole('checkbox', { name: 'Make all layers 3D' }) as HTMLInputElement;

describe('New Camera', () => {
  it('creates the camera AND switches the comp\'s layers to 3D as ONE undo entry', async () => {
    const a = await shapeLayer('A');
    const b = await shapeLayer('B');
    const close = jest.fn();
    render(<CameraDialog close={close} />);
    // No 3D layer in the comp: the fix is on by default.
    expect(makeAll3D().checked).toBe(true);

    // The lens is the app Dropdown over the shared list; the angle of view follows live.
    fireEvent.click(screen.getByRole('button', { name: 'Lens' }));
    fireEvent.click(screen.getByText('35mm — Reportage'));
    expect(screen.getByRole('button', { name: 'Lens' }).textContent).toBe('35mm — Reportage');
    expect(screen.getByTestId('camera-angle-of-view').textContent).toContain(`${fovForMm(35).toFixed(1)}°`);
    fireEvent.click(screen.getByRole('radio', { name: 'Aim at a target' }));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create camera' })); });
    // The create reads the comp's layer trees before it inserts.
    await waitFor(() => expect(cameras()).toHaveLength(1));
    await idle();
    expect(close).toHaveBeenCalled();
    const [cam] = cameras();
    expect(cam).toBeDefined();
    expect(documentMirror().layer(a)?.switches.threeD).toBe(true);
    expect(documentMirror().layer(b)?.switches.threeD).toBe(true);
    await act(async () => { await documentMirror().loadTree(cam!); });
    const poi = documentMirror().property(cam!, POI_PATH)?.value;
    expect(poi?.kind === 'bool' && poi.value).toBe(true);
    expect(await storedTrack(cam!, 'focalLength')).toBeCloseTo(Math.round(focalPxForMm(1920, 35)), 0);
    expect(await historyLabels()).toEqual(['New Camera']);

    // One Undo takes back the camera and the switches together.
    await act(async () => { await h.run({ type: 'undo' }); });
    await idle();
    expect(cameras()).toHaveLength(0);
    expect(documentMirror().layer(a)?.switches.threeD).toBe(false);
    expect(documentMirror().layer(b)?.switches.threeD).toBe(false);
  });

  it('leaves "Make all layers 3D" off when the comp already has a 3D layer, and then touches no switch', async () => {
    await shapeLayer('Deep', true);
    const flat = await shapeLayer('Flat');
    render(<CameraDialog close={() => undefined} />);
    expect(makeAll3D().checked).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create camera' })); });
    await idle();
    expect(cameras()).toHaveLength(1);
    expect(documentMirror().layer(flat)?.switches.threeD).toBe(false);
    expect(await historyLabels()).toEqual(['New Camera']);
  });
});
