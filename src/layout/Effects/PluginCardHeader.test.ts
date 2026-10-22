import { pluginIconUrl } from './PluginCardHeader';

it('serves a manifest icon from the bundle ui/ folder through plugin-ui://', () => {
  expect(pluginIconUrl({ id: 'Premation.DeepGlow', icon: 'ui/icon.png' })).toBe('plugin-ui://premation.deepglow/icon.png');
  expect(pluginIconUrl({ id: 'x', icon: 'ui/img/my logo.svg' })).toBe('plugin-ui://x/img/my%20logo.svg');
  expect(pluginIconUrl({ id: 'x', icon: 'icon.png' })).toBeNull(); // not under ui/: main does not serve it
  expect(pluginIconUrl({ id: 'x' })).toBeNull();
  expect(pluginIconUrl(undefined)).toBeNull();
});
