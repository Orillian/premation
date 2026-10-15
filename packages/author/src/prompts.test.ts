/**
 * The prompts carry what the model needs and nothing that would make it copy.
 */

import { CRAFT_RULES, NEVER_RULES } from '@motion/ai-tools';
import { coerceCritique } from './schema';
import { authorSystemPrompt, beatsPrompt, critiquePrompt, designPrompt, revisePrompt } from './prompts';
import { AUTHOR_EXEMPLARS, selectAuthorExemplar } from './exemplars';
import { AUTHOR_EFFECTS, vocabularyCard } from './vocabulary';
import type { DesignResult } from './types';

const BRIEF = { prompt: 'A logo sting for NOVA, punchy', width: 1080, height: 1920, fps: 30, durationSec: 6 };

const DESIGN: DesignResult = {
  title: 'NOVA', intent: 'i', durationSec: 6, background: '#000000', palette: { hot: '#ff0055' },
  grid: { columns: 6, gutter: 16, margin: 80, baseline: 8 }, type: {}, globals: [],
  beats: [{ name: 'Draw', purpose: 'p', startSec: 0, endSec: 3 }, { name: 'Out', purpose: 'q', startSec: 3, endSec: 6, notes: 'fade' }],
};

describe('author prompts', () => {
  it('the system prompt carries the shared craft rules, the vocabulary and the closest exemplar', () => {
    const sys = authorSystemPrompt(BRIEF);
    expect(sys).toContain(CRAFT_RULES);
    expect(sys).toContain(NEVER_RULES);
    expect(sys).toContain(vocabularyCard());
    expect(sys).toContain(JSON.stringify(AUTHOR_EXEMPLARS.find((e) => e.id === 'logo_sting')!.script));
    expect(selectAuthorExemplar('a kinetic typography quote').id).toBe('kinetic_quote');
  });

  it('picks a reference at random among the exemplars the brief matches, weighted by matches', () => {
    // "3d product launch": product_reveal matches 3 keywords, cosmic_3d 1.
    const seq = (xs: number[]) => { let i = 0; return () => xs[i++ % xs.length]!; };
    expect(selectAuthorExemplar('a 3d product launch', seq([0])).id).toBe('product_reveal');
    expect(selectAuthorExemplar('a 3d product launch', seq([0.99])).id).toBe('cosmic_3d');
    const seen = new Set(Array.from({ length: 50 }, (_, i) => selectAuthorExemplar('a 3d product launch', () => i / 50).id));
    expect([...seen].sort()).toEqual(['cosmic_3d', 'product_reveal']);
    // No keyword matches: any of them.
    const any = new Set(Array.from({ length: 90 }, (_, i) => selectAuthorExemplar('something for my grandmother', () => i / 90).id));
    expect(any.size).toBe(AUTHOR_EXEMPLARS.length);
  });

  it('shows a varied set: at most a third dark, the dark flags true to the backgrounds, every medium present', () => {
    const lum = (hex: string): number => {
      const n = parseInt(hex.slice(1, 7), 16);
      const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    };
    for (const e of AUTHOR_EXEMPLARS) {
      const bg = e.script.background.startsWith('$') ? e.script.palette[e.script.background.slice(1)]! : e.script.background;
      expect([e.id, lum(bg) < 0.15]).toEqual([e.id, e.dark]);
    }
    expect(AUTHOR_EXEMPLARS.filter((e) => e.dark).length * 3).toBeLessThanOrEqual(AUTHOR_EXEMPLARS.length);
    const kinds = new Set(AUTHOR_EXEMPLARS.flatMap((e) => [...e.script.globals, ...e.script.beats.flatMap((b) => b.layers)].map((l) => l.kind)));
    for (const k of ['primitive', 'light', 'camera', 'image', 'text', 'shape'] as const) expect([k, kinds.has(k)]).toEqual([k, true]);
    expect(AUTHOR_EXEMPLARS.some((e) => e.script.beats.some((b) => b.layers.some((l) => l.paint?.length)))).toBe(true);
  });

  it('the vocabulary card lists every author effect with its params', () => {
    const card = vocabularyCard();
    for (const e of AUTHOR_EFFECTS) expect(card).toContain(`${e.type} (${e.label})`);
    expect(card).toContain('blurriness 0..500px');
  });

  it('the design prompt states the frame, the duration and the user\'s direction', () => {
    const p = designPrompt({ ...BRIEF, direction: { accent: '#ff0055', mode: 'dark' }, imageCount: 1 });
    expect(p).toContain('1080×1920 (portrait)');
    expect(p).toContain('6s');
    expect(p).toContain('#ff0055');
    expect(p).toContain('attached image is REFERENCE');
  });

  it('beat, critique and revise prompts carry the outline and the findings', () => {
    expect(beatsPrompt(BRIEF, DESIGN, [1], [])).toMatch(/1\. Out \(3–6s\) — q Notes: fade/);
    const c = critiquePrompt({ brief: BRIEF, design: DESIGN, evidenceNotes: ['whole piece'], mechanical: '- x is offscreen', advice: [], repairs: [{ path: 'beats[0]', message: 'dropped' }] });
    expect(c).toContain('MECHANICAL CHECKS');
    expect(c).toContain('beats[0]: dropped');
    const r = revisePrompt(BRIEF, DESIGN, 0, { ...DESIGN.beats[0]!, layers: [] }, [{ problem: 'empty', fix: 'add the mark' }], [], ['x']);
    expect(r).toContain('empty → add the mark');
    expect(r).toContain('(0–3s)');
  });
});

describe('coerceCritique', () => {
  it('keeps unmentioned beats, refuses a revise with nothing to fix, ignores out-of-range indices', () => {
    const c = coerceCritique({
      overall: 'ok',
      beats: [
        { index: 0, verdict: 'revise', findings: [{ problem: 'type collides', fix: 'move it' }] },
        { index: 1, verdict: 'revise', findings: [] },
        { index: 9, verdict: 'revise', findings: [{ problem: 'x', fix: 'y' }] },
      ],
    }, 3);
    expect(c.beats.map((b) => b.verdict)).toEqual(['revise', 'keep', 'keep']);
    expect(coerceCritique(undefined, 2).beats.map((b) => b.verdict)).toEqual(['keep', 'keep']);
  });
});
