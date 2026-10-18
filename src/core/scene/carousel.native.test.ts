/**
 * Create Carousel on the app's engine: one history entry turns the selected
 * layers into 3D cards around a "Carousel" null, placed and turned by
 * expressions over its Size / Speed / Spin / Angle sliders — as a ring, a
 * Ferris wheel, Cover Flow or a card stack.
 */

import type { Value } from '@motion/engine-api';
import { setupAppEngine, sec, settleEdits, type AppHarness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { createCarouselEdit, type Carousel, type CarouselMode } from './carousel';

const comp = 'comp_root';
let h: AppHarness;

beforeEach(async () => { h = await setupAppEngine(); });
afterEach(async () => { await h.dispose(); });

async function valuesAt(layer: string, paths: string[], t: number): Promise<Value[]> {
  const r = await h.client.query({ type: 'getPropertyValues', props: paths.map((path) => ({ layer, path })), time: sec(t), evaluated: true });
  if (!r.ok) throw new Error(r.error.message);
  return r.value.values.map((v: { value: Value }) => v.value);
}

const vec = (v: Value): { x: number; y: number; z: number } => {
  if (v.kind === 'vec3') return v.value;
  if (v.kind === 'vec2') return { ...v.value, z: 0 };
  throw new Error(`not a vector: ${v.kind}`);
};
const num = (v: Value): number => {
  if (v.kind !== 'scalar') throw new Error(`not a scalar: ${v.kind}`);
  return v.value;
};

async function cards(n: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push((await h.run({ type: 'createLayer', comp, kind: 'solid', name: `Card ${i}`, init: [] })).layer);
  await engineIdle();
  return out;
}

/** Build a carousel, then stop it (Speed 0) at Size 300 so the layout can be measured. */
async function stillCarousel(ids: string[], mode: CarouselMode, angle?: number): Promise<{ made: Carousel; centre: { x: number; y: number; z: number } }> {
  const made = await createCarouselEdit(ids, mode);
  expect(made).not.toBeNull();
  await settleEdits();
  const set = (slider: string, value: number) =>
    h.run({ type: 'setProperty', prop: { layer: made!.controls, path: `effects/ctrl_${slider}/slider` }, value: { kind: 'scalar', value } as Value });
  await set(made!.names.speed, 0);
  await set(made!.names.size, 300);
  if (angle !== undefined) await set(made!.names.angle, angle);
  const [c] = await valuesAt(made!.controls, ['transform/position'], 0);
  return { made: made!, centre: vec(c!) };
}

const pos = async (id: string) => vec((await valuesAt(id, ['transform/position'], 0))[0]!);
const scalarAt = async (id: string, path: string) => num((await valuesAt(id, [path], 0))[0]!);

describe('Create Carousel', () => {
  it('is one history entry', async () => {
    const ids = await cards(3);
    const before = await h.client.query({ type: 'getHistory' });
    const entries0 = before.ok ? before.value.entries.length : 0;
    expect(await createCarouselEdit(ids, 'stack')).not.toBeNull();
    await settleEdits();
    const after = await h.client.query({ type: 'getHistory' });
    expect(after.ok && after.value.entries.length).toBe(entries0 + 1);
  }, 60_000);

  it('ring: cards on a ring around the null, facing outward', async () => {
    const ids = await cards(4);
    const { made, centre } = await stillCarousel(ids, 'ring', 0);

    const m = documentMirror();
    expect(m.layer(made.controls)?.name).toBe('Carousel');
    for (const id of ids) expect(m.layer(id)?.switches.threeD).toBe(true);

    // Card 0 nearest the camera, card 1 a quarter turn round to the right.
    const a = await pos(ids[0]!);
    expect(a.x).toBeCloseTo(centre.x, 3);
    expect(a.z).toBeCloseTo(centre.z - 300, 3);
    expect(await scalarAt(ids[0]!, 'transform/yRotation')).toBeCloseTo(0, 3);
    const b = await pos(ids[1]!);
    expect(b.x).toBeCloseTo(centre.x + 300, 3);
    expect(b.z).toBeCloseTo(centre.z, 3);
    expect(await scalarAt(ids[1]!, 'transform/yRotation')).toBeCloseTo(-90, 3);

    // Spin turns the whole ring.
    await h.run({ type: 'setProperty', prop: { layer: made.controls, path: `effects/ctrl_${made.names.spin}/slider` }, value: { kind: 'scalar', value: 90 } as Value });
    expect((await pos(ids[0]!)).x).toBeCloseTo(centre.x + 300, 3);

    // A second carousel numbers itself and its sliders.
    const second = await createCarouselEdit(await cards(2));
    expect(second?.names.size).toBe('Carousel Size 2');
  }, 60_000);

  it('Ferris wheel: the ring stands on edge, card 1 a quarter turn up and over', async () => {
    const ids = await cards(4);
    const { centre } = await stillCarousel(ids, 'vertical');
    const a = await pos(ids[0]!);
    expect(a.y).toBeCloseTo(centre.y, 3);
    expect(a.z).toBeCloseTo(centre.z - 300, 3);
    const b = await pos(ids[1]!);
    expect(b.y).toBeCloseTo(centre.y - 300, 3);
    expect(b.z).toBeCloseTo(centre.z, 3);
    expect(await scalarAt(ids[1]!, 'transform/xRotation')).toBeCloseTo(-90, 3);
  }, 60_000);

  it('Cover Flow: the front card faces the camera, its neighbours turn in and step back', async () => {
    const ids = await cards(5);
    const { centre } = await stillCarousel(ids, 'coverflow', 50);
    const front = await pos(ids[0]!);
    expect(front.x).toBeCloseTo(centre.x, 3);
    expect(front.z).toBeCloseTo(centre.z, 3);
    expect(await scalarAt(ids[0]!, 'transform/yRotation')).toBeCloseTo(0, 3);
    const right = await pos(ids[1]!);
    expect(right.x).toBeCloseTo(centre.x + 300, 3);
    expect(right.z).toBeCloseTo(centre.z + 240, 3);
    expect(await scalarAt(ids[1]!, 'transform/yRotation')).toBeCloseTo(50, 3);
    // The last card wraps round to the left of the front.
    expect((await pos(ids[4]!)).x).toBeCloseTo(centre.x - 300, 3);
    expect(await scalarAt(ids[4]!, 'transform/yRotation')).toBeCloseTo(-50, 3);
  }, 60_000);

  it('Card Stack: the deck recedes in depth, the front card opaque and the back one faded', async () => {
    const ids = await cards(4);
    const { centre } = await stillCarousel(ids, 'stack', 0);
    const front = await pos(ids[0]!);
    expect(front.z).toBeCloseTo(centre.z, 3);
    expect((await pos(ids[1]!)).z).toBeCloseTo(centre.z + 300, 3);
    expect(await scalarAt(ids[0]!, 'transform/opacity')).toBeCloseTo(100, 3);
    // The back card (slot 3 of 4) is exactly where it fades in from nothing.
    expect(await scalarAt(ids[3]!, 'transform/opacity')).toBeCloseTo(0, 3);
  }, 60_000);

  it('refuses fewer than two layers', async () => {
    expect(await createCarouselEdit(await cards(1))).toBeNull();
  });
});
