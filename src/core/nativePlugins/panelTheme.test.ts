import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PANEL_THEME_VARS, panelTheme, panelThemeMessage, sameTheme, type PanelThemeVar } from './panelTheme';

const SRC = join(__dirname, '..', '..');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const declared = (css: string) => new Set([...strip(css).matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]!));

const read = (token: string) => `  value-of(${token}) `;

describe('plugin panel theme', () => {
  it('reads every public name from its editor token, trimmed', () => {
    const t = panelTheme({ read, scheme: 'dark', contrast: null, density: 'compact' });
    expect(Object.keys(t.vars)).toEqual(Object.keys(PANEL_THEME_VARS));
    expect(t.vars['--pm-surface-1']).toBe('value-of(--surface-1)');
    expect(t.vars['--pm-accent']).toBe('value-of(--color-primary)');
    expect(t).toMatchObject({ name: 'dark', contrast: 'normal', density: 'compact' });
  });

  it('names the scheme, the contrast and the density, defaulting what it does not know', () => {
    expect(panelTheme({ read, scheme: 'light', contrast: 'more', density: null })).toMatchObject({ name: 'light', contrast: 'more', density: 'default' });
    expect(panelTheme({ read, scheme: 'light dark', contrast: 'less', density: 'huge' })).toMatchObject({ name: 'dark', contrast: 'normal', density: 'default' });
    expect(panelTheme({ read, scheme: '', contrast: null, density: null }).name).toBe('dark');
  });

  it('wraps it in the panel protocol and tells a change from a re-apply', () => {
    const a = panelTheme({ read, scheme: 'dark', contrast: null, density: null });
    expect(panelThemeMessage(a)).toEqual({ premation: 1, type: 'theme', theme: a });
    expect(sameTheme(null, a)).toBe(false);
    expect(sameTheme(a, panelTheme({ read, scheme: 'dark', contrast: null, density: null }))).toBe(true);
    expect(sameTheme(a, panelTheme({ read, scheme: 'light', contrast: null, density: null }))).toBe(false);
    const moved = panelTheme({ read: (t) => (t === '--color-primary' ? '#f00' : read(t)), scheme: 'dark', contrast: null, density: null });
    expect(sameTheme(a, moved)).toBe(false);
  });

  it('maps only to tokens the editor declares (a renamed token fails here, not in a plugin)', () => {
    const tokens = new Set<string>();
    for (const dir of ['tokens', 'themes']) {
      for (const f of ['colors', 'density', 'radius', 'typography', 'spacing', 'dark', 'light']) {
        try {
          for (const n of declared(readFileSync(join(SRC, dir, `${f}.css`), 'utf8'))) tokens.add(n);
        } catch {
          /* not in this folder */
        }
      }
    }
    const light = declared(readFileSync(join(SRC, 'themes', 'light.css'), 'utf8'));
    const dark = declared(readFileSync(join(SRC, 'themes', 'dark.css'), 'utf8'));
    const tokensUsed = Object.values(PANEL_THEME_VARS);
    expect(tokensUsed.filter((t) => !tokens.has(t))).toEqual([]);
    // A theme colour must be set by BOTH themes, or a panel keeps the other theme's value.
    expect(tokensUsed.filter((t) => dark.has(t) && !light.has(t))).toEqual([]);
  });

  it('the kit stylesheet declares a fallback for every public name and the kit script applies only --pm-*', () => {
    const kit = readFileSync(join(SRC, '..', 'electron', 'pluginPanelKit.ts'), 'utf8');
    const css = declared(kit);
    expect((Object.keys(PANEL_THEME_VARS) as PanelThemeVar[]).filter((n) => !css.has(n))).toEqual([]);
    expect(kit).toContain('/^--pm-[a-z0-9-]+$/');
  });
});
