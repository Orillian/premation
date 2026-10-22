import type { EffectInfo, EffectParamInfo, EffectParamUi } from '@motion/engine-api';
import { effectInfoToDef } from './pluginEffectDefs';
import { paramUiFor, pluginCardSections, type PluginCardSection } from './pluginCardLayout';

const num = (matchName: string, name: string, group = '', animatable = true): EffectParamInfo => ({
  name, matchName, valueType: 'scalar', animatable, choices: [], unit: '', group, kind: '', fileTypes: '',
});

/** A Deep Glow-shaped effect: top-level rows, a point, two groups (one nested, one collapsed), inline buttons. */
const info: EffectInfo = {
  matchName: 'acme.glow', displayName: 'Glow', category: 'Acme', gpu: false, provider: 'acme', supportsFloat: true, audio: false,
  params: [
    num('p1', 'Radius'),
    num('p2X', 'Center X'), num('p2Y', 'Center Y'),
    num('p4', 'Threshold', 'Input'),
    num('p6', 'Blades', 'Input / Iris'),
    num('p8', 'Quality', 'Quality', false),
    num('p10', 'Opacity'),
  ],
  actions: [
    { key: 'p5', label: 'Swap', group: 'Input', at: 4 }, // last row of Input, before the nested group
    { key: 'p11', label: 'Shuffle', group: '', at: 7 }, // after everything
  ],
  groups: [
    { name: 'Input', key: 'p3', collapsed: false },
    { name: 'Input / Iris', key: 'p5g', collapsed: false },
    { name: 'Quality', key: 'p7', collapsed: true },
  ],
};
const def = effectInfoToDef(info);

const keys = (s: PluginCardSection) => s.items.map((it) => (it.kind === 'param' ? `${it.param.key}:${it.param.label}` : `[${it.label}]`));
const ui = (...entries: Array<Partial<EffectParamUi> & { key: string }>): Map<string, EffectParamUi> =>
  new Map(entries.map((e) => [e.key, { name: '', enabled: true, hidden: false, ...e }]));

it('keeps the plugin order: buttons inline in their group, groups open unless START_COLLAPSED', () => {
  const s = pluginCardSections(def, null);
  expect(s.map((x) => [x.group ?? '', x.collapsed])).toEqual([
    ['', false], ['Input', false], ['Input / Iris', false], ['Quality', true], ['', false],
  ]);
  expect(keys(s[0]!)).toEqual(['p1:Radius', 'p2X:Center X', 'p2Y:Center Y']);
  expect(keys(s[1]!)).toEqual(['p4:Threshold', '[Swap]']);
  expect(keys(s[4]!)).toEqual(['p10:Opacity', '[Shuffle]']);
});

it('hiding a GROUP_START hides the group and the groups inside it', () => {
  const s = pluginCardSections(def, ui({ key: 'p3', hidden: true }));
  expect(s.map((x) => x.group ?? '')).toEqual(['', 'Quality', '']);
  // Only the nested group: the outer one stays.
  expect(pluginCardSections(def, ui({ key: 'p5g', hidden: true })).map((x) => x.group ?? '')).toEqual(['', 'Input', 'Quality', '']);
});

it("a point's axes follow what the plugin says about the point", () => {
  expect(paramUiFor('p2X', ui({ key: 'p2', name: 'Origin' }))).toMatchObject({ key: 'p2X', name: 'Origin X' });
  expect(keys(pluginCardSections(def, ui({ key: 'p2', name: 'Origin' }))[0]!)).toEqual(['p1:Radius', 'p2X:Origin X', 'p2Y:Origin Y']);
  expect(keys(pluginCardSections(def, ui({ key: 'p2', hidden: true }))[0]!)).toEqual(['p1:Radius']);
  const disabled = pluginCardSections(def, ui({ key: 'p2', enabled: false }))[0]!.items;
  expect(disabled.map((it) => it.disabled)).toEqual([false, true, true]);
  // An own entry wins over the point's (a key that only looks like an axis).
  expect(paramUiFor('p2X', ui({ key: 'p2', hidden: true }, { key: 'p2X' }))?.hidden).toBe(false);
});

it('hides, renames and disables buttons like params', () => {
  const s = pluginCardSections(def, ui({ key: 'p5', hidden: true }, { key: 'p11', name: 'Randomise', enabled: false }));
  expect(keys(s[1]!)).toEqual(['p4:Threshold']);
  expect(s[4]!.items[1]).toEqual({ kind: 'button', key: 'p11', label: 'Randomise', disabled: true });
});

it('CANNOT_ANIMATE numbers are fixed', () => {
  expect([...def.fixed]).toEqual(['p8']);
});

it('carries descriptions (params, a point’s axes, groups) and the About text', () => {
  const described = effectInfoToDef({
    ...info,
    about: 'Glow 1.0 — Acme',
    params: [{ ...num('p2X', 'Center X'), description: 'Where the glow starts.' }, { ...num('p2Y', 'Center Y'), description: 'Where the glow starts.' }, num('p1', 'Radius')],
    groups: [{ name: 'Input', key: 'p3', collapsed: false, description: 'What glows.' }],
  });
  expect([...described.descriptions]).toEqual([['p2X', 'Where the glow starts.'], ['p2Y', 'Where the glow starts.']]);
  expect(described.about).toBe('Glow 1.0 — Acme');
  expect(def.about).toBe('');
  expect(described.groups[0]!.description).toBe('What glows.');
  expect(pluginCardSections(def, null)[1]!.description).toBe('');
});
