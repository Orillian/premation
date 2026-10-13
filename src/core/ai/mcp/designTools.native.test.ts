/**
 * The design machinery an MCP client can now reach, on the real engine: a
 * look, a library technique on Claude's own layers, a whole cast piece from a
 * brief, and the review — each one undo step.
 */

import { setupAppEngine, historyLabels, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { documentMirror } from '@stores/documentMirror';
import { McpCallHost, type McpResult } from './mcpHost';
import { editorMcpDeps } from './mcpDefaults';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });
jest.setTimeout(60_000);

let h: Harness;
let host: McpCallHost;
beforeEach(async () => {
  h = await setupAppEngine();
  host = new McpCallHost({ ...editorMcpDeps(), access: async () => ({ ok: true }), renderStrip: async () => null });
});
afterEach(async () => {
  await host.stop();
  await h.dispose();
});

const call = (name: string, args: unknown = {}): Promise<McpResult> => host.handle({ clientId: 1, name, args });
const textOf = (r: McpResult): string => r.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');
const layerCount = (): number => documentMirror().layerIds().length;

/**
 * What an MCP Claude does before casting: read the menus and choose a layout
 * and a technique per beat. Premation no longer picks for it.
 */
async function picksFor(brief: Record<string, unknown>): Promise<{ layoutPicks: { beatIndex: number; id: string }[]; motionPicks: { beatIndex: number; id: string }[] }> {
  const menus = textOf(await call('cast_piece', { ...brief, menusOnly: true }));
  const layoutPicks: { beatIndex: number; id: string }[] = [];
  const motionPicks: { beatIndex: number; id: string }[] = [];
  for (const m of menus.matchAll(/── (LAYOUT|MOTION) for beat (\d+) ──\n([\s\S]*?)(?=\n── |$)/g)) {
    const ids = [...m[3]!.matchAll(/^\s*([a-z][a-z0-9_]*\.[a-z0-9_]+)\s+—/gm)].map((x) => x[1]!);
    const beatIndex = Number(m[2]);
    if (m[1] === 'LAYOUT') layoutPicks.push({ beatIndex, id: ids[beatIndex % ids.length]! });
    else {
      const moving = ids.filter((id) => /^(entrance|kinetic_type)\./.test(id));
      motionPicks.push({ beatIndex, id: (moving.length ? moving : ids)[beatIndex % (moving.length || ids.length)]! });
    }
  }
  return { layoutPicks, motionPicks };
}

describe('design tools on the engine', () => {
  it('lists looks and techniques, and applying a look orders techniques by it', async () => {
    expect(textOf(await call('list_looks'))).toMatch(/swiss_editorial/);
    const look = await call('apply_look', { lookId: 'luxury_film', accent: '#c8a46b' });
    expect(look.isError).toBeUndefined();
    expect(textOf(look)).toMatch(/Look "/);
    const t = textOf(await call('list_techniques', { category: 'entrance' }));
    expect(t).toMatch(/entrance\.\w+/);
    expect(t).toMatch(/suit/);
    expect((await call('apply_look', { lookId: 'nope' })).isError).toBe(true);
  });

  it('animates Claude\'s own layers with a technique, as one undo step', async () => {
    await call('create_layer', { id: 'hl', kind: 'text', name: 'Headline', text: 'NOVA' });
    const before = await h.doc();
    const r = await call('apply_technique', { id: 'entrance.rise_settle', targets: { headline: ['hl'] }, startSec: 0.2 });
    expect(textOf(r)).toMatch(/steps applied/);
    expect(r.isError).toBeUndefined();
    expect((await historyLabels()).at(-1)).toBe('Claude: apply technique');
    await h.run({ type: 'undo' });
    expect(await h.doc()).toBe(before);
  });

  it('refuses a technique with a role it does not animate, or a missing layer', async () => {
    expect((await call('apply_technique', { id: 'entrance.rise_settle', targets: { banana: ['x'] } })).isError).toBe(true);
    expect((await call('apply_technique', { id: 'entrance.rise_settle', targets: { headline: ['no_such'] } })).isError).toBe(true);
    expect((await call('apply_technique', { id: 'made.up' })).isError).toBe(true);
  });

  it('shows the cast menus without building anything', async () => {
    const before = layerCount();
    const r = await call('cast_piece', { tone: 'launch', beats: [{ purpose: 'hook', content: { headline: 'Meet Nova' } }], menusOnly: true });
    expect(textOf(r)).toMatch(/LAYOUT for beat 0/);
    expect(textOf(r)).toMatch(/MOTION for beat 0/);
    expect(layerCount()).toBe(before);
  });

  it('builds nothing when a beat has no pick — the menus come back instead', async () => {
    const before = layerCount();
    const r = await call('cast_piece', {
      tone: 'launch',
      beats: [
        { purpose: 'hook', content: { headline: 'Meet Nova' } },
        { purpose: 'cta', content: { headline: 'Pre-order', cta: 'nova.audio' } },
      ],
    });
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toMatch(/Nothing was built: no pick for layout for beat 0/);
    expect(textOf(r)).toMatch(/MOTION for beat 1/);
    expect(layerCount()).toBe(before);
  });

  it('casts a whole piece from a brief as one undo step', async () => {
    await call('apply_look', { lookId: 'swiss_editorial' });
    const before = await h.doc();
    const brief = {
      tone: 'A calm product launch for Nova headphones',
      energy: 0.4,
      durationSec: 8,
      beats: [
        { purpose: 'hook', content: { overline: 'Introducing', headline: 'Nova' } },
        { purpose: 'stat', content: { items: [{ value: '40h', label: 'battery' }, { value: '−32dB', label: 'noise' }] } },
        { purpose: 'cta', content: { headline: 'Pre-order today', cta: 'nova.audio' } },
      ],
      variants: 2,
    };
    const r = await call('cast_piece', { ...brief, ...(await picksFor(brief)) });
    expect(textOf(r)).toMatch(/^Cast "/);
    expect(r.isError).toBeUndefined();
    expect(layerCount()).toBeGreaterThan(3);
    // Real motion, not bare fades: the cast picked techniques that move things.
    expect(textOf(await call('describe_scene'))).toMatch(/"animated":\[[^\]]*"(y|scale|x)"/);
    expect((await historyLabels()).at(-1)).toBe('Claude: cast piece');
    await h.run({ type: 'undo' });
    expect(await h.doc()).toBe(before);
  });

  it('casting again REPLACES the piece — one copy, one undo entry per cast (M1)', async () => {
    await call('apply_look', { lookId: 'swiss_editorial' });
    const outline = {
      tone: 'A calm product launch for Nova headphones',
      durationSec: 8,
      beats: [
        { purpose: 'hook', content: { overline: 'Introducing', headline: 'Nova' } },
        { purpose: 'cta', content: { headline: 'Pre-order today', cta: 'nova.audio' } },
      ],
      variants: 1,
    };
    const brief = { ...outline, ...(await picksFor(outline)) };
    const first = await call('cast_piece', brief);
    expect(first.isError).toBeUndefined();
    const once = layerCount();
    const second = await call('cast_piece', brief);
    expect(second.isError).toBeUndefined();
    expect(textOf(second)).toMatch(/Replaced the piece cast earlier in this session \(\d+ layer\(s\) removed\)/);
    expect(layerCount()).toBe(once);
    expect((await historyLabels()).filter((l) => l === 'Claude: cast piece')).toHaveLength(2);
    // append keeps the earlier piece.
    const third = await call('cast_piece', { ...brief, append: true });
    expect(third.isError).toBeUndefined();
    expect(textOf(third)).not.toMatch(/Replaced/);
    expect(layerCount()).toBe(once * 2);
  });

  it('reviews the scene with mechanical findings and the critique questions', async () => {
    await call('create_layer', { id: 'off', kind: 'text', name: 'Lost', text: 'off frame', x: 99999, y: 99999 });
    const r = await call('review_design');
    expect(textOf(r)).toMatch(/senior motion designer/);
    expect(textOf(r)).toMatch(/off|outside|frame/i);
  });

  it('gives the design guide, whole or by topic', async () => {
    expect(textOf(await call('get_design_guide'))).toMatch(/PROCESS/);
    expect(textOf(await call('get_design_guide', { topic: 'looks' }))).toMatch(/apple_keynote/);
  });
});
