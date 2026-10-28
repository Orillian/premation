import { matteSpans } from './MatteLane';

describe('matteSpans', () => {
  it('joins keys one frame apart into one run that covers its last frame', () => {
    const fps = 30;
    const keys = [0, 1, 2, 3].map((f) => f / fps);
    expect(matteSpans(keys, fps)).toEqual([{ start: 0, end: 4 / fps }]);
  });

  it('splits at a gap and accepts keys out of order', () => {
    const fps = 25;
    const keys = [10, 0, 1, 2, 11, 12].map((f) => f / fps);
    const spans = matteSpans(keys, fps);
    expect(spans).toHaveLength(2);
    expect(spans[0]!.start).toBeCloseTo(0);
    expect(spans[0]!.end).toBeCloseTo(3 / fps);
    expect(spans[1]!.start).toBeCloseTo(10 / fps);
    expect(spans[1]!.end).toBeCloseTo(13 / fps);
  });

  it('shows nothing for a single-frame selection (not propagated yet)', () => {
    expect(matteSpans([1], 30)).toEqual([]);
    expect(matteSpans([], 30)).toEqual([]);
  });
});
