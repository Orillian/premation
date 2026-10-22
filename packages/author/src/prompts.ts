/**
 * The four author prompts: design, beats, critique, revise.
 *
 * One system prompt serves design and beats, so the model writing a beat has
 * read the same rules and vocabulary as the model that planned it. The
 * critique gets its own: it judges, it does not author.
 */

import { CRAFT_RULES, NEVER_RULES } from '@motion/ai-tools';
import { formatAdvice, type AdvisorFinding } from './advisors';
import { formatRepairs } from './coerce';
import { selectAuthorExemplar } from './exemplars';
import { BEATS_SCHEMA, CONCEPTS_SCHEMA, CRITIQUE_SCHEMA, DESIGN_SCHEMA, REVISE_SCHEMA, shapeHint, type CritiqueFinding } from './schema';
import type { Beat, BeatOutline, ConceptOption, DesignResult, Repair, ScriptHeader } from './types';
import { describeRecent, type PieceFingerprint } from './variety';
import { vocabularyCard } from './vocabulary';

/** What the host knows about the composition and the user. */
export interface AuthorBrief {
  prompt: string;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  /** Direction the user set in the composer (mood, accent, light/dark). */
  direction?: { mood?: string; accent?: string; mode?: 'dark' | 'light' };
  /** Imported assets the user named or attached, as one line each. */
  assets?: readonly string[];
  /** Images are attached to the design call. */
  imageCount?: number;
  /** The last pieces made here, newest first (variety.ts): the next one should not be a twin. */
  recent?: readonly PieceFingerprint[];
  /**
   * The concept the piece is built on, chosen at the concept stage (by the
   * user, or by the code as the one least like the recent pieces). The design
   * call builds THIS one and weighs no alternatives.
   */
  concept?: ConceptOption;
}

const SCRIPT_RULES = `HOW A SCENE SCRIPT WORKS
- You write JSON, never prose. The editor compiles it to real layers, effects and keyframes exactly as written — nothing is filled in for you. A colour, size, position, font, ease or time you leave out is NOT chosen for you; the engine's bare default applies, and it will look like it.
- Positions are the layer CENTRE in composition px. Frame origin is top-left.
- Times inside a beat are BEAT-LOCAL seconds (0 = the beat's start). Globals use composition seconds.
- Layers are listed BACK TO FRONT. A beat's layers exist only during the beat unless you give inSec/outSec; extend a layer past its beat's end to carry it across a cut (that is continuity, and it is what makes a film rather than a slideshow).
- Every animated property needs at least two keys at different times. ease applies to the segment that starts at that key.
- Colours are hex or $name from your palette. Text uses a typeStyle from your type scale and may override any field.
- Use roles honestly: one hero per beat; ambient and background for atmosphere; ui only for product interface elements.
- A layer id is unique across the WHOLE script and is how parents and mattes refer to it.
- Reach for the whole engine where it serves the idea: real 3D (threeD + z + a camera), effects with animated params, text animators, trim paths, repeaters, masks, mattes, blend modes, generated imagery (kind image) and your own vectors (kind svg). A piece made only of fading rectangles is a failure of imagination, not a safe choice.`;

/** The system prompt for the design and beat calls. */
export function authorSystemPrompt(brief: Pick<AuthorBrief, 'prompt'>, random?: () => number): string {
  const ex = selectAuthorExemplar(brief.prompt, random);
  return [
    'You are a senior motion designer authoring a complete motion-graphics composition for a professional animation engine. You design the whole piece — concept, palette, type, layout, staging, choreography, effects — and write it as a scene script the engine compiles exactly.',
    '',
    SCRIPT_RULES,
    '',
    CRAFT_RULES,
    '',
    NEVER_RULES,
    '',
    vocabularyCard(),
    '',
    `REFERENCE SCRIPT — "${ex.script.title}". ${ex.lesson} Take its STRUCTURE and level of finish; take none of its colours, words, sizes, timings, medium or light/dark choice — those belonged to its brief, and yours decides its own.`,
    JSON.stringify(ex.script),
  ].join('\n');
}

function aspectOf(w: number, h: number): string {
  const ar = w / h;
  return ar > 1.4 ? 'wide' : ar < 0.72 ? 'portrait' : ar > 0.95 && ar < 1.05 ? 'square' : 'near-square';
}

function briefLines(b: AuthorBrief): string[] {
  return [
    `Composition: ${b.width}×${b.height} (${aspectOf(b.width, b.height)}), ${b.fps} fps, ${b.durationSec}s — the user chose this; fill all of it and author nothing past it.`,
    ...(b.direction?.mood ? [`Mood the user set: ${b.direction.mood}.`] : []),
    ...(b.direction?.accent ? [`Accent the user set: ${b.direction.accent} — build the palette around it.`] : []),
    ...(b.direction?.mode ? [`The user wants a ${b.direction.mode} piece.`] : []),
    ...(b.assets?.length ? ['Media the user supplied (use it — it is why they attached it):', ...b.assets.map((a) => `  ${a}`)] : []),
  ];
}

/** A concept, in one line, for a prompt. */
export function describeConcept(c: ConceptOption): string {
  return `${c.name} — ${c.idea} (${c.medium}-led, ${c.value} frame; palette: ${c.palette}${c.swatches?.length ? ` = ${c.swatches.join(' ')}` : ''}; camera: ${c.camera}${c.type ? `; type: ${c.type}` : ''}${c.motion ? `; motion: ${c.motion}` : ''})`;
}

/**
 * Call 0: five candidate concepts for the brief, before any design. The host
 * scores them against the recent pieces (variety.ts `conceptDistance`), shows
 * the three least alike, and the user picks — or asks for three more, which
 * comes back here with the names already shown in `exclude`.
 */
export function conceptsPrompt(b: AuthorBrief, exclude: readonly string[] = []): string {
  return [
    `BRIEF: ${b.prompt}`,
    '',
    ...briefLines(b),
    ...(b.imageCount ? [`The attached image${b.imageCount > 1 ? 's are' : ' is'} REFERENCE for the look — read palette, type, density and mood from ${b.imageCount > 1 ? 'them' : 'it'}; take three of its dominant colours into at least one concept.`] : []),
    ...(b.recent?.length ? ['', 'The last pieces made in this editor were:', describeRecent(b.recent, 12), 'A concept that shares a recent piece\'s value, hue family, medium AND camera is a twin and will be thrown away. Move at least two of those.'] : []),
    ...(exclude.length ? ['', `Already shown and declined — do not repeat them or near variants: ${exclude.join('; ')}.`] : []),
    '',
    'Sketch FIVE concepts for this brief, the way a creative director pitches directions: each a short name, the one idea a viewer would remember, its medium (3d, image, ink, ui, shape, type or mixed), the value of the frame (light, mid, dark — read it from the brief; a brief that does not ask for night is not a dark piece by default), the palette in words AND as 3–5 hex swatches (background first, then surfaces, the accent, and a text colour that reads on that background — hue from the SUBJECT\'s world: coffee is roast and amber, fintech is slate and one signal colour, a garden is chlorophyll and clay; never the same indigo-on-charcoal for everything), a type pairing (display / body; a real pairing, named), the motion language (tempo, the ease family, the signature move) and what the camera does.',
    'The five must differ from EACH OTHER on at least two of value, medium, camera and hue family. One of them should be the unexpected reading of the brief.',
    `Return ONE JSON object: ${shapeHint(CONCEPTS_SCHEMA)}`,
  ].join('\n');
}

/** Call 1: the header, the beat outline and the globals. No beat layers. */
export function designPrompt(b: AuthorBrief): string {
  if (b.concept) {
    return [
      `BRIEF: ${b.prompt}`,
      '',
      ...briefLines(b),
      ...(b.imageCount ? [`The attached image${b.imageCount > 1 ? 's are' : ' is'} REFERENCE for the look — read palette, type, density and mood from ${b.imageCount > 1 ? 'them' : 'it'}; do not describe them back.`] : []),
      '',
      `THE CONCEPT, already chosen (build this one, weigh no alternatives): ${describeConcept(b.concept)}`,
      ...(b.concept.swatches?.length ? [`Its swatches are the palette: name them and reference them as $name. The background is ${b.concept.swatches[0]}.`] : []),
      ...(b.concept.type ? [`Its type pairing is the type scale: ${b.concept.type}.`] : []),
      ...(b.concept.motion ? [`Its motion language rules every ease and tempo: ${b.concept.motion}.`] : []),
      '',
      'Decide the approach for the concept, as a designer would before touching a layer: the signature motion a viewer would remember, what the camera does (if anything), and which engine capabilities the idea needs (real 3D and a camera, lights, effects with animated params, text animators, particles, masks, paths).',
      'Design the piece. Return ONE JSON object: `concepts` holding this one concept only, `chosen` 0, why in one sentence, the title, the intent, the palette (named swatches you will reference as $name), the grid, the type scale, the globals (piece-wide layers such as a backdrop or a front grain pass, in composition seconds), and the beat outline (2–6 beats that tile the whole duration; each with a name, a purpose and notes on what it shows).',
      `Shape: ${shapeHint(DESIGN_SCHEMA)}`,
    ].join('\n');
  }
  return [
    `BRIEF: ${b.prompt}`,
    '',
    ...briefLines(b),
    ...(b.imageCount ? [`The attached image${b.imageCount > 1 ? 's are' : ' is'} REFERENCE for the look — read palette, type, density and mood from ${b.imageCount > 1 ? 'them' : 'it'}; do not describe ${b.imageCount > 1 ? 'them' : 'it'} back.`] : []),
    '',
    'Before choosing, sketch THREE different concepts for this brief in `concepts` — each a name, the one idea, its medium (3d, image, ink, ui, shape, type or mixed), its value (light, mid or dark frame), its palette in words and what its camera does. They must differ on at least two of value, medium and camera: three dark type pieces are one concept three times. Then pick the one that serves THIS brief best (`chosen`, its index) and say why in `why`. Do not reach for a dark frame by habit: a near-black background is right for night, cinema or space, not as a default.',
    ...(b.recent?.length ? ['', 'The last pieces made in this editor were:', describeRecent(b.recent), 'Unless the brief asks for a series, the concept you choose must not repeat their value, medium and camera together.'] : []),
    '',
    'Then decide the approach for the chosen concept, as a designer would before touching a layer: what the one idea is, whether the piece is type-led, image-led, shape-led or 3D-led, what the camera does (if anything), what the signature motion is that a viewer would remember, and which engine capabilities the idea needs (real 3D and a camera, lights, effects with animated params, text animators, trim paths, repeaters, masks and mattes, generated imagery, your own vectors). Put that reasoning in `intent` — a few sentences, not a slogan. Do not default to centred type over a gradient with a fade: that is the result of not deciding.',
    'Design the piece. Return ONE JSON object: the three concepts, chosen and why, the title, the intent (the approach above), the palette (named swatches you will reference as $name), the grid, the type scale, the globals (piece-wide layers such as a backdrop or a front grain pass, in composition seconds), and the beat outline (2–6 beats that tile the whole duration; each with a name, a purpose and notes that say what the hero is, how it is staged and what the motion idea is). Do NOT write beat layers yet.',
    `Shape: ${shapeHint(DESIGN_SCHEMA)}`,
  ].join('\n');
}

/** A compact restatement of the design for the later calls. */
function designDigest(d: DesignResult | ScriptHeader & { beats: BeatOutline[] }): string {
  // The candidates stay with the design call; the beats need only the concept built.
  const { beats, concepts, chosen, why, ...head } = d as DesignResult;
  const picked = chosen !== undefined ? concepts?.[chosen] : undefined;
  return [
    ...(picked ? [`CONCEPT: ${picked.name} — ${picked.idea} (${picked.medium}-led, ${picked.value} frame, ${picked.palette}; camera: ${picked.camera})${why ? `. Chosen because: ${why}` : ''}`] : []),
    `DESIGN: ${JSON.stringify(head)}`,
    'BEAT OUTLINE:',
    ...beats.map((b, i) => `  ${i}. ${b.name} (${b.startSec}–${b.endSec}s) — ${b.purpose}${b.notes ? ` Notes: ${b.notes}` : ''}`),
  ].join('\n');
}

/** Call 2..n: the layers of up to three beats. */
export function beatsPrompt(b: AuthorBrief, design: DesignResult, indices: readonly number[], written: readonly Beat[] = []): string {
  const ids = written.flatMap((w) => w.layers.map((l) => l.id));
  return [
    `BRIEF: ${b.prompt}`,
    ...briefLines(b),
    '',
    designDigest(design),
    ...(ids.length ? ['', `Layer ids already used by earlier beats (do not reuse): ${ids.join(', ')}.`] : []),
    '',
    `Write the complete layers for beat${indices.length > 1 ? 's' : ''} ${indices.join(', ')}. Every layer fully specified: geometry, paint, type, effects, keys with eases. Times are beat-local.`,
    `Return ONE JSON object: ${shapeHint(BEATS_SCHEMA)}`,
  ].join('\n');
}

/** The critic's system prompt. */
export function critiqueSystemPrompt(): string {
  return [
    'You are a creative director reviewing a junior motion designer\'s render against the brief. You are specific and you are not polite about defects: you name the beat, the layer and the fix.',
    '',
    'Score the piece 1–10 on five axes in `scores`: contrast (type and hero read against what is behind them), hierarchy (one thing is clearly the subject of every frame), rhythm (the timing breathes; nothing arrives all at once or idles), novelty (it is not the obvious template and not a twin of the recent pieces named in the brief), brief (it is what was asked for). An axis under 7 must be explained by at least one beat finding, and that beat is a revise.',
    'For each beat decide keep or revise. Revise only for defects a viewer would notice: an empty or unbalanced frame, illegible type, elements colliding or clipped, a hero that does not read as the hero, motion that is static, mechanical, simultaneous or linear where it should not be, a beat that does not serve the brief, a cut where nothing carries over. Taste you merely would have done differently is not a defect.',
    'Every finding has a problem (what you see, with the time) and a fix (what to change, concretely — which layer, which property, to roughly what).',
    `Return ONE JSON object: ${shapeHint(CRITIQUE_SCHEMA)}`,
  ].join('\n');
}

export interface CritiqueInput {
  brief: AuthorBrief;
  design: DesignResult;
  /** The rendered evidence: an overall filmstrip, velocity graphs, one strip per beat (labelled in the text). */
  evidenceNotes: readonly string[];
  /** Mechanical verification of the built scene (verify.ts), already formatted. */
  mechanical?: string | null;
  advice: readonly AdvisorFinding[];
  repairs: readonly Repair[];
}

export function critiquePrompt(c: CritiqueInput): string {
  return [
    `BRIEF: ${c.brief.prompt}`,
    '',
    designDigest(c.design),
    '',
    'EVIDENCE (the attached images, in order):',
    ...c.evidenceNotes.map((n, i) => `  ${i + 1}. ${n}`),
    ...(c.mechanical ? ['', 'MECHANICAL CHECKS (measured on the built scene):', c.mechanical] : []),
    ...(c.advice.length ? ['', 'LINTER FINDINGS (advice; confirm against the frames before you act on one):', formatAdvice(c.advice)] : []),
    ...(c.repairs.length ? ['', 'REPAIRS THE COMPILER HAD TO MAKE (the script asked for something the engine does not take):', formatRepairs(c.repairs, 15)] : []),
  ].join('\n');
}

/** One revise call for one beat. */
export function revisePrompt(b: AuthorBrief, design: DesignResult, beatIndex: number, beat: Beat, findings: readonly CritiqueFinding[], advice: readonly AdvisorFinding[], otherIds: readonly string[]): string {
  return [
    `BRIEF: ${b.prompt}`,
    '',
    designDigest(design),
    '',
    `BEAT ${beatIndex} AS BUILT: ${JSON.stringify({ name: beat.name, purpose: beat.purpose, layers: beat.layers })}`,
    '',
    'WHAT THE REVIEW FOUND:',
    ...findings.map((f) => `- ${f.problem} → ${f.fix}${f.layers?.length ? ` (layers: ${f.layers.join(', ')})` : ''}`),
    ...(advice.length ? ['', 'LINTER FINDINGS FOR THIS BEAT:', formatAdvice(advice, 10)] : []),
    '',
    `Rewrite this beat's layers to fix every finding. Keep what works; this replaces the beat entirely, so return every layer it should have. Keep the beat's time window (${beat.startSec}–${beat.endSec}s); times stay beat-local.`,
    ...(otherIds.length ? [`Ids used by other beats (do not reuse): ${otherIds.join(', ')}.`] : []),
    `Return ONE JSON object: ${shapeHint(REVISE_SCHEMA)}`,
  ].join('\n');
}
