import { effectIdOfRow, groupEffectRows } from './effectRowGroups';
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
