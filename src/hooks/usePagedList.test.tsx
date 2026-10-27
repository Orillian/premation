/**
 * usePagedList's `cacheKey`: the Renders and Trash tabs reopen on their last
 * page instead of an empty table, and never on another account's rows.
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { clear } from '@core/api/cache';
import type { Paginated } from '@core/api/transport';
import { usePagedList } from './usePagedList';

afterEach(cleanup);

type Row = { id: string };
const page = (ids: string[]): Paginated<Row> =>
  ({ items: ids.map((id) => ({ id })), total: ids.length, limit: 20, offset: 0 }) as Paginated<Row>;

function List({ fetcher, frames }: { fetcher: () => Promise<Paginated<Row>>; frames: string[] }): JSX.Element {
  const list = usePagedList<Row>(fetcher, { pageSize: 20, cacheKey: 'test:list' });
  const shown = list.status === 'loading' ? 'loading' : list.items.map((r) => r.id).join(',');
  frames.push(shown);
  return <span data-testid="rows">{shown}</span>;
}

describe('usePagedList cacheKey', () => {
  it('reopens on the last page it showed, then refreshes it', async () => {
    const fetcher = jest.fn().mockResolvedValue(page(['a', 'b']));
    const first = render(<List fetcher={fetcher} frames={[]} />);
    await waitFor(() => expect(screen.getByTestId('rows').textContent).toBe('a,b'));
    first.unmount();

    fetcher.mockResolvedValue(page(['a', 'b', 'c']));
    const frames: string[] = [];
    render(<List fetcher={fetcher} frames={frames} />);
    expect(frames[0]).toBe('a,b');
    await waitFor(() => expect(screen.getByTestId('rows').textContent).toBe('a,b,c'));
    expect(frames).not.toContain('loading');
  });

  it('starts empty again after sign-out', async () => {
    const fetcher = jest.fn().mockResolvedValue(page(['mine']));
    const first = render(<List fetcher={fetcher} frames={[]} />);
    await waitFor(() => expect(screen.getByTestId('rows').textContent).toBe('mine'));
    first.unmount();

    act(() => clear());
    fetcher.mockReturnValue(new Promise(() => {}));
    const frames: string[] = [];
    render(<List fetcher={fetcher} frames={frames} />);
    expect(frames[0]).toBe('loading');
  });
});
