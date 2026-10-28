/**
 * The editor's look, handed to plugin panels (docs/PLUGIN_SDK.md "Matching the
 * editor"). After Effects' model: AE draws the params itself, and a plugin
 * that draws its own UI asks the host for its colours (`PF_AppColorSuite`;
 * CEP panels get the skin and a theme-changed event). A panel here gets:
 *
 *   editor → panel   { premation: 1, type: 'theme', theme }   on ready, on load
 *                                                                and on every change
 *
 * `theme.vars` are the PUBLIC names (`--pm-*`) with the editor's resolved
 * values. The names are a contract with third-party panels: add, never rename.
 * The editor tokens they read may move freely — only this table changes.
 *
 * The optional kit (`/.premation/premation-ui.css` + `premation-ui.js`, served
 * inside every panel's own origin by electron/pluginPanelKit.ts) applies them
 * and styles plain HTML controls like the editor's.
 *
 * Pure (no DOM, no React): the hook (src/hooks/usePanelTheme.ts) reads the
 * computed values and passes a reader in.
 */

import { PANEL_PROTOCOL } from './pluginPanel';

/** Public name → the editor token it reads (src/themes, src/tokens). */
export const PANEL_THEME_VARS = {
  // Surfaces: 0 the app ground, 1 panels, 2 controls / wells, 3 popovers.
  '--pm-surface-0': '--surface-0',
  '--pm-surface-1': '--surface-1',
  '--pm-surface-2': '--surface-2',
  '--pm-surface-3': '--surface-3',
  '--pm-surface-hover': '--surface-hover',
  '--pm-surface-active': '--surface-active',
  '--pm-surface-selected': '--surface-selected',
  // Text.
  '--pm-text': '--color-text-primary',
  '--pm-text-secondary': '--color-text-secondary',
  '--pm-text-tertiary': '--color-text-tertiary',
  '--pm-text-disabled': '--color-text-disabled',
  // Lines.
  '--pm-border': '--color-border',
  '--pm-border-strong': '--color-border-strong',
  '--pm-border-subtle': '--color-border-subtle',
  '--pm-field-border': '--color-field-border',
  '--pm-field-border-hover': '--color-field-border-hover',
  // The accent (primary buttons, checked controls, links) and selection.
  '--pm-accent': '--color-primary',
  '--pm-accent-hover': '--color-primary-hover',
  '--pm-accent-active': '--color-primary-active',
  '--pm-accent-subtle': '--color-primary-subtle',
  '--pm-accent-text': '--color-primary-text',
  '--pm-on-accent': '--color-primary-foreground',
  '--pm-selection': '--color-selection',
  '--pm-focus-ring': '--color-focus-ring',
  // Status.
  '--pm-success': '--color-success',
  '--pm-warning': '--color-warning',
  '--pm-danger': '--color-danger',
  '--pm-info': '--color-info',
  // Type: the panel roles the editor's own panels use.
  '--pm-font-family': '--panel-font-family',
  '--pm-font-family-mono': '--panel-font-family-value',
  '--pm-font-size': '--panel-font-size',
  '--pm-line-height': '--panel-line-height',
  '--pm-font-size-small': '--panel-font-size-help',
  '--pm-line-height-small': '--panel-line-height-help',
  '--pm-weight-label': '--panel-weight-label',
  '--pm-weight-value': '--panel-weight-value',
  '--pm-weight-heading': '--panel-weight-group',
  // Geometry, following the Density preference.
  '--pm-radius': '--radius-control',
  '--pm-radius-surface': '--radius-surface',
  '--pm-control-height': '--density-control-height',
  '--pm-row-height': '--density-row-height',
  '--pm-padding': '--density-panel-padding',
  '--pm-gap': '--density-panel-gap',
} as const;

export type PanelThemeVar = keyof typeof PANEL_THEME_VARS;

export interface PanelTheme {
  /** The resolved colour scheme. */
  name: 'dark' | 'light';
  /** 'more' while the high-contrast theme is in force. */
  contrast: 'normal' | 'more';
  density: 'compact' | 'default' | 'comfortable';
  /** Every public name with its value (a colour, a length, a font stack, a weight). */
  vars: Record<PanelThemeVar, string>;
}

export interface PanelThemeMessage {
  premation: typeof PANEL_PROTOCOL;
  type: 'theme';
  theme: PanelTheme;
}

const DENSITIES = ['compact', 'default', 'comfortable'] as const;

/**
 * The theme from the editor's root: `read(token)` is the token's computed value,
 * `scheme` the root's computed `color-scheme`, and its `data-contrast` /
 * `data-density` attributes.
 */
export function panelTheme(input: {
  read: (token: string) => string;
  scheme: string;
  contrast: string | null;
  density: string | null;
}): PanelTheme {
  const vars = {} as Record<PanelThemeVar, string>;
  for (const [name, token] of Object.entries(PANEL_THEME_VARS) as Array<[PanelThemeVar, string]>) {
    vars[name] = input.read(token).trim();
  }
  const density = DENSITIES.find((d) => d === input.density) ?? 'default';
  return {
    name: /\blight\b/.test(input.scheme) && !/\bdark\b/.test(input.scheme) ? 'light' : 'dark',
    contrast: input.contrast === 'more' ? 'more' : 'normal',
    density,
    vars,
  };
}

export function panelThemeMessage(theme: PanelTheme): PanelThemeMessage {
  return { premation: PANEL_PROTOCOL, type: 'theme', theme };
}

/** Same look? (A root attribute changed without changing a value: no message.) */
export function sameTheme(a: PanelTheme | null, b: PanelTheme): boolean {
  if (!a || a.name !== b.name || a.contrast !== b.contrast || a.density !== b.density) return false;
  return (Object.keys(b.vars) as PanelThemeVar[]).every((k) => a.vars[k] === b.vars[k]);
}
