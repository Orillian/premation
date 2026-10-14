/**
 * U3: the Shot header of the camera Inspector — the lens picker, the camera
 * moves as one-click buttons and the shot verbs lead the section; a camera
 * move is ONE undo entry; the "no 3D layers" warning and its fix lead the
 * section when they apply.
 *
 * On the app's engine (B3): layers are created through the engine API, and
 * the assertions read the engine's history and document back.
 */

import { render, cleanup, fireEvent, screen, act, within } from '@testing-library/react';
import { CameraSection } from './CameraSection';
import { SHOT_PRESETS, lensTriggerLabel } from './CameraShotHeader';
import { useSelectionStore } from '@stores/selectionStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { clearHistory, setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { focalPxForMm } from '@core/scene/lensPresets';

jest.useFakeTimers();

let h: Harness;
let CAM = '';

async function setup(extra?: () => Promise<void>): Promise<void> {
  await act(async () => {
    ({ layer: CAM } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'camera', name: 'Shot camera', init: [] }));
    if (extra) await extra();
    await engineIdle();
    await documentMirror().loadTree(CAM);
  });
  await clearHistory();
  useSelectionStore.setState({ ids: [CAM] } as never);
}

beforeEach(async () => {
  h = await setupAppEngine();
  usePreferenceStore.getState().set('inspectorSections', {});
});
afterEach(async () => {
  cleanup();
  await h.dispose();
});

const idle = async (): Promise<void> => { await act(async () => { await engineIdle(); await documentMirror().whenIdle(); }); };
/** No second entry from the 700 ms recorder on top of the engine's. */
const settle = (): void => { act(() => { jest.advanceTimersByTime(2000); }); };

describe('the Shot header', () => {
  it('leads the section: Lens picker, the six camera moves, the shot verbs', async () => {
    await setup();
    render(<CameraSection nodeId={CAM} />);
    const lens = screen.getByRole('button', { name: 'Lens' });
    const moves = screen.getByRole('group', { name: 'Camera moves' });
    for (const p of SHOT_PRESETS) {
      expect({ move: p.label, drawn: within(moves).queryAllByRole('button', { name: p.label }).length }).toEqual({ move: p.label, drawn: 1 });
    }
    expect(screen.getByRole('button', { name: 'Distribute in Z' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Orbit Null' })).toBeInTheDocument();
    // Above the lens rows it replaces as the first thing a user reads.
    const zoom = screen.getAllByLabelText('Angle of View')[0]!;
    expect(lens.compareDocumentPosition(zoom) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(moves.compareDocumentPosition(zoom) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a camera-move click is ONE undo entry that keys the camera', async () => {
    await setup();
    render(<CameraSection nodeId={CAM} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Push In' })); });
    await idle();
    settle();
    expect(await historyLabels()).toEqual(['Apply Push In']);
    await act(async () => { await documentMirror().loadTree(CAM); });
    const tree = documentMirror().tree(CAM);
    expect([...(tree?.nodes.values() ?? [])].some((n) => n.animated)).toBe(true);
  });

  it('the lens picker is the shared list: the lens in force ticked, "Custom" off-list, a pick is one entry', async () => {
    await setup();
    render(<CameraSection nodeId={CAM} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Lens' })); });
    await act(async () => { fireEvent.click(screen.getByText('135mm — Tele')); });
    await idle();
    settle();
    expect(await historyLabels()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Lens' }).textContent).toContain('135mm — Tele');
    // An off-list Zoom reads as Custom, with its millimetres — never the nearest preset.
    expect(lensTriggerLabel(1920, focalPxForMm(1920, 42))).toBe('Custom · 42.0 mm');
  });
});

describe('the no-3D warning', () => {
  it('leads the section when the comp has layers and none is 3D, and Make All 3D fixes it in one entry', async () => {
    let SOLID = '';
    await setup(async () => {
      ({ layer: SOLID } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'Flat', init: [] }));
    });
    render(<CameraSection nodeId={CAM} />);
    const note = screen.getByRole('note');
    expect(note.textContent).toBe('No 3D layers — the camera moves nothing yet.');
    expect(note.compareDocumentPosition(screen.getByRole('button', { name: 'Lens' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const fixes = screen.getAllByRole('button', { name: 'Make All 3D' });
    expect(fixes).toHaveLength(1);
    await act(async () => { fireEvent.click(fixes[0]!); });
    await idle();
    settle();
    expect(documentMirror().layer(SOLID)?.switches.threeD).toBe(true);
    expect(await historyLabels()).toEqual(['Make All Layers 3D']);
    expect(screen.queryByRole('note')).toBeNull();
  });
});
