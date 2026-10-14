/**
 * R5: `add_camera_move` reaches every camera move — the two recipes, all the
 * library's camera techniques, and the camera program's verbs (shake, rig,
 * fly_to, follow_path) — `list_capabilities('camera')` lists them, and each
 * reply describes the scene it left behind (the tool-truthfulness rule: read
 * the document back, then check the reply agrees).
 */

import { ToolRegistry, CAMERA_MOVE_KINDS, CAMERA_MOVE_TECHNIQUES, CAMERA_MOVE_VERBS, addCameraMoveDef } from '@motion/ai-tools';
import type { ToolContext } from '@motion/ai-tools';
import { TECHNIQUES } from '@motion/technique-library';
import type { Command } from '@motion/engine-api';
import { uiKindOf } from '@core/mirror/layerKinds';
import { propRefForTrack } from '@core/engine/propRefs';
import { documentMirror } from '@stores/documentMirror';
import { sec, settleEdits, setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { buildAiTools } from './toolHandlers';
import { createToolContext } from './toolContext';
import { rigOf } from '@core/scene/cameraRig';

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of buildAiTools()) r.register(t);
  return r;
}
const ctx = (): ToolContext => createToolContext(new AbortController().signal);

let h: Harness;

beforeEach(async () => {
  h = await setupAppEngine();
  await h.run({ type: 'setCompositionSettings', comp: 'comp_root', patch: { name: 'Main', frameRate: { num: 30, den: 1 }, duration: sec(10) } } as Command);
  await settleEdits();
});
afterEach(async () => { await h.dispose(); });

const cameras = (): string[] => documentMirror().layerIds().filter((id) => uiKindOf(documentMirror().layer(id)) === 'camera');

async function layer(kind: 'camera' | 'solid' | 'shape' | 'text', name: string): Promise<string> {
  const { layer: id } = await h.run({ type: 'createLayer', comp: 'comp_root', kind, name, init: [] });
  await settleEdits();
  await documentMirror().loadTree(id);
  return id;
}

async function keysOf(id: string, track: string): Promise<number> {
  await documentMirror().loadTree(id);
  const r = propRefForTrack(id, track);
  return r ? documentMirror().keyframes(id, r.ref.path).length : 0;
}

describe('the vocabulary', () => {
  it('accepts every camera technique of the library, by its short name, and the four verbs', () => {
    const library = TECHNIQUES.filter((t) => t.id.startsWith('camera.')).map((t) => t.id.slice('camera.'.length)).sort();
    expect([...CAMERA_MOVE_TECHNIQUES].sort()).toEqual(library);
    expect(library).toHaveLength(15);
    const schema = addCameraMoveDef.inputSchema as { properties: { kind: { enum: string[] } } };
    expect(schema.properties.kind.enum).toEqual([...CAMERA_MOVE_KINDS]);
    for (const v of ['shake', 'rig', 'fly_to', 'follow_path']) expect(CAMERA_MOVE_VERBS).toContain(v);
  });

  it("list_capabilities('camera') lists every kind add_camera_move accepts", async () => {
    const res = await registry().execute('list_capabilities', { area: 'camera' }, ctx());
    expect(res.ok).toBe(true);
    const kinds = ((res.data as { cameraMoves: { kinds: Array<{ kind: string; does: string }> } }).cameraMoves.kinds).map((k) => k.kind);
    expect(kinds).toEqual([...CAMERA_MOVE_KINDS]);
  });
});

describe('add_camera_move', () => {
  it('a technique kind runs the library move on the comp, inferring the role targets', async () => {
    const title = await layer('text', 'Title');
    await layer('shape', 'Mark');
    const res = await registry().execute('add_camera_move', { kind: 'crane_down', durationSec: 3 }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/camera\.crane_down/);
    // The technique made its camera and staged the content in depth.
    expect(cameras().length).toBeGreaterThanOrEqual(1);
    expect(documentMirror().layer(title)?.switches.threeD).toBe(true);
  });

  it('rig builds the named nulls above the camera and the reply names them', async () => {
    const cam = await layer('camera', 'Shot');
    const res = await registry().execute('add_camera_move', { kind: 'rig', rig: 'crane' }, ctx());
    expect(res.ok).toBe(true);
    await settleEdits();
    const rig = rigOf(cam);
    expect(rig?.kind).toBe('crane');
    for (const id of Object.values(rig!.nulls)) expect(res.content).toContain(id);
    expect(res.content).toMatch(/Rig · Crane · Base/);
  });

  it('fly_to keys the camera, and the reply says when the move ends', async () => {
    const cam = await layer('camera', 'Shot');
    const a = await layer('solid', 'A');
    const b = await layer('solid', 'B');
    const res = await registry().execute('add_camera_move', { kind: 'fly_to', layers: [a, b], startSec: 1, travelSec: 1, holdSec: 0.5 }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/ends at 4s/);
    await settleEdits();
    expect(await keysOf(cam, 'x')).toBe(5);
  });

  it('follow_path turns a mask path into roving Position keys', async () => {
    const cam = await layer('camera', 'Shot');
    const route = await layer('solid', 'Route');
    await h.run({
      type: 'addMask', layer: route, mode: 'add', inverted: false,
      path: { vertices: [0, 0, 300, 0, 300, 300, 0, 300], inTangents: [], outTangents: [], closed: false, featherPoints: [], vertexStates: [] },
    });
    await settleEdits();
    const res = await registry().execute('add_camera_move', { kind: 'follow_path', pathLayer: route, durationSec: 4 }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/4 roving Position keys/);
    await settleEdits();
    expect(await keysOf(cam, 'x')).toBe(4);
  });

  it('a verb on a comp with no camera fails and says how to get one', async () => {
    const res = await registry().execute('add_camera_move', { kind: 'rig' }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/no camera/);
    expect(cameras()).toHaveLength(0);
  });

  it('shake writes the camera\'s Shake and reads back what the reply says', async () => {
    const cam = await layer('camera', 'Shot');
    const res = await registry().execute('add_camera_move', { kind: 'shake', shakeAmount: 18, shakeRotation: 1.5, shakeFrequency: 3, shakeSeed: 7 }, ctx());
    // An engine built before procedural shake (R1) has no Shake props: the
    // tool must say so and write nothing, not report a shake it did not make.
    if (!propRefForTrack(cam, 'shakeAmount')) {
      expect(res.ok).toBe(false);
      expect(res.content).toMatch(/not available/);
      return;
    }
    expect(res.ok).toBe(true);
    await settleEdits();
    await documentMirror().loadTree(cam);
    for (const [track, want] of [['shakeAmount', 18], ['shakeRotation', 1.5], ['shakeFrequency', 3], ['shakeSeed', 7]] as const) {
      const r = propRefForTrack(cam, track);
      expect({ track, has: !!r }).toEqual({ track, has: true });
      const v = r ? documentMirror().property(cam, r.ref.path)?.value : undefined;
      const n = v?.kind === 'scalar' ? v.value : v?.kind === 'int' ? v.value : NaN;
      expect({ track, n }).toEqual({ track, n: want });
    }
    expect(res.content).toMatch(/shakeAmount 18/);
  });
});
