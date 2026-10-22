/**
 * The template tells, as rules: a camera over flat layers, unlit 3D, a
 * near-black frame nobody asked for, a twin of the last piece — and the
 * fingerprint that remembers what the last pieces were.
 */

import { AUTHOR_EXEMPLARS } from './exemplars';
import { coerceDesign } from './coerce';
import { describeRecent, depthSceneOfScript, diversityOf, fingerprintScript, hueFamily, lintVariety, valueOf, type DepthLayer, type DepthScene, type PieceFingerprint } from './variety';
import type { SceneScript } from './types';

const layer = (o: Partial<DepthLayer> & { id: string; kind: string }): DepthLayer => ({
  threeD: false, zs: [0], acceptsLights: false, solid: false, ...o,
});
const scene = (layers: DepthLayer[], background = '#f2ede3'): DepthScene => ({ background, accent: '#d6402b', title: 't', layers });
const rules = (s: DepthScene, o = {}) => lintVariety(s, o).map((f) => f.rule);

describe('lintVariety', () => {
  it('CAMERA_OVER_FLAT: a camera over 2D layers, or 3D layers at one depth', () => {
    expect(rules(scene([layer({ id: 'cam', kind: 'camera' }), layer({ id: 't', kind: 'text' })]))).toContain('CAMERA_OVER_FLAT');
    expect(rules(scene([
      layer({ id: 'cam', kind: 'camera' }),
      layer({ id: 'a', kind: 'text', threeD: true, zs: [0] }),
      layer({ id: 'b', kind: 'shape', threeD: true, zs: [100] }),
    ]))).toContain('CAMERA_OVER_FLAT');
    // Spread in depth, or real geometry: a camera move.
    expect(rules(scene([
      layer({ id: 'cam', kind: 'camera' }),
      layer({ id: 'a', kind: 'text', threeD: true, zs: [-300] }),
      layer({ id: 'b', kind: 'shape', threeD: true, zs: [900] }),
    ]))).not.toContain('CAMERA_OVER_FLAT');
    expect(rules(scene([
      layer({ id: 'cam', kind: 'camera' }),
      layer({ id: 'p', kind: 'primitive', threeD: true, solid: true, acceptsLights: true }),
      layer({ id: 'k', kind: 'light', lightType: 'spot' }),
    ]))).not.toContain('CAMERA_OVER_FLAT');
  });

  it('NO_LIGHTING_IN_3D: geometry with no shading light, or lights that shade nothing', () => {
    const solid = layer({ id: 'p', kind: 'primitive', threeD: true, solid: true, acceptsLights: true });
    expect(rules(scene([solid]))).toContain('NO_LIGHTING_IN_3D');
    expect(rules(scene([solid, layer({ id: 'amb', kind: 'light', lightType: 'ambient' })]))).toContain('NO_LIGHTING_IN_3D');
    expect(rules(scene([solid, layer({ id: 'k', kind: 'light', lightType: 'spot' })]))).not.toContain('NO_LIGHTING_IN_3D');
    const unlit = lintVariety(scene([layer({ id: 't', kind: 'text', threeD: true }), layer({ id: 'k', kind: 'light', lightType: 'point' })]));
    expect(unlit.find((f) => f.rule === 'NO_LIGHTING_IN_3D')).toMatchObject({ severity: 'error', message: expect.stringMatching(/acceptsLights/) });
  });

  it('DARK_DEFAULT: a near-black frame unless the brief or the user asked for dark', () => {
    const dark = scene([layer({ id: 't', kind: 'text' })], '#0a0a0f');
    expect(rules(dark, { brief: 'A launch video for a coffee subscription' })).toContain('DARK_DEFAULT');
    expect(rules(dark, { brief: 'A neon club night promo' })).not.toContain('DARK_DEFAULT');
    expect(rules(dark, { brief: 'A coffee video', mode: 'dark' })).not.toContain('DARK_DEFAULT');
    expect(rules(scene([layer({ id: 't', kind: 'text' })]), { brief: 'anything' })).not.toContain('DARK_DEFAULT');
  });

  it('SAME_AS_LAST: the same value, medium, camera and hue as one of the last three pieces', () => {
    const s = scene([layer({ id: 't', kind: 'text' })], '#0b0b10');
    const twin = { title: 'Before', value: 'dark' as const, hue: hueFamily('#d6402b'), medium: 'type' as const, camera: 'none' as const, lit: false };
    expect(rules(s, { brief: 'night', recent: [twin] })).toContain('SAME_AS_LAST');
    expect(rules(s, { brief: 'night', recent: [{ ...twin, value: 'light' }] })).not.toContain('SAME_AS_LAST');
    expect(rules(s, { brief: 'night', recent: [{ ...twin, value: 'light' }, { ...twin, value: 'light' }, { ...twin, value: 'light' }, twin] })).not.toContain('SAME_AS_LAST');
  });
});

describe('fingerprints', () => {
  it('reads value, hue, medium, camera and light off a script', () => {
    const fp = (id: string) => fingerprintScript(AUTHOR_EXEMPLARS.find((e) => e.id === id)!.script);
    expect(fp('product_reveal')).toMatchObject({ value: 'light', medium: '3d', camera: 'depth', lit: true });
    expect(fp('cosmic_3d')).toMatchObject({ value: 'dark', medium: '3d', lit: true });
    expect(fp('kinetic_quote')).toMatchObject({ value: 'light', medium: 'type', camera: 'none' });
    expect(fp('image_led').medium).toBe('image');
    expect(fp('ink_enso').medium).toBe('ink');
    expect(fp('data_ui').medium).toBe('ui');
    expect(fp('logo_sting')).toMatchObject({ value: 'mid', medium: 'shape', hue: 'red' });
    expect(valueOf('#0d0b09')).toBe('dark');
    expect(describeRecent([fp('cosmic_3d')])).toMatch(/dark frame, .* 3d-led, camera in depth, lit/);
  });

  it('no exemplar trips the depth and lighting rules it is there to teach', () => {
    for (const e of AUTHOR_EXEMPLARS) {
      const found = lintVariety(depthSceneOfScript(e.script), { brief: `${e.keywords.join(' ')} ${e.script.intent}` })
        .filter((f) => f.rule === 'CAMERA_OVER_FLAT' || f.rule === 'NO_LIGHTING_IN_3D' || f.rule === 'DARK_DEFAULT');
      expect([e.id, found.map((f) => f.rule)]).toEqual([e.id, []]);
    }
  });
});

describe('the design call weighs three concepts', () => {
  const CTX = { durationSec: 8, width: 1920, height: 1080 };
  const base = {
    title: 't', intent: 'i', durationSec: 8, background: '#f2ede3', palette: { ink: '#111111' },
    grid: { columns: 12, gutter: 24, margin: 120, baseline: 8 }, type: {}, globals: [],
    beats: [{ name: 'A', purpose: 'p', startSec: 0, endSec: 8 }],
  };
  const concept = (medium: string, value: string) => ({ name: medium, idea: 'x', medium, value, palette: 'p', camera: 'none' });

  it('keeps three distinct concepts and the pick', () => {
    const d = coerceDesign({ ...base, concepts: [concept('3d', 'light'), concept('type', 'dark'), concept('ink', 'light')], chosen: 2, why: 'calm' }, CTX);
    expect(d.repairs).toEqual([]);
    expect(d.value).toMatchObject({ chosen: 2, why: 'calm' });
    expect(d.value.concepts?.map((c) => c.medium)).toEqual(['3d', 'type', 'ink']);
  });

  it('says so when the concepts are missing, too few, alike, or none was chosen', () => {
    const msgs = (raw: object) => coerceDesign({ ...base, ...raw }, CTX).repairs.map((r) => r.message).join(' | ');
    expect(msgs({})).toMatch(/no candidate concepts/);
    expect(msgs({ concepts: [concept('type', 'dark'), concept('3d', 'light')], chosen: 0 })).toMatch(/2 concept\(s\), not three/);
    // One concept is the whole answer when the user already chose it (the brief's `concept`).
    expect(msgs({ concepts: [concept('type', 'dark')], chosen: 0 })).not.toMatch(/not three/);
    expect(msgs({ concepts: [concept('type', 'dark'), concept('type', 'dark'), concept('type', 'dark')], chosen: 0 })).toMatch(/variations, not alternatives/);
    expect(msgs({ concepts: [concept('3d', 'light'), concept('type', 'dark'), concept('ink', 'light')], chosen: 7 })).toMatch(/no valid chosen concept/);
  });
});

describe('diversityOf', () => {
  const piece = (value: 'light' | 'mid' | 'dark', medium: PieceFingerprint['medium'], camera: PieceFingerprint['camera'], hue: string) =>
    ({ title: 't', value, medium, camera, hue, lit: medium === '3d' });

  it('fails a set that answers every brief with one look — what the old AI made', () => {
    // The ten pieces the 2026-10-15 audit found: nine near-black type pieces with a flat camera or none, one light.
    const old = [
      ...Array.from({ length: 6 }, () => piece('dark', 'type', 'flat', 'blue')),
      ...Array.from({ length: 3 }, () => piece('dark', 'type', 'none', 'blue')),
      piece('light', 'ink', 'none', 'red'),
    ];
    const r = diversityOf(old);
    expect(r.pass).toBe(false);
    expect(r.reasons.join(' | ')).toMatch(/60% of the pieces share one look \(dark · type · camera flat\)/);
    expect(r.reasons.join(' | ')).toMatch(/90% of the frames are dark/);
    expect(r.reasons.join(' | ')).toMatch(/0% of the pieces use 3D/);
  });

  it('passes the exemplar set, and reports its spread', () => {
    const r = diversityOf(AUTHOR_EXEMPLARS.map((e) => fingerprintScript(e.script)));
    expect(r.reasons).toEqual([]);
    expect(r.media).toBeGreaterThanOrEqual(5);
    expect(r.threeDShare).toBeGreaterThan(0.2);
  });

  it('judges nothing under five pieces, and names each shortfall it finds', () => {
    expect(diversityOf([piece('dark', 'type', 'none', 'blue')]).pass).toBe(true);
    const same = Array.from({ length: 5 }, (_, i) => piece('light', 'shape', 'none', ['red', 'blue', 'green', 'red', 'blue'][i]!));
    const r = diversityOf(same);
    expect(r.reasons.join(' | ')).toMatch(/only 1 value/);
    expect(r.reasons.join(' | ')).toMatch(/only 1 medium/);
    expect(r.reasons.join(' | ')).toMatch(/only one camera kind/);
  });
});

// A script's own type annotation, so the import is used even if the cases above change.
export type _Unused = SceneScript;
