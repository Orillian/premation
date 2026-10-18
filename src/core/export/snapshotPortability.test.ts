/**
 * Whether a project snapshot can be rendered by the export engine — the gate
 * that keeps window-only `blob:` footage off the out-of-process path (see
 * snapshotPortability.ts).
 */

import { setLocalFirst } from '@core/config/flags';
import { currentProjectSnapshotIsPortable, uncarriableMedia } from './snapshotPortability';

afterAll(() => setLocalFirst(false));

describe('uncarriableMedia', () => {
  it('durable and bundle srcs travel', () => {
    expect(uncarriableMedia([
      { id: 'a', src: 'https://cdn.example/x.mp4' },
      { id: 'b', src: 'data:image/png;base64,AAA' },
      { id: 'c', src: 'C:\\footage\\a.mov' },
      { id: 'd', src: 'file:///footage/a.mov' },
      { id: 'e', src: 'motion-blob:abc' },
      { id: 'f', src: '' },
    ])).toEqual([]);
  });

  it('a session blob: cannot travel', () => {
    const orphan = { id: 'g', src: ' blob:app/9' };
    expect(uncarriableMedia([orphan, { id: 'h', src: 'C:\\a.png' }])).toEqual([orphan]);
  });
});

describe('the live project', () => {
  it('does not depend on LOCAL_FIRST: a project with no footage always exports', () => {
    setLocalFirst(false);
    expect(currentProjectSnapshotIsPortable([])).toBe(true);
    expect(currentProjectSnapshotIsPortable([{ id: 'a', src: 'motion-blob:abc' }])).toBe(true);
    setLocalFirst(true);
    expect(currentProjectSnapshotIsPortable([])).toBe(true);
  });

  it('is false when any footage item is a session blob:', () => {
    expect(currentProjectSnapshotIsPortable([{ id: 'a', src: 'blob:1' }, { id: 'b', src: 'C:\\x.mov' }])).toBe(false);
  });
});
