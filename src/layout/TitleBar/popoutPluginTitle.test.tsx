/**
 * A popped-out plugin panel's title bar names the panel by its manifest
 * (2026-10-13 QA: the Layer Stats pop-out read
 * `plugin:com.premation.samples.statspanel/stats`). The pop-out window asks
 * the engine for the plugin list after its first paint; the title bar
 * follows that list instead of keeping the id it drew first.
 */

import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@radix-ui/react-tooltip';
import { TitleBar } from './TitleBar';
import { __setUiPlatformForTests } from '@core/config/uiPlatform';
import { popoutSegment } from '@core/layout/popoutPath';
import { resetPluginContribForTest, setPluginContrib } from '@core/nativePlugins/pluginContrib';

jest.mock('@layout/Export/ExportDialog', () => ({ openExportDialog: jest.fn() }));
jest.mock('@layout/Menu/useNativeMenuSync', () => ({ useNativeMenuSync: jest.fn() }));

const ID = 'plugin:com.premation.samples.statspanel/stats';

beforeEach(() => { (window as unknown as { electronAPI: unknown }).electronAPI = {}; });
afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  __setUiPlatformForTests(null);
  resetPluginContribForTest();
});

it('names a plugin pop-out by its panel once the plugin list arrives', () => {
  __setUiPlatformForTests({ platform: 'windows', windowControls: 'native' });
  render(
    <TooltipProvider>
      <MemoryRouter initialEntries={[`/popout/${popoutSegment(ID)}`]}>
        <TitleBar />
      </MemoryRouter>
    </TooltipProvider>,
  );
  act(() => {
    setPluginContrib([{
      id: 'com.premation.samples.statspanel', name: 'Stats Panel', version: '1.0.0', vendor: 'Premation', sdk: '1.2', status: 'loaded',
      error: '', effects: [], gpu: false, panels: [{ id: 'stats', name: 'Layer Stats', page: 'ui/stats.html' }],
    } as never]);
  });
  expect(screen.getByText('Layer Stats')).toBeInTheDocument();
  expect(screen.queryByText(ID)).toBeNull();
});
