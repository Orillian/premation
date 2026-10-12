/**
 * Pop-out windows for plugin panels (P7d): a panel id `plugin:<plugin id>/<panel>`
 * holds a '/', so the pop-out route `/popout/:panelId` (AppRouter) only matches
 * it encoded. Main and the in-browser fallback encode (core/layout/popoutPath.ts),
 * PopoutRoute and the title bar decode.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { panelIdFromPopoutSegment, popoutHash, popoutSegment } from '@core/layout/popoutPath';

function Probe(): JSX.Element {
  const { panelId } = useParams<{ panelId: string }>();
  return <div data-testid="panel">{panelIdFromPopoutSegment(panelId ?? '')}</div>;
}

function routeTo(hashPath: string): string {
  render(
    <MemoryRouter initialEntries={[hashPath]}>
      <Routes>
        <Route path="/popout/:panelId" element={<Probe />} />
        <Route path="*" element={<div data-testid="panel">no match</div>} />
      </Routes>
    </MemoryRouter>,
  );
  return screen.getByTestId('panel').textContent ?? '';
}

describe('pop-out route ids', () => {
  const plugin = 'plugin:com.premation.samples.statspanel/stats';

  it('encodes a plugin panel id as one segment and decodes it back', () => {
    expect(popoutSegment(plugin)).not.toContain('/');
    expect(popoutHash(plugin)).toBe(`#/popout/${encodeURIComponent(plugin)}`);
    expect(panelIdFromPopoutSegment(popoutSegment(plugin))).toBe(plugin);
    // Built-in ids are unchanged either way; a malformed escape is kept as is.
    expect(popoutSegment('viewport')).toBe('viewport');
    expect(panelIdFromPopoutSegment('viewport')).toBe('viewport');
    expect(panelIdFromPopoutSegment('%E0%A4%A')).toBe('%E0%A4%A');
  });

  it('routes an encoded plugin panel id to the pop-out with the real id', () => {
    expect(routeTo(popoutHash(plugin).slice(1))).toBe(plugin);
  });

  it('routes a built-in panel id unchanged', () => {
    expect(routeTo(popoutHash('timeline').slice(1))).toBe('timeline');
  });

  it('an unencoded plugin id does not reach the pop-out route (the bug this fixes)', () => {
    expect(routeTo(`/popout/${plugin}`)).toBe('no match');
  });
});
