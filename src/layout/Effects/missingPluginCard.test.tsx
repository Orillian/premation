/**
 * The card for an effect with no definition says why.
 *
 * Found on the RTX box (2026-10-13, second app instance): a project using a
 * Premation Cloud plugin, opened without the plan, showed "Missing plugin
 * premation … until the plugin is installed" — the plugin WAS installed (locked),
 * and "premation" was the match name with its last segment cut off.
 */

import { act, render, screen } from '@testing-library/react';
import type { PluginInfo } from '@motion/engine-api';
import type { Effect } from '@core/inspector/effectCatalog';
import { resetPluginContribForTest, setPluginContrib } from '@core/nativePlugins/pluginContrib';
import { MissingPluginCard } from './PluginEffectParts';

const plugin = (status: PluginInfo['status'], error = ''): PluginInfo => ({
  id: 'premation.saber', name: 'Saber', version: '1.0.0', vendor: 'Premation', sdk: '1.0', status, error,
  effects: ['premation.saber'], gpu: false, panel: false, commands: [], importers: [], outputModules: [], panels: [],
} as unknown as PluginInfo);

const effect = { id: 'fx_1', type: 'premation.saber' } as Effect;

afterEach(() => resetPluginContribForTest());

it('names a locked Premation Cloud plugin and the way back', () => {
  act(() => setPluginContrib([plugin('locked', 'Requires Premation Cloud (no Premation Cloud sign-in on this computer)')]));
  render(<MissingPluginCard effect={effect} />);
  expect(screen.getByText(/Saber requires Premation Cloud\. The effect is kept and passes the layer through until the plan is active/)).toBeInTheDocument();
  expect(screen.queryByText(/Missing plugin/)).toBeNull();
});

it('says a turned-off plugin is off, and a failed one why', () => {
  act(() => setPluginContrib([plugin('disabled')]));
  const { unmount } = render(<MissingPluginCard effect={effect} />);
  expect(screen.getByText(/Saber is turned off/)).toBeInTheDocument();
  unmount();
  act(() => setPluginContrib([plugin('failed', 'built against SDK 2.0')]));
  render(<MissingPluginCard effect={effect} />);
  expect(screen.getByText(/Saber did not load: built against SDK 2\.0/)).toBeInTheDocument();
});

it('still says "missing" when no plugin claims the effect', () => {
  render(<MissingPluginCard effect={{ id: 'fx_2', type: 'com.acme.glow.glow' } as Effect} />);
  expect(screen.getByText(/Missing plugin com\.acme\.glow\./)).toBeInTheDocument();
});
