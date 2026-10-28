/**
 * The Plugins panel's tree (docs/mockups/plugin-docking-ae.html, frame 4):
 * twirl rows, status words, and the Effects & Presets gestures — click
 * selects, double-click / Enter applies or opens, an effect row drags, the
 * arrow keys walk and twirl.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { engine } from '@core/engine/engineInstance';
import { setPluginEffectDefs } from '@core/inspector/pluginEffectDefs';
import { resetPluginContribForTest } from '@core/nativePlugins/pluginContrib';
import { setPluginPresets } from '@core/nativePlugins/pluginPresets';
import { edit } from '@core/engine/uiEdits';
import { addEffectEdit } from '@layout/Effects/effectEdits';
import { CANVAS_DRAG_MIME } from '@core/dnd/canvasDrag';
import { useLayoutStore } from '@stores/layoutStore';
import { useSelectionStore } from '@stores/selectionStore';
import { NativePluginsPanel } from './NativePluginsPanel';

jest.mock('@core/engine/engineInstance', () => {
  const engine = jest.fn();
  return { engine, pluginEngine: (...a: unknown[]) => engine(...a) };
});
jest.mock('@core/engine/uiEdits', () => ({ edit: jest.fn(async () => ({ ok: true })) }));
jest.mock('@layout/Effects/effectEdits', () => ({ addEffectEdit: jest.fn(async () => []) }));
// The engine's effect list is set by hand below; nothing may overwrite it.
jest.mock('@layout/Effects/effectCatalog', () => ({ useAllEffectDefs: () => [] }));

const glow = {
  id: 'premation.deepglow', name: 'Deep Glow', version: '1.0.0', vendor: 'Premation', sdk: '1.2', status: 'loaded',
  error: '', effects: ['premation.deepglow'], gpu: true, panel: true, commands: [], importers: [], outputModules: [],
  panels: [], presets: [],
};
const grade = { ...glow, id: 'acme.grade', name: 'Grade Lab', vendor: 'Acme', status: 'disabled', effects: [], panel: false };

const openPanel = jest.fn();
let realOpen: (id: string) => void;

beforeEach(() => {
  jest.mocked(engine).mockReturnValue({
    query: jest.fn(async () => ({ ok: true, value: { type: 'listPlugins', plugins: [glow, grade] }, revision: 1 })),
  } as never);
  setPluginEffectDefs([{ matchName: 'premation.deepglow', displayName: 'Deep Glow', category: 'Stylize', gpu: true, provider: 'premation.deepglow', params: [], supportsFloat: true, audio: false, actions: [], groups: [], customUis: [] }]);
  setPluginPresets([{ id: 'premation.deepglow', presets: [{ name: 'Neon', effect: 'premation.deepglow', values: [], category: '' }] }]);
  realOpen = useLayoutStore.getState().openPanel;
  useLayoutStore.setState({ openPanel });
  openPanel.mockClear();
  jest.mocked(edit).mockClear();
  jest.mocked(addEffectEdit).mockClear();
  useSelectionStore.setState({ ids: ['layer-1'], primary: 'layer-1' });
});

afterEach(() => {
  useLayoutStore.setState({ openPanel: realOpen });
  useSelectionStore.setState({ ids: [], primary: null });
  setPluginEffectDefs([]);
  setPluginPresets([]);
  resetPluginContribForTest();
});

const row = (name: RegExp): HTMLElement => screen.getByRole('treeitem', { name });

it('lists each plugin with its status word, meta line, effects, presets and panel', async () => {
  render(<NativePluginsPanel />);
  const plugin = await screen.findByRole('treeitem', { name: /^Deep Glow\s*Loaded/ });
  expect(plugin).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('Premation · v1.0.0')).toBeInTheDocument();
  expect(within(row(/Deep Glow\s*Effect/)).getByText('Effect')).toBeInTheDocument();
  expect(within(row(/Neon/)).getByText('Preset')).toBeInTheDocument();
  expect(within(row(/Deep Glow\s*Panel/)).getByText('Panel')).toBeInTheDocument();
  expect(within(row(/Grade Lab/)).getByText('Disabled')).toBeInTheDocument();
  expect(screen.getByRole('searchbox', { name: 'Search installed plugins' })).toBeInTheDocument();
});

it('applies an effect or a preset to the selected layers on double-click, and drags an effect', async () => {
  render(<NativePluginsPanel />);
  await screen.findByRole('treeitem', { name: /^Deep Glow\s*Loaded/ });

  fireEvent.click(row(/Deep Glow\s*Effect/));
  expect(row(/Deep Glow\s*Effect/)).toHaveAttribute('aria-selected', 'true');
  expect(addEffectEdit).not.toHaveBeenCalled();
  fireEvent.doubleClick(row(/Deep Glow\s*Effect/));
  expect(addEffectEdit).toHaveBeenCalledWith(['layer-1'], 'premation.deepglow');

  fireEvent.doubleClick(row(/Neon/));
  expect(edit).toHaveBeenCalledWith('Apply Neon', expect.objectContaining({ type: 'addEffect' }));

  const setData = jest.fn();
  fireEvent.dragStart(row(/Deep Glow\s*Effect/), { dataTransfer: { setData, effectAllowed: '' } });
  expect(setData).toHaveBeenCalledWith(CANVAS_DRAG_MIME, JSON.stringify({ kind: 'effect', effectType: 'premation.deepglow' }));
});

it('opens a plugin panel on double-click and marks a docked one open', async () => {
  const order = useLayoutStore.getState().panelOrder;
  useLayoutStore.setState({ panelOrder: { ...order, rightInspector: [...(order.rightInspector ?? []), 'plugin:premation.deepglow'] } });
  const { unmount } = render(<NativePluginsPanel />);
  try {
    await screen.findByRole('treeitem', { name: /^Deep Glow\s*Loaded/ });
    expect(within(row(/Deep Glow\s*Panel · open/)).getByText('Panel · open')).toBeInTheDocument();
    fireEvent.doubleClick(row(/Deep Glow\s*Panel/));
    expect(openPanel).toHaveBeenCalledWith('plugin:premation.deepglow');
  } finally {
    unmount();
    useLayoutStore.setState({ panelOrder: order });
  }
});

it('walks with the arrow keys, twirls with Left / Right, and Enter acts', async () => {
  render(<NativePluginsPanel />);
  await screen.findByRole('treeitem', { name: /^Deep Glow\s*Loaded/ });
  const tree = screen.getByRole('tree', { name: 'Installed plugins' });

  fireEvent.click(row(/^Deep Glow\s*Loaded/));
  fireEvent.keyDown(tree, { key: 'ArrowDown' });
  expect(row(/Deep Glow\s*Effect/)).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(tree, { key: 'ArrowDown' });
  expect(row(/Neon/)).toHaveAttribute('aria-selected', 'true');
  await act(async () => { fireEvent.keyDown(tree, { key: 'Enter' }); });
  expect(edit).toHaveBeenCalledWith('Apply Neon', expect.anything());

  // Left on a child goes to its plugin; Left again twirls it shut.
  fireEvent.keyDown(tree, { key: 'ArrowLeft' });
  expect(row(/^Deep Glow\s*Loaded/)).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(tree, { key: 'ArrowLeft' });
  expect(row(/^Deep Glow\s*Loaded/)).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('treeitem', { name: /Neon/ })).toBeNull();
  fireEvent.keyDown(tree, { key: 'ArrowRight' });
  expect(row(/^Deep Glow\s*Loaded/)).toHaveAttribute('aria-expanded', 'true');
});

it('filters by the search, keeping the plugin above what matched', async () => {
  render(<NativePluginsPanel />);
  await screen.findByRole('treeitem', { name: /^Deep Glow\s*Loaded/ });
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search installed plugins' }), { target: { value: 'neon' } });
  expect(await screen.findByRole('treeitem', { name: /Neon/ })).toBeInTheDocument();
  expect(screen.queryByRole('treeitem', { name: /Grade Lab/ })).toBeNull();
  expect(row(/^Deep Glow\s*Loaded/)).toBeInTheDocument();
});
