/**
 * The editor's look for a plugin panel (core/nativePlugins/panelTheme.ts):
 * the public `--pm-*` values as this window's root computes them, refreshed
 * when the theme, contrast or density attribute flips. Returns the same
 * object until a value actually changes, so a panel is told once per change.
 */

import { useEffect, useState } from 'react';
import { panelTheme, sameTheme, type PanelTheme } from '@core/nativePlugins/panelTheme';

/** The root attributes the theme tokens key on (ThemeManager, applyUiPreferences). */
const THEME_ATTRIBUTES = ['data-theme', 'data-contrast', 'data-density', 'data-theme-mode'];

function readTheme(): PanelTheme {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  return panelTheme({
    read: (token) => style.getPropertyValue(token),
    scheme: style.colorScheme,
    contrast: root.getAttribute('data-contrast'),
    density: root.getAttribute('data-density'),
  });
}

export function usePanelTheme(): PanelTheme {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const refresh = (): void => {
      const next = readTheme();
      setTheme((prev) => (sameTheme(prev, next) ? prev : next));
    };
    const observer = new MutationObserver(refresh);
    // Every switch lands on one of these (an OS flip under "system" re-applies data-theme).
    observer.observe(document.documentElement, { attributes: true, attributeFilter: THEME_ATTRIBUTES });
    refresh();
    return () => observer.disconnect();
  }, []);
  return theme;
}
