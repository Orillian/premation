import { effectIdOfRow, groupEffectRows, objectMatteSelections } from './effectRowGroups';
import type { TimelinePropertyTrack } from './TimelineModel';

const row = (prop: string): TimelinePropertyTrack => ({ prop, label: prop, keyframes: [] }) as unknown as TimelinePropertyTrack;

describe('effect rows grouped per effect (AE: Effects ▸ <effect> ▸ params)', () => {
  it('reads the effect id off a param row', () => {
    expect(effectIdOfRow('effect.fx_1.radius')).toBe('fx_1');
    expect(effectIdOfRow('paint.s1.path')).toBeNull();
  });

  it('one group per effect, in STACK order, each with its own params; loose rows first', () => {
    const props = [row('effect.b.amount'), row('effect.a.radius'), row('paint.s1.path'), row('effect.a.intensity')];
    const groups = groupEffectRows(props, [{ id: 'a', enabled: true }, { id: 'b', enabled: false }], new Map([['a', 'Glow'], ['b', 'Glow 2']]));
    expect(groups.map((g) => [g.effectId, g.label, g.enabled, g.props.map((p) => p.prop)])).toEqual([
      [null, '', true, ['paint.s1.path']],
      ['a', 'Glow', true, ['effect.a.radius', 'effect.a.intensity']],
      ['b', 'Glow 2', false, ['effect.b.amount']],
    ]);
  });

  it('never drops the rows of an effect the headers do not list yet', () => {
    const groups = groupEffectRows([row('effect.z.k')], [], new Map());
    expect(groups).toEqual([{ effectId: 'z', label: 'z', enabled: true, props: [row('effect.z.k')] }]);
  });
});

describe('Object Matte selections (AE: Effects ▸ Object Matte ▸ Selections)', () => {
  const tree = (masks: Array<{ id: string; name: string; mode?: string; inverted?: boolean }>) => {
    const nodes = new Map<string, unknown>();
    nodes.set('masks', { name: 'Masks', children: masks.map((m) => `masks/${m.id}`) });
    for (const m of masks) {
      nodes.set(`masks/${m.id}`, { name: m.name, children: [] });
      if (m.mode) nodes.set(`masks/${m.id}/mode`, { name: 'Mode', value: { kind: 'choice', value: m.mode } });
      if (m.inverted !== undefined) nodes.set(`masks/${m.id}/inverted`, { name: 'Inverted', value: { kind: 'bool', value: m.inverted } });
    }
    return { layer: 'L', nodes } as unknown as Parameters<typeof objectMatteSelections>[0];
  };

  it('lists the tool-written masks in order, with Add / Subtract; other masks are not selections', () => {
    const sel = objectMatteSelections(tree([
      { id: 'a', name: 'Mask 1', mode: 'add' },
      { id: 'b', name: 'Object Matte', mode: 'none' },
      { id: 'c', name: 'Roto Brush', mode: 'subtract' },
      { id: 'd', name: 'Roto Brush (Frozen)', mode: 'add', inverted: true },
    ]));
    expect(sel).toEqual([
      { maskId: 'b', name: 'Object Matte', mode: 'add' },
      { maskId: 'c', name: 'Roto Brush', mode: 'subtract' },
      { maskId: 'd', name: 'Roto Brush (Frozen)', mode: 'subtract' },
    ]);
  });

  it('is empty without a tree or masks', () => {
    expect(objectMatteSelections(undefined)).toEqual([]);
    expect(objectMatteSelections(tree([]))).toEqual([]);
  });
});
