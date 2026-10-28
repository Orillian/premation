import { bakeFromCard } from './objectMatteEffect';
import type { Effect } from '@core/inspector/effectCatalog';

const card = (params: Record<string, unknown>): Effect => ({ id: 'fx_1', type: 'object-matte', params } as unknown as Effect);

describe('the Object Matte card feeds the next propagation', () => {
  it('reads its propagation settings; feather and choke are live, never baked', () => {
    expect(bakeFromCard(card({}))).toEqual({ edgeRadius: 6, decontaminate: 50, motionBlur: false, choke: 0, reduceChatter: 30, featherPx: 0 });
    expect(bakeFromCard(card({ edgeRadius: 10, decontaminationAmount: 80, motionBlur: true, chatterAmount: 60, feather: 9, shiftEdge: 40 }))).toEqual({
      edgeRadius: 10, decontaminate: 80, motionBlur: true, choke: 0, reduceChatter: 60, featherPx: 0,
    });
  });

  it('switches gate their amounts; Best doubles the edge radius; Render Refine Edge off bakes none', () => {
    expect(bakeFromCard(card({ decontaminate: false, reduceChatter: false }))).toMatchObject({ decontaminate: 0, reduceChatter: 0 });
    expect(bakeFromCard(card({ quality: 1, edgeRadius: 8 })).edgeRadius).toBe(16);
    expect(bakeFromCard(card({ renderRefineEdge: false, edgeRadius: 8 })).edgeRadius).toBe(0);
  });
});
