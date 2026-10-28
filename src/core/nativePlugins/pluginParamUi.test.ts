import type { ParamUiItem } from '@motion/engine-api';
import { DRAG_BEGIN, paramUiColor, paramUiDragCommand, paramUiHandleAt, paramUiPathData } from './pluginParamUi';

const item = (over: Partial<ParamUiItem>): ParamUiItem => ({
  kind: 'line', points: [], closed: false, color: [], handle: 0, shape: 0, text: '', size: 0, align: 0, ...over,
});

describe('plugin custom UI boxes (SDK 1.3)', () => {
  it('drags in box px through dragEffectParamUi', () => {
    expect(paramUiDragCommand('L1', 'fx_1', 'p7', 2, { x: 30, y: 12 }, { x: 10, y: 12 }, DRAG_BEGIN, 280)).toEqual({
      type: 'dragEffectParamUi', group: { layer: 'L1', path: 'effects/fx_1' }, key: 'p7', handle: 2,
      x: 30, y: 12, startX: 10, startY: 12, phase: 0, width: 280,
    });
  });

  it("takes the plugin's colour, else the theme's for the item's kind", () => {
    expect(paramUiColor(item({ color: [1, 0.5, 0, 0.25] }))).toBe('rgba(255, 128, 0, 0.25)');
    expect(paramUiColor(item({ color: [2, -1, 0] }))).toBe('rgba(255, 0, 0, 1)');
    expect(paramUiColor(item({ kind: 'handle' }))).toBe('var(--color-primary)');
    expect(paramUiColor(item({ kind: 'fill' }))).toBe('var(--color-surface-2)');
    expect(paramUiColor(item({ kind: 'text', color: [Number.NaN, 0, 0, 1] }))).toBe('var(--color-text-primary)');
  });

  it('draws paths open, closed paths and fills closed', () => {
    expect(paramUiPathData(item({ points: [0, 0, 10, 0, 10, 5] }))).toBe('M0 0L10 0L10 5');
    expect(paramUiPathData(item({ kind: 'path', closed: true, points: [0, 0, 10, 0, 10, 5] }))).toBe('M0 0L10 0L10 5Z');
    expect(paramUiPathData(item({ kind: 'fill', points: [0, 0, 10, 0, 10, 5] }))).toBe('M0 0L10 0L10 5Z');
    expect(paramUiPathData(item({ points: [1, 1] }))).toBe('');
  });

  it('grabs the topmost handle within reach, nothing else', () => {
    const items = [
      item({ kind: 'handle', handle: 1, points: [20, 20] }),
      item({ kind: 'line', points: [0, 0, 40, 40] }),
      item({ kind: 'handle', handle: 2, points: [24, 20] }),
    ];
    expect(paramUiHandleAt(items, 23, 21)?.handle).toBe(2);
    expect(paramUiHandleAt(items, 14, 20)?.handle).toBe(1);
    expect(paramUiHandleAt(items, 60, 60)).toBeNull();
  });
});
