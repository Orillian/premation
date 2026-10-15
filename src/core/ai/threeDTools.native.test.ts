/**
 * P2 (docs/AUDIT_2026-10-15_CACHE_AI_CEILING.md): the AI tools reach the 3D
 * the engine renders — primitives, PBR / glass materials, extrusion and
 * bevels, typed lights with shadows and environments — and an authored
 * script carrying them compiles to calls the engine takes. Every case reads
 * the ENGINE's property tree back, never the tool's reply.
 */

import type { Command, PropertyInfo, Value } from '@motion/engine-api';
import { coerceScript, compileScript } from '@motion/author';
import { documentMirror } from '@stores/documentMirror';
import { sec, settleEdits, setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { runToolTurn } from './aiTurn';
import { LIGHT_PROPS, MATERIAL_PROPS, isAnimatableProp } from './toolContext';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

let h: Harness;
beforeEach(async () => {
  h = await setupAppEngine();
  await h.run({ type: 'setCompositionSettings', comp: 'comp_root', patch: { frameRate: { num: 30, den: 1 }, duration: sec(5) } } as Command);
  await settleEdits();
});
afterEach(async () => { await h.dispose(); });

const named = (name: string): string => {
  const m = documentMirror();
  const id = m.layerIds().find((c) => m.layer(c)?.name === name);
  if (!id) throw new Error(`no layer named ${name}`);
  return id;
};

/** Every property of a layer, by path. */
async function props(layer: string): Promise<Map<string, PropertyInfo>> {
  const tree = await h.query({ type: 'getPropertyTree', layer, path: '', depth: 8 } as never) as { nodes: PropertyInfo[] };
  return new Map(tree.nodes.map((n) => [n.path, n]));
}

/** A static value as a plain number / string / boolean. */
function plain(v: Value | undefined): unknown {
  if (!v) return undefined;
  switch (v.kind) {
    case 'bool': case 'int': case 'scalar': case 'string': case 'choice': return v.value;
    default: return v;
  }
}

const ok = (r: { results: { ok: boolean; content: string }[] }): void => {
  expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
};

describe('3D through the AI tools', () => {
  it('create_layer kind primitive makes a sized, lit 3D mesh', async () => {
    ok(await runToolTurn('AI: planet', [
      { name: 'create_layer', args: { id: 'p', kind: 'primitive', primitive: 'sphere', name: 'Planet', radius: 180, x: 700, y: 500, fill: '#c9a227' } },
      { name: 'create_layer', args: { id: 'r', kind: 'primitive', primitive: 'torus', name: 'Ring', radius: 260, tube: 18 } },
    ]));
    const planet = await props(named('Planet'));
    expect(plain(planet.get('primitive/type')?.value)).toBe('sphere');
    expect(plain(planet.get('primitive/radius')?.value)).toBe(180);
    expect(planet.has('material/metal')).toBe(true);  // 3D on: Material Options exist
    const ring = await props(named('Ring'));
    expect(plain(ring.get('primitive/type')?.value)).toBe('torus');
    expect(plain(ring.get('primitive/tube')?.value)).toBe(18);
  });

  it('update_layer sets PBR material, glass and extruded geometry on a 3D text layer', async () => {
    ok(await runToolTurn('AI: chrome type', [
      { name: 'create_layer', args: { id: 't', kind: 'text', name: 'Word', text: 'CHROME' } },
      {
        name: 'update_layer',
        args: {
          nodeId: 't', threeD: true, acceptsLights: true, shading: 'pbr', metal: 100, roughness: 12,
          reflectionIntensity: 80, transparency: 30, ior: 1.52, castsShadows: 'on', acceptsShadows: false,
          extrusionDepth: 60, bevelDepth: 6, bevelStyle: 'convex',
        },
      },
    ]));
    const p = await props(named('Word'));
    expect({
      shading: plain(p.get('material/shading')?.value),
      metal: plain(p.get('material/metal')?.value),
      roughness: plain(p.get('material/roughness')?.value),
      reflection: plain(p.get('material/reflectionIntensity')?.value),
      transparency: plain(p.get('material/transparency')?.value),
      ior: plain(p.get('material/ior')?.value),
      casts: plain(p.get('material/castsShadows')?.value),
      accepts: plain(p.get('material/acceptsShadows')?.value),
      extrusion: plain(p.get('geometry/extrusionDepth')?.value),
      bevel: plain(p.get('geometry/bevelDepth')?.value),
      bevelStyle: plain(p.get('geometry/bevelStyle')?.value),
    }).toEqual({
      shading: 'pbr', metal: 100, roughness: 12, reflection: 80, transparency: 30, ior: 1.52,
      casts: 1, accepts: 0, extrusion: 60, bevel: 6, bevelStyle: 'convex',
    });
  });

  it('update_layer refuses material options on a 2D layer, and says so', async () => {
    const r = await runToolTurn('AI: flat', [
      { name: 'create_layer', args: { id: 's', kind: 'shape', shape: 'rect', name: 'Flat', width: 100, height: 100 } },
      { name: 'update_layer', args: { nodeId: 's', metal: 100 } },
    ]);
    expect(r.results[1]!.ok).toBe(false);
    expect(r.results[1]!.content).toMatch(/threeD/);
  });

  it('set_light sets type, shadows, cone, aim and environment', async () => {
    ok(await runToolTurn('AI: key + sky', [
      { name: 'create_layer', args: { id: 'k', kind: 'light', name: 'Key' } },
      {
        name: 'set_light',
        args: {
          nodeId: 'k', type: 'spot', color: '#ffd9a8', intensity: 140, coneAngle: 70, coneFeather: 60,
          castsShadows: true, shadowDarkness: 70, shadowDiffusion: 40, falloff: 'smooth', falloffDistance: 1500,
          pointOfInterest: { x: 960, y: 600, z: 0 },
        },
      },
      { name: 'create_layer', args: { id: 'e', kind: 'light', name: 'Sky' } },
      { name: 'set_light', args: { nodeId: 'e', type: 'environment', environment: 'sunset', environmentVisible: true, environmentBlur: 40 } },
    ]));
    const k = await props(named('Key'));
    expect({
      type: plain(k.get('light/lightType')?.value),
      intensity: plain(k.get('light/intensity')?.value),
      cone: plain(k.get('light/lightCone')?.value),
      feather: plain(k.get('light/lightConeFeather')?.value),
      shadows: plain(k.get('light/castsShadows')?.value),
      darkness: plain(k.get('light/shadowDarkness')?.value),
      diffusion: plain(k.get('light/shadowDiffusion')?.value),
      falloff: plain(k.get('light/falloff')?.value),
      falloffDistance: plain(k.get('light/falloffDistance')?.value),
      poiY: plain(k.get('light/poiY')?.value),
    }).toEqual({
      type: 'spot', intensity: 140, cone: 70, feather: 60, shadows: true, darkness: 70, diffusion: 40,
      falloff: 'smooth', falloffDistance: 1500, poiY: 600,
    });
    const sky = await props(named('Sky'));
    expect({
      type: plain(sky.get('light/lightType')?.value),
      sky: plain(sky.get('light/environment')?.value),
      visible: plain(sky.get('light/environmentVisible')?.value),
      blur: plain(sky.get('light/environmentBlur')?.value),
    }).toEqual({ type: 'environment', sky: 'sunset', visible: true, blur: 40 });
  });

  it('a set_light field the light does not take fails the call by name', async () => {
    const r = await runToolTurn('AI: bad light', [
      { name: 'create_layer', args: { id: 'k', kind: 'light', name: 'Key' } },
      { name: 'set_light', args: { nodeId: 'k', type: 'laser' } },
    ]);
    expect(r.results[1]!.ok).toBe(false);
  });
});

describe('MATERIAL_PROPS and LIGHT_PROPS', () => {
  it('are admitted by the gate', () => {
    for (const p of [...MATERIAL_PROPS, ...LIGHT_PROPS]) expect([p, isAnimatableProp(p)]).toEqual([p, true]);
  });

  it.each(MATERIAL_PROPS.map((p) => [p]))('%s keys on a 3D text layer and reads back animated', async (prop) => {
    const [a, b] = prop === 'shininess' ? [5, 80] : prop === 'extrusionDepth' ? [0, 80] : prop === 'bevelDepth' ? [0, 8] : [10, 90];
    ok(await runToolTurn(`AI: ${prop}`, [
      { name: 'create_layer', args: { id: 'l', kind: 'text', name: 'L', text: 'Depth' } },
      { name: 'update_layer', args: { nodeId: 'l', threeD: true } },
      { name: 'set_keyframes', args: { keyframes: [{ nodeId: 'l', prop, t: 0, value: a }, { nodeId: 'l', prop, t: 1, value: b }] } },
    ]));
    expect(((await docView()).getTrackKeyframes(named('L'), prop) ?? []).length).toBe(2);
  });

  it.each(LIGHT_PROPS.map((p) => [p]))('%s keys on a light and reads back animated', async (prop) => {
    const [a, b] = prop === 'lightCone' ? [20, 90] : prop === 'falloffDistance' ? [200, 1500] : [10, 90];
    ok(await runToolTurn(`AI: ${prop}`, [
      { name: 'create_layer', args: { id: 'l', kind: 'light', name: 'L' } },
      { name: 'set_keyframes', args: { keyframes: [{ nodeId: 'l', prop, t: 0, value: a }, { nodeId: 'l', prop, t: 1, value: b }] } },
    ]));
    expect(((await docView()).getTrackKeyframes(named('L'), prop) ?? []).length).toBe(2);
  });
});

describe('an authored 3D script', () => {
  it('compiles to calls the engine takes: a primitive, a lit extruded title, typed lights, a floor', async () => {
    const coerced = coerceScript({
      title: 'Lit set',
      intent: 'A chrome word over a gold planet, key-lit with soft shadows on a floor.',
      durationSec: 4,
      background: '$sky',
      palette: { sky: '#e9eef5', gold: '#c9a227', ink: '#1d2430' },
      grid: { columns: 12, gutter: 24, margin: 120, baseline: 8 },
      type: { display: { family: 'Inter', weight: 800, size: 160 } },
      globals: [],
      beats: [{
        name: 'Hero', purpose: 'The lit object.', startSec: 0, endSec: 4,
        layers: [
          { id: 'floor', kind: 'solid', name: 'Floor', props: { x: 960, y: 900, width: 2400, height: 2400, fill: '#d7dde6', rotationX: 90, acceptsShadows: true } },
          { id: 'planet', kind: 'primitive', name: 'Planet', props: { primitive: 'sphere', radius: 160, x: 1300, y: 520, fill: '$gold', shading: 'pbr', metal: 100, roughness: 25 } },
          {
            id: 'word', kind: 'text', name: 'Word', text: 'ORBIT', typeStyle: 'display',
            props: { x: 760, y: 540, fill: '$ink', extrusionDepth: 50, bevelDepth: 4, shading: 'pbr', metal: 90, roughness: 15, acceptsLights: true },
            keys: { extrusionDepth: [{ t: 0, v: 0, ease: 'easeOut' }, { t: 1.2, v: 50 }] },
          },
          { id: 'key', kind: 'light', name: 'Key', light: { type: 'spot', intensity: 130, castsShadows: true, shadowDiffusion: 40, pointOfInterest: { x: 960, y: 540, z: 0 } }, props: { x: 500, y: 100, z: -800 }, keys: { lightCone: [{ t: 0, v: 30 }, { t: 2, v: 70 }] } },
          { id: 'sky', kind: 'light', name: 'Env', light: { type: 'environment', environment: 'studio' } },
          { id: 'cam', kind: 'camera', name: 'Cam', keys: { z: [{ t: 0, v: -2400, ease: 'easeInOut' }, { t: 4, v: -1900 }] } },
        ],
      }],
    }, { durationSec: 4, width: 1920, height: 1080 });
    // The floor and the word asked for 3D-only options: the coercer turned their 3D switch on, and said so.
    expect(coerced.repairs.map((r) => r.message).filter((m) => /threeD turned on/.test(m)).length).toBe(2);
    const compiled = compileScript(coerced.value);
    const r = await runToolTurn('AI: build', compiled.calls.map((c) => ({ name: c.name, args: c.args })));
    ok(r);
    const word = await props(named('Word'));
    expect(plain(word.get('material/shading')?.value)).toBe('pbr');
    expect(((await docView()).getTrackKeyframes(named('Word'), 'extrusionDepth') ?? []).length).toBe(2);
    const key = await props(named('Key'));
    expect(plain(key.get('light/lightType')?.value)).toBe('spot');
    expect(plain(key.get('light/castsShadows')?.value)).toBe(true);
    expect(plain((await props(named('Planet'))).get('primitive/type')?.value)).toBe('sphere');
    expect(plain((await props(named('Floor'))).get('material/acceptsShadows')?.value)).toBe(1);
  });
});
