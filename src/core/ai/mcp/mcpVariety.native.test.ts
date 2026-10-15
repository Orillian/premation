/**
 * P4 through Claude's tools: review_design reads depth, light and value off
 * the LIVE scene (CAMERA_OVER_FLAT, NO_LIGHTING_IN_3D, DARK_DEFAULT), and
 * author_scene remembers what it built so get_author_guide and the advisors
 * can steer the next piece away from a twin (SAME_AS_LAST).
 */

import { AUTHOR_EXEMPLARS, type PieceFingerprint, type PieceHistory } from '@motion/author';
import { setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { McpCallHost, type McpResult } from './mcpHost';
import { editorMcpDeps } from './mcpDefaults';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

let h: Harness;
let host: McpCallHost;
let pieces: PieceFingerprint[];
const history: PieceHistory = { recent: () => pieces, record: (fp) => { pieces = [fp, ...pieces]; } };

beforeEach(async () => {
  h = await setupAppEngine();
  pieces = [];
  host = new McpCallHost({ ...editorMcpDeps(), access: async () => ({ ok: true }), pieceHistory: history });
});
afterEach(async () => {
  await host.stop();
  await h.dispose();
});

const call = (name: string, args: unknown = {}): Promise<McpResult> => host.handle({ clientId: 1, name, args });
const textOf = (r: McpResult): string => r.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');

describe('review_design: depth, light and variety on the live scene', () => {
  it('flags a camera over flat layers and a near-black frame nobody asked for', async () => {
    await call('get_author_guide', { brief: 'A launch video for a coffee subscription' });
    await call('update_composition', { background: '#08080c' });
    await call('create_layer', { id: 't', kind: 'text', name: 'Title', text: 'Morning' });
    await call('create_layer', { id: 'c', kind: 'camera', name: 'Cam' });
    const review = textOf(await call('review_design'));
    expect(review).toMatch(/Depth, light and variety/);
    expect(review).toMatch(/\[CAMERA_OVER_FLAT\]/);
    expect(review).toMatch(/\[DARK_DEFAULT, judgement call\]/);
  });

  it('flags 3D geometry with no light, and is quiet once it is lit on a light frame', async () => {
    await call('update_composition', { background: '#e7eaef' });
    await call('create_layer', { id: 'p', kind: 'primitive', primitive: 'sphere', name: 'Planet', radius: 160 });
    expect(textOf(await call('review_design'))).toMatch(/\[NO_LIGHTING_IN_3D, judgement call\]/);
    await call('create_layer', { id: 'k', kind: 'light', name: 'Key' });
    await call('set_light', { nodeId: 'k', type: 'spot', castsShadows: true });
    const review = textOf(await call('review_design'));
    expect(review).not.toMatch(/NO_LIGHTING_IN_3D|CAMERA_OVER_FLAT|DARK_DEFAULT/);
  });
});

describe('the piece history', () => {
  it('author_scene records the piece; the next guide names it; a twin is flagged', async () => {
    const quote = AUTHOR_EXEMPLARS.find((e) => e.id === 'kinetic_quote')!.script;
    expect((await call('author_scene', { script: quote })).isError).toBeUndefined();
    expect(pieces.map((p) => [p.title, p.value, p.medium])).toEqual([[quote.title, 'light', 'type']]);
    // Rebuilding the same script is one piece, not two.
    await call('author_scene', { script: quote });
    expect(pieces).toHaveLength(1);

    const guide = textOf(await call('get_author_guide', { brief: 'a typographic quote' }));
    expect(guide).toMatch(/three different concepts/);
    expect(guide).toMatch(/The last pieces made in this editor were:/);
    expect(guide).toContain(`"${quote.title}": light frame`);

    // The same look again under another title: the advisors call it.
    const twin = await call('author_scene', { script: { ...quote, title: 'Another quote' } });
    expect(textOf(twin)).toMatch(/SAME_AS_LAST/);
  });
});
