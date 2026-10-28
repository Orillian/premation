/**
 * The keyframe selection bar against the real engine: what it shows for a
 * selection, that every button is ONE undo entry doing what it says, and the
 * edges a paid user will hit — a lock, a stale selection, a move that lands on
 * keys, several layers, the keyboard.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { engineIdle } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels, sec, settleEdits, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { rowSelectionId } from '@core/engine/__testHelpers__/selectionIds';
import { documentMirror } from '@stores/documentMirror';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { useUIStore } from '@stores/uiStore';
import { TooltipProvider } from '@components/Tooltip';
import { deleteKeyframesUi } from './keyframeEdits';
import { KeyframeSelectionBar } from './KeyframeSelectionBar';

let h: Harness;
let A = '';
let B = '';
const COMP = 'comp_root';
let playhead = 0;

async function keys(layer: string, pts: Array<[number, number]>): Promise<void> {
  await h.run({
    type: 'addKeyframes',
    keys: pts.map(([s, v]) => ({
      prop: { layer, path: 'transform/opacity' },
      time: sec(s),
      value: { kind: 'scalar' as const, value: v },
      easing: 'linear' as const,
      spatialIn: [],
      spatialOut: [],
    })),
  });
  await settleEdits();
  await documentMirror().loadTree(layer);
}

/** Opacity keys of a layer as [time, value], from the engine's document. */
async function opacity(layer: string): Promise<Array<[number, number]>> {
  return ((await docView()).getTrackKeyframes(layer, 'opacity') ?? []).map((k) => [Math.round(k.t * 1000) / 1000, Math.round(Number(k.value))]);
}

async function settle(): Promise<void> {
  await act(async () => { await engineIdle(); await settleEdits(); });
}

function select(...ids: string[]): void {
  act(() => { useKeyframeSelectionStore.getState().set(new Set(ids)); });
}

const btn = (name: string): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement;
const pressed = (name: string): boolean => btn(name).getAttribute('aria-pressed') === 'true';

// Focusing the × opens its tooltip, which measures itself (jsdom has no observer).
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
});

beforeEach(async () => {
  h = await setupAppEngine();
  A = (await h.run({ type: 'createLayer', comp: COMP, kind: 'solid', name: 'A', init: [] })).layer;
  B = (await h.run({ type: 'createLayer', comp: COMP, kind: 'solid', name: 'B', init: [] })).layer;
  await keys(A, [[0, 0], [1, 50], [2, 100]]);
  useKeyframeSelectionStore.getState().clear();
  playhead = 0;
});

afterEach(async () => {
  act(() => { useKeyframeSelectionStore.getState().clear(); });
  await h.dispose();
});

const renderBar = () => render(<TooltipProvider><KeyframeSelectionBar playheadTime={() => playhead} /></TooltipProvider>);

it('is not there without a selection, and comes and goes with it', () => {
  renderBar();
  expect(screen.queryByRole('toolbar')).toBeNull();
  select(rowSelectionId(A, 'opacity', 0));
  expect(screen.getByRole('toolbar', { name: 'Selected keyframes' })).toBeTruthy();
  fireEvent.click(btn('Deselect keyframes'));
  expect(screen.queryByRole('toolbar')).toBeNull();
});

it('counts keys, says when they span layers, and lights the ease they share', async () => {
  await keys(B, [[0, 10], [1, 20]]);
  renderBar();
  select(rowSelectionId(A, 'opacity', 0), rowSelectionId(A, 'opacity', 1));
  expect(screen.getByRole('toolbar').textContent).toContain('2 keys');
  expect(pressed('Linear')).toBe(true);
  select(rowSelectionId(A, 'opacity', 0), rowSelectionId(B, 'opacity', 0));
  expect(screen.getByRole('toolbar').textContent).toContain('2 layers');
});

it('Easy Ease is one undo entry and then shows as the selection’s ease', async () => {
  renderBar();
  select(rowSelectionId(A, 'opacity', 0), rowSelectionId(A, 'opacity', 1), rowSelectionId(A, 'opacity', 2));
  const before = (await historyLabels()).length;
  fireEvent.click(btn('Easy Ease'));
  await settle();
  expect((await historyLabels()).length).toBe(before + 1);
  expect(pressed('Easy Ease')).toBe(true);
  expect(pressed('Linear')).toBe(false);
});

it('Linear after Easy Ease straightens BOTH sides of each key', async () => {
  renderBar();
  select(rowSelectionId(A, 'opacity', 0), rowSelectionId(A, 'opacity', 1), rowSelectionId(A, 'opacity', 2));
  fireEvent.click(btn('Easy Ease'));
  await settle();
  // Now only the middle key: its arrival lives on key 0, its departure on itself.
  select(rowSelectionId(A, 'opacity', 1));
  fireEvent.click(btn('Linear'));
  await settle();
  expect(pressed('Linear')).toBe(true);
  const ks = documentMirror().keyframes(A, 'transform/opacity');
  // Key 0 keeps its eased departure but its far end (key 1's arrival) is straight.
  expect(ks[0]!.bezier?.x2).toBeCloseTo(2 / 3);
  expect(ks[0]!.bezier?.y2).toBeCloseTo(2 / 3);
  expect(ks[0]!.bezier?.y1).toBeCloseTo(0);
  // Key 1's own departure is straight.
  const k1 = ks[1]!;
  expect(k1.easing === 'linear' || Math.abs((k1.bezier?.x1 ?? 0) - (k1.bezier?.y1 ?? 1)) < 1e-6).toBe(true);
});

it('Ease In lights In, not Easy Ease, on a key with both sides', async () => {
  renderBar();
  select(rowSelectionId(A, 'opacity', 1));
  fireEvent.click(btn('In'));
  await settle();
  expect(pressed('In')).toBe(true);
  expect(pressed('Easy Ease')).toBe(false);
});

it('Hold toggles: on, then back to interpolating', async () => {
  renderBar();
  select(rowSelectionId(A, 'opacity', 0), rowSelectionId(A, 'opacity', 1));
  fireEvent.click(btn('Hold'));
  await settle();
  expect(pressed('Hold')).toBe(true);
  fireEvent.click(btn('Hold'));
  await settle();
  expect(pressed('Hold')).toBe(false);
  expect(pressed('Linear')).toBe(true);
});

it('Reverse needs two keys, and swaps them in one undo entry', async () => {
  renderBar();
  select(rowSelectionId(A, 'opacity', 0));
  expect(btn('Reverse').disabled).toBe(true);
  select(rowSelectionId(A, 'opacity', 0), rowSelectionId(A, 'opacity', 1));
  expect(btn('Reverse').disabled).toBe(false);
  const before = (await historyLabels()).length;
  fireEvent.click(btn('Reverse'));
  await settle();
  expect(await opacity(A)).toEqual([[0, 50], [1, 0], [2, 100]]);
  expect((await historyLabels()).length).toBe(before + 1);
});

it('To playhead keeps the spacing, and says when it replaced keys there', async () => {
  renderBar();
  act(() => { useUIStore.setState({ notifications: [] }); });
  // Keys 0 s and 1 s to a playhead at 5 s: free time, nothing replaced.
  select(rowSelectionId(A, 'opacity', 0), rowSelectionId(A, 'opacity', 1));
  playhead = 5;
  fireEvent.click(btn('To playhead'));
  await settle();
  expect(await opacity(A)).toEqual([[2, 100], [5, 0], [6, 50]]);
  expect(useUIStore.getState().notifications).toHaveLength(0);
});

it('To playhead onto an existing key warns, with Undo', async () => {
  renderBar();
  act(() => { useUIStore.setState({ notifications: [] }); });
  // Keys 0 s and 1 s by +1 s: the 1 s key lands on the unselected 2 s key.
  select(rowSelectionId(A, 'opacity', 0), rowSelectionId(A, 'opacity', 1));
  playhead = 1;
  fireEvent.click(btn('To playhead'));
  await settle();
  const notes = useUIStore.getState().notifications;
  expect(notes).toHaveLength(1);
  expect(notes[0]!.message).toContain('replaced 1 keyframe');
  expect(notes[0]!.action?.label).toBe('Undo');
});

it('does nothing on a locked layer, and says why', async () => {
  await h.run({ type: 'setLayerSwitches', layers: [A], patch: { locked: true } });
  await settle();
  renderBar();
  select(rowSelectionId(A, 'opacity', 0), rowSelectionId(A, 'opacity', 1));
  for (const name of ['Easy Ease', 'In', 'Out', 'Linear', 'Hold', 'Reverse', 'To playhead']) {
    expect(btn(name).disabled).toBe(true);
  }
  expect(btn('Easy Ease').title).toMatch(/locked layer/);
  // Deselect still works.
  expect(btn('Deselect keyframes').disabled).toBe(false);
});

it('drops keys that no longer exist from the count, and leaves when none are left', async () => {
  renderBar();
  const k0 = rowSelectionId(A, 'opacity', 0);
  const k1 = rowSelectionId(A, 'opacity', 1);
  select(k0, k1);
  // Deleted elsewhere while still in the selection (an API write, a script).
  await act(async () => { await deleteKeyframesUi([k1]); });
  await settle();
  expect(screen.getByRole('toolbar').textContent).toContain('1 key');
  await act(async () => { await deleteKeyframesUi([k0]); });
  await settle();
  expect(screen.queryByRole('toolbar')).toBeNull();
});

it('is one Tab stop and the arrows move between the enabled buttons', () => {
  renderBar();
  select(rowSelectionId(A, 'opacity', 0));
  const tabbable = screen.getAllByRole('button').filter((b) => b.tabIndex === 0);
  expect(tabbable).toHaveLength(1);
  const first = tabbable[0]!;
  first.focus();
  fireEvent.keyDown(screen.getByRole('toolbar'), { key: 'ArrowRight' });
  expect(document.activeElement).toBe(btn('In'));
  fireEvent.keyDown(screen.getByRole('toolbar'), { key: 'End' });
  expect(document.activeElement).toBe(btn('Deselect keyframes'));
  // Reverse is disabled with one key: Left from To playhead skips it.
  btn('To playhead').focus();
  fireEvent.keyDown(screen.getByRole('toolbar'), { key: 'ArrowLeft' });
  expect(document.activeElement).toBe(btn('Hold'));
});
