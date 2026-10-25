/**
 * Every name in the vocabulary draws something.
 *
 * WHY THIS EXISTS. The glyphs are no longer components imported one per name —
 * they are path strings in a GENERATED table, produced from a mapping that lives
 * in a build script. That is a better arrangement, but it moves the failure mode:
 * a name can now go missing without anything failing to compile, because
 * `Record<IconName, …>` is satisfied by an entry whose value is an empty string,
 * and a `<path d="">` renders as nothing at all. A blank 16px square in a
 * toolbar is exactly the kind of thing that ships.
 *
 * So this asserts the property the type system cannot: that resolving a name
 * ends in real geometry, in both grades of the fill axis, for all of them.
 *
 * Plain Jest matchers only — jest-dom is imported at runtime by jest.setup.ts,
 * but that file sits outside tsconfig's `include`, so its matcher types are not
 * visible to `tsc -b`.
 */
import { render } from '@testing-library/react';

import { Icon, ICON_NAMES, type IconName, type IconWeight } from './Icon';
import { DRAWN_ICONS, PIXEL_ICON_NAMES } from './drawnIcons';
import { PIXEL_ICONS } from './pixelIcons.generated';
import { SHARP_ICON_PATHS } from './sharpIconPaths';

/**
 * The geometry a name resolves to: the path data for a glyph from the set, the
 * whole inner markup for a hand-drawn one (which may be circles and rects with
 * no `d` at all).
 */
function pathOf(name: IconName, weight?: IconWeight): string {
  const { container } = render(<Icon name={name} weight={weight} />);
  if (name in DRAWN_ICONS) return container.querySelector('svg')?.innerHTML ?? '';
  const path = container.querySelector('path');
  return path?.getAttribute('d') ?? '';
}

describe('the icon vocabulary resolves to geometry', () => {
  it.each(ICON_NAMES.map((n) => [n]))('%s draws an outline and a fill', (name) => {
    // 20 is well under the shortest real glyph and well over "" or "M0 0Z",
    // which is the class of thing a broken generator run would leave behind.
    expect(pathOf(name, 'regular').length).toBeGreaterThan(20);
    expect(pathOf(name, 'fill').length).toBeGreaterThan(20);
  });

  it('draws the outline grade by default', () => {
    // Owner decision 2026-10-14: thin outline chrome, not solid glyphs. It is a
    // one-word edit away from silently reverting to solid.
    expect(pathOf('folder')).toBe(pathOf('folder', 'regular'));
    expect(pathOf('folder')).not.toBe(pathOf('folder', 'fill'));
  });

  it('buckets the heavy weight names onto the solid grade', () => {
    // `bold` and `duotone` have no stroke to thicken here, so they resolve to
    // solid rather than becoming inert — see IconWeight in Icon.tsx.
    expect(pathOf('export', 'bold')).toBe(pathOf('export', 'fill'));
    expect(pathOf('export', 'light')).toBe(pathOf('export', 'regular'));
  });

  it('draws a hand-drawn name from drawnIcons, on its own grid', () => {
    // The drawn family is resolved FIRST. If that order flips, every tool icon
    // silently becomes the fallback square.
    const { container } = render(<Icon name="pencil" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 18 18');
    expect(svg?.getAttribute('stroke')).toBe('currentColor');
    expect(svg?.children.length).toBeGreaterThan(0);
  });

  it('draws the chrome set from the Fluent table for the box: the 16 or the 20 grid', () => {
    // A row glyph (sm = 16) takes the family's 16-grid drawing; a tool-bar glyph
    // (lg = 26) its 20-grid drawing. Both are filled outlines drawn at exactly
    // their own grid size: no stroke attributes, no scaling.
    const small = render(<Icon name="pen" size="sm" />).container.querySelector('svg');
    expect(small?.getAttribute('viewBox')).toBe('0 0 16 16');
    expect(small?.getAttribute('width')).toBe('16');
    expect(small?.getAttribute('fill')).toBe('currentColor');
    expect(small?.getAttribute('stroke')).toBeNull();
    const tool = render(<Icon name="pen" size="lg" />).container.querySelector('svg');
    expect(tool?.getAttribute('viewBox')).toBe('0 0 20 20');
    expect(tool?.getAttribute('width')).toBe('20');
    expect(tool?.querySelector('path')?.getAttribute('d')).not.toBe(small?.querySelector('path')?.getAttribute('d'));
    // Every chrome name has both drawings.
    for (const n of PIXEL_ICON_NAMES) {
      const t = PIXEL_ICONS[n === 'diamond' ? 'keyframe' : n];
      expect(t?.[16]).toBeTruthy();
      expect(t?.[20]).toBeTruthy();
    }
  });

  it('has a path for exactly the declared names, no more and no fewer', () => {
    // Guards the generator's two halves against drifting apart: a name added to
    // `iconNames.ts` without a mapping, or a mapping left behind after a name
    // was removed. The script itself throws on both, but only if someone runs it.
    // The two tables partition the vocabulary: a name in both would ship a
    // Material path that is never drawn.
    const drawn = Object.keys(DRAWN_ICONS);
    const fromSet = Object.keys(SHARP_ICON_PATHS);
    expect(fromSet.filter((n) => drawn.includes(n))).toEqual([]);
    expect([...fromSet, ...drawn].sort()).toEqual([...ICON_NAMES].sort());
  });

  it('draws the AI wordmark rather than a glyph from the set', () => {
    // `ai` is the one name the set does not serve — it is a lockup, and it is
    // drawn inline in the component. If that branch is ever dropped the name
    // still resolves, so the mistake would be silent without this.
    const { container } = render(<Icon name="ai" />);
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 34 34');
    expect(container.querySelectorAll('path').length).toBeGreaterThan(1);
  });

  it('gives the fill weight different geometry from the outline', () => {
    // The fill axis is the only thing `weight` still selects, so if the two
    // grades ever collapse to the same string the prop has quietly become inert.
    expect(pathOf('play', 'fill')).not.toBe(pathOf('play', 'regular'));
  });
});
