/**
 * The viewer notice's heading says what kind of gap it lists. A Premation
 * Cloud plugin without a plan is not a feature "the C++ engine does not render
 * yet" (2026-10-13 QA: a locked plugin's notice was headed so).
 */

import { noticeHeading, type Group } from './EngineUnportedNotice';

const g = (what: string, unported = true): Group => ({ what, unported, layers: 1, names: ['Solid 1'] });
const LOCKED = 'requires Premation Cloud — the effect passes through until the plan is active (premation.pv-cloud-ripple)';

it('a Cloud-locked plugin is headed as needing Premation Cloud', () => {
  expect(noticeHeading([g(LOCKED)], 1)).toBe('Needs Premation Cloud: an effect drawn without its plugin (1 layer)');
  expect(noticeHeading([g(LOCKED), g(`${LOCKED} 2`)], 3)).toBe('Needs Premation Cloud: 2 effects drawn without their plugin (3 layers)');
  expect(noticeHeading([g(LOCKED)], 1)).not.toMatch(/C\+\+ engine/);
});

it("a warning (the engine's stage for what a layer draws without) reads as the engine's own words", () => {
  const w = (what: string): Group => ({ what, unported: false, warning: true, layers: 1, names: ['Solid 1'] });
  expect(noticeHeading([w('missing plugin — the effect passes through until it is installed (com.x)')], 1)).toBe('Missing plugin: an effect drawn without it (1 layer)');
  expect(noticeHeading([w('rig on an image layer: the image is a session / remote URL — the mesh covers the whole layer')], 1)).toBe('Drawn without one feature (1 layer)');
  expect(noticeHeading([w('audio waveform generator (no audio engine) — drawn flat')], 1)).not.toMatch(/C\+\+ engine/);
});

it('a missing plugin, an unported feature and a mix each read as what they are', () => {
  expect(noticeHeading([g('missing plugin — the effect passes through until it is installed (com.x)')], 1)).toBe('Missing plugin: an effect drawn without it (1 layer)');
  expect(noticeHeading([g('parametric polystar')], 2)).toBe('Drawn without one feature the C++ engine does not render yet (2 layers)');
  expect(noticeHeading([g('parametric polystar'), g(LOCKED)], 2)).toBe('Drawn without 2 features (2 layers)');
  expect(noticeHeading([g('decode: bad frame', false)], 1)).toBe('Drawn without one feature (1 layer)');
});
