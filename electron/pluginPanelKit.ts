/**
 * The panel kit (docs/PLUGIN_SDK.md "Matching the editor"): two files the app
 * serves inside EVERY plugin panel's own origin, at a path no bundle can ship
 * (bundle paths never start with a dot, pluginPanelProtocol.ts):
 *
 *   plugin-ui://<id>/.premation/premation-ui.css   the editor's look for plain HTML
 *   plugin-ui://<id>/.premation/premation-ui.js    applies the editor's `theme` messages
 *
 * A panel links them root-relative (`/.premation/premation-ui.css`) from any
 * page. Being same-origin, they pass the panel's CSP unchanged. Opting in is
 * the panel's choice — the After Effects / CEP model: the host offers its
 * colours and widgets, it never restyles a plugin's own UI.
 *
 * The stylesheet's `:root` values are the dark theme's (the editor's default),
 * so the first paint is already close; the script then sets the live values
 * from src/core/nativePlugins/panelTheme.ts's message. Public names (`--pm-*`)
 * are a contract: add, never rename.
 */

export const PANEL_KIT_DIR = '.premation';

const CSS = `/* Premation panel kit — served by the editor; do not copy into your bundle. */
:root {
  color-scheme: dark;
  --pm-surface-0: #171718;
  --pm-surface-1: #171718; /* the editor's panels (dark.css body.editor-active), not the dashboard's */
  --pm-surface-2: #35373d;
  --pm-surface-3: #444444;
  --pm-surface-hover: rgba(255, 255, 255, 0.04);
  --pm-surface-active: rgba(255, 255, 255, 0.08);
  --pm-surface-selected: rgba(29, 120, 227, 0.15);
  --pm-text: #e1e1e1;
  --pm-text-secondary: #a6a6a6;
  --pm-text-tertiary: #8c8c8c;
  --pm-text-disabled: #444444;
  --pm-border: #282828;
  --pm-border-strong: #35373d;
  --pm-border-subtle: #1e1e1e;
  --pm-field-border: rgba(255, 255, 255, 0.08);
  --pm-field-border-hover: rgba(255, 255, 255, 0.16);
  --pm-accent: #1d78e3;
  --pm-accent-hover: #328bf2;
  --pm-accent-active: #1562bf;
  --pm-accent-subtle: rgba(29, 120, 227, 0.15);
  --pm-accent-text: #80b0ff;
  --pm-on-accent: #ffffff;
  --pm-selection: #2988ff;
  --pm-focus-ring: rgba(255, 255, 255, 0.55);
  --pm-success: #10b981;
  --pm-warning: #f5b84b;
  --pm-danger: #f43f5e;
  --pm-info: #9a9a9e;
  --pm-font-family: "IBM Plex Sans", "Segoe UI", -apple-system, system-ui, sans-serif;
  --pm-font-family-mono: "IBM Plex Mono", "SF Mono", "Cascadia Code", Consolas, monospace;
  --pm-font-size: 12px;
  --pm-line-height: 16px;
  --pm-font-size-small: 11px;
  --pm-line-height-small: 16px;
  --pm-weight-label: 400;
  --pm-weight-value: 500;
  --pm-weight-heading: 600;
  --pm-radius: 2px;
  --pm-radius-surface: 4px;
  --pm-control-height: 22px;
  --pm-row-height: 24px;
  --pm-padding: 8px;
  --pm-gap: 6px;
}
:root[data-theme="light"] { color-scheme: light; }

*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; }
body {
  padding: var(--pm-padding);
  background: var(--pm-surface-1);
  color: var(--pm-text);
  font-family: var(--pm-font-family);
  font-size: var(--pm-font-size);
  line-height: var(--pm-line-height);
  font-weight: var(--pm-weight-label);
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3, h4 { margin: 0 0 var(--pm-gap); font-size: var(--pm-font-size); line-height: var(--pm-line-height); font-weight: var(--pm-weight-heading); }
p { margin: 0 0 var(--pm-gap); }
a { color: var(--pm-accent-text); text-decoration: none; }
a:hover { text-decoration: underline; }
hr { border: 0; border-top: 1px solid var(--pm-border); margin: var(--pm-gap) 0; }
code, kbd, samp, .pm-mono { font-family: var(--pm-font-family-mono); }
::selection { background: var(--pm-accent-subtle); }
:focus-visible { outline: 2px solid var(--pm-focus-ring); outline-offset: 1px; }

/* Buttons — the editor's bevelled control; .pm-primary is the accent fill. */
button, .pm-button {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: var(--pm-control-height); padding: 0 10px;
  border: 1px solid rgba(0, 0, 0, 0.45); border-radius: var(--pm-radius);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.01)), var(--pm-surface-2);
  color: var(--pm-text); font: inherit; font-weight: var(--pm-weight-value); line-height: 1;
  white-space: nowrap; cursor: pointer; user-select: none;
}
button:hover:not(:disabled), .pm-button:hover:not(:disabled) {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.09), rgba(255, 255, 255, 0.03)), var(--pm-surface-3);
}
button:active:not(:disabled), .pm-button:active:not(:disabled) { background: var(--pm-surface-1); }
button.pm-primary, .pm-button.pm-primary { background: var(--pm-accent); color: var(--pm-on-accent); }
button.pm-primary:hover:not(:disabled), .pm-button.pm-primary:hover:not(:disabled) { background: var(--pm-accent-hover); }
button.pm-primary:active:not(:disabled), .pm-button.pm-primary:active:not(:disabled) { background: var(--pm-accent-active); }
button.pm-quiet, .pm-button.pm-quiet { background: transparent; border-color: transparent; }
button.pm-quiet:hover:not(:disabled), .pm-button.pm-quiet:hover:not(:disabled) { background: var(--pm-surface-hover); }
:root[data-theme="light"] button:not(.pm-primary):not(.pm-quiet),
:root[data-theme="light"] .pm-button:not(.pm-primary):not(.pm-quiet) { border-color: var(--pm-border-strong); background: var(--pm-surface-2); }
button:disabled, .pm-button:disabled, input:disabled, select:disabled, textarea:disabled { opacity: 0.4; cursor: default; }

/* Fields — a dark well with a hairline, like the editor's inputs. */
input:not([type]), input[type="text"], input[type="number"], input[type="search"], input[type="email"],
input[type="url"], input[type="password"], select, textarea {
  height: var(--pm-control-height); padding: 0 6px; min-width: 0;
  background: var(--pm-surface-0); color: var(--pm-text);
  border: 1px solid var(--pm-field-border); border-radius: var(--pm-radius);
  font: inherit;
}
textarea { height: auto; padding: 4px 6px; resize: vertical; }
input[type="number"], .pm-value { font-family: var(--pm-font-family-mono); font-weight: var(--pm-weight-value); }
input:hover:not(:disabled), select:hover:not(:disabled), textarea:hover:not(:disabled) { border-color: var(--pm-field-border-hover); }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--pm-accent); }
::placeholder { color: var(--pm-text-tertiary); }
input[type="checkbox"], input[type="radio"], input[type="range"], progress { accent-color: var(--pm-accent); }
input[type="checkbox"], input[type="radio"] { margin: 0; }
input[type="color"] { width: 32px; height: var(--pm-control-height); padding: 1px; background: var(--pm-surface-0); border: 1px solid var(--pm-field-border); border-radius: var(--pm-radius); }

/* Layout helpers. */
.pm-row { display: flex; align-items: center; gap: var(--pm-gap); min-height: var(--pm-row-height); }
.pm-row > .pm-label { flex: 0 0 auto; min-width: 96px; }
.pm-row > .pm-grow, .pm-grow { flex: 1 1 auto; min-width: 0; }
.pm-label { color: var(--pm-text-secondary); }
.pm-hint { color: var(--pm-text-tertiary); font-size: var(--pm-font-size-small); line-height: var(--pm-line-height-small); }
.pm-section { border-top: 1px solid var(--pm-border); padding: var(--pm-gap) 0; }
.pm-section:first-child { border-top: 0; }
.pm-heading { font-weight: var(--pm-weight-heading); color: var(--pm-text); }
.pm-list { list-style: none; margin: 0; padding: 0; }
.pm-list > li { display: flex; align-items: center; min-height: var(--pm-row-height); padding: 0 6px; }
.pm-list > li:hover { background: var(--pm-surface-hover); }
.pm-list > li.pm-selected, .pm-list > li[aria-selected="true"] { background: var(--pm-surface-selected); }
.pm-success { color: var(--pm-success); }
.pm-warning { color: var(--pm-warning); }
.pm-danger { color: var(--pm-danger); }

/* Scrollbars — thin, like the editor's panels. */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--pm-surface-3); border: 3px solid transparent; border-radius: 5px; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background-color: var(--pm-text-tertiary); }
`;

const JS = `// Premation panel kit — served by the editor; do not copy into your bundle.
// Applies the editor's theme ({ premation: 1, type: 'theme', theme }) to this page:
// the --pm-* variables on :root, data-theme / data-contrast / data-density on <html>,
// then a 'premationtheme' event (detail: the theme) for a panel that draws on a canvas.
// window.premationTheme() returns the latest theme (null before the first).
(function () {
  'use strict';
  var root = document.documentElement;
  var current = null;
  function apply(theme) {
    var vars = theme && theme.vars;
    if (!vars || typeof vars !== 'object') return;
    for (var name in vars) {
      if (Object.prototype.hasOwnProperty.call(vars, name) && /^--pm-[a-z0-9-]+$/.test(name) && typeof vars[name] === 'string') {
        root.style.setProperty(name, vars[name]);
      }
    }
    root.setAttribute('data-theme', theme.name === 'light' ? 'light' : 'dark');
    root.setAttribute('data-contrast', theme.contrast === 'more' ? 'more' : 'normal');
    root.setAttribute('data-density', String(theme.density || 'default'));
    current = theme;
    window.dispatchEvent(new CustomEvent('premationtheme', { detail: theme }));
  }
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var m = e.data;
    if (m && m.premation === 1 && m.type === 'theme') apply(m.theme);
  });
  window.premationTheme = function () { return current; };
})();
`;

const FILES: Record<string, { body: string; contentType: string }> = {
  'premation-ui.css': { body: CSS, contentType: 'text/css; charset=utf-8' },
  'premation-ui.js': { body: JS, contentType: 'text/javascript; charset=utf-8' },
};

/** The kit file a panel URL's path segments name (`['.premation', 'premation-ui.css']`), or null. */
export function panelKitFile(segments: readonly string[]): { body: Buffer; contentType: string } | null {
  if (segments.length !== 2 || segments[0] !== PANEL_KIT_DIR) return null;
  const f = Object.prototype.hasOwnProperty.call(FILES, segments[1]!) ? FILES[segments[1]!] : undefined;
  return f ? { body: Buffer.from(f.body, 'utf8'), contentType: f.contentType } : null;
}
