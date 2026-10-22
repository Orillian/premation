/**
 * The starting briefs the assistant offers on an empty thread.
 *
 * Written the way a creative director writes a brief — subject, duration,
 * tone, the one thing that must land — and shown as a swatch strip and a
 * length, never as an emoji wall. A brief SEEDS the concept stage; it never
 * pins a look: the same brief produces three different concepts each time,
 * and the concept stage keeps them apart from the pieces made before.
 *
 * The swatches are the brief's own mood, not a palette the AI is told to use.
 */

import { t } from '@core/i18n';

export interface StartingBrief {
  id: string;
  title: string;
  /** One line under the title: what the piece does. */
  blurb: string;
  /** Three colours that read as the brief's mood, background first. */
  swatches: [string, string, string];
  /** The length the brief asks for, seconds. */
  seconds: number;
  /** The prompt the assistant gets. */
  prompt: string;
}

/**
 * The briefs, with their title and blurb in the UI language. A function, not a
 * constant: `t()` must run at render time, after the catalogue loads. The
 * prompt stays as written — it is what the model is given.
 */
export function startingBriefs(): readonly StartingBrief[] {
  return [
  {
    id: 'product-reveal', title: t('aiChat.brief.productReveal.title', 'Product reveal'), blurb: t('aiChat.brief.productReveal.blurb', 'One object, slow camera, type that waits'), swatches: ['#0f1a2e', '#e9b86a', '#f2efe8'], seconds: 8,
    prompt: 'An 8-second product reveal for a premium object. One hero shot, a slow camera push through real depth, a single light that sweeps it, and a title that waits until the object has landed. Restrained, expensive, unhurried.',
  },
  {
    id: 'kinetic-headline', title: t('aiChat.brief.kineticHeadline.title', 'Kinetic headline'), blurb: t('aiChat.brief.kineticHeadline.blurb', 'Word-by-word, hard cuts, one accent'), swatches: ['#141414', '#ff4d2e', '#ffffff'], seconds: 6,
    prompt: 'A 6-second kinetic typography headline: "Make it move". Word by word, hard cuts on the beat, scale contrast between words, one accent colour that lands on the last word. Punchy, no fades.',
  },
  {
    id: 'explainer', title: t('aiChat.brief.explainer.title', 'Explainer, 3 scenes'), blurb: t('aiChat.brief.explainer.blurb', 'Cards, stagger, a camera pass per scene'), swatches: ['#1d2a24', '#9fd3b3', '#f5f1e6'], seconds: 20,
    prompt: 'A 20-second three-scene explainer for a scheduling app. Scene 1 names the problem, scene 2 shows three feature cards staggering in, scene 3 lands the name and a line. A camera pass per scene, clean transitions that carry one element across the cut.',
  },
  {
    id: 'lower-third', title: t('aiChat.brief.lowerThird.title', 'Lower third'), blurb: t('aiChat.brief.lowerThird.blurb', 'Name, role, a bar that draws in'), swatches: ['#101012', '#4f8cff', '#dfe6f3'], seconds: 4,
    prompt: 'A 4-second broadcast lower third for "Amara Okafor, Head of Design". A bar that draws in, the name sliding in behind a mask, the role a beat later, and a clean exit at the end. Broadcast-safe, nothing decorative.',
  },
  {
    id: 'logo-sting', title: t('aiChat.brief.logoSting.title', 'Logo sting'), blurb: t('aiChat.brief.logoSting.blurb', 'Trim-path draw, settle, flash'), swatches: ['#2a1b3d', '#ff7bd1', '#ffe08a'], seconds: 3,
    prompt: 'A 3-second logo sting for a studio called "Northlight". The wordmark outline draws on with a trim path, the fill settles in, one flash of light crosses it, then a hold. Confident, fast, one idea.',
  },
  {
    id: 'cinematic-trailer', title: t('aiChat.brief.cinematicTrailer.title', 'Cinematic trailer'), blurb: t('aiChat.brief.cinematicTrailer.blurb', 'Slow, dark, one line at a time'), swatches: ['#0a0a0c', '#8a1c1c', '#d9d2c5'], seconds: 15,
    prompt: 'A 15-second cinematic trailer for a short film called "The Last Blade". Dark frame, slow type that arrives one line at a time with long holds, a camera that drifts, atmosphere particles, the title last. Tension, not noise.',
  },
  {
    id: 'app-promo', title: t('aiChat.brief.appPromo.title', 'App promo'), blurb: t('aiChat.brief.appPromo.blurb', 'A phone, UI cards, bright and quick'), swatches: ['#f4f4f6', '#2b7eff', '#111318'], seconds: 12,
    prompt: 'A 12-second app promo on a light frame. A phone-sized card in the centre, three UI cards that fly in and stack, a counter that rolls up, a bold line at the end. Bright, quick, friendly eases with a little overshoot.',
  },
  {
    id: 'data-story', title: t('aiChat.brief.dataStory.title', 'Data story'), blurb: t('aiChat.brief.dataStory.blurb', 'Bars grow, a number lands, one takeaway'), swatches: ['#0e1420', '#36d399', '#e8edf5'], seconds: 10,
    prompt: 'A 10-second data story: "Renewables passed coal in 2025". Bars that grow on a grid, one number that counts up and lands big, the takeaway line at the end. Precise, tabular, nothing bouncy.',
  },
  {
    id: 'event-opener', title: t('aiChat.brief.eventOpener.title', 'Event opener'), blurb: t('aiChat.brief.eventOpener.blurb', 'Dates, place, a burst of energy'), swatches: ['#1a1026', '#ffb547', '#ff3c78'], seconds: 8,
    prompt: 'An 8-second event opener for "Signal Festival, 14–16 May, Lisbon". Energetic, a radial burst, the dates big and fast, the place smaller, the name last. Warm colours on a dark frame; motion with overshoot.',
  },
  {
    id: 'quote-card', title: t('aiChat.brief.quoteCard.title', 'Quote card'), blurb: t('aiChat.brief.quoteCard.blurb', 'A long quote that breathes, one name'), swatches: ['#f3ead8', '#2b2622', '#c8552f'], seconds: 9,
    prompt: 'A 9-second quote card on a paper-light frame: "Simplicity is the ultimate sophistication." Serif type that breathes in a phrase at a time, generous margins, the attribution small at the end. Calm, editorial.',
  },
  {
    id: 'countdown', title: t('aiChat.brief.countdown.title', 'Countdown'), blurb: t('aiChat.brief.countdown.blurb', 'Ten to one, each number its own beat'), swatches: ['#000000', '#ffffff', '#ff2d55'], seconds: 10,
    prompt: 'A 10-second countdown from 10 to 1. Each number gets its own beat and its own entrance — not the same move ten times — with one accent colour and a final hit on 1. Rhythm first.',
  },
  {
    id: 'retro-title', title: t('aiChat.brief.retroTitle.title', 'Retro title'), blurb: t('aiChat.brief.retroTitle.blurb', 'Chrome type, a grid floor, a sunset'), swatches: ['#160b2e', '#ff6ec7', '#ffd166'], seconds: 7,
    prompt: 'A 7-second retro title card: "Neon Drive". Chrome-feeling type on a perspective grid floor, a gradient sunset behind, scanline grain on top, the title rising from the floor into the light. Period-correct, not ironic.',
  },
  {
    id: 'portfolio-intro', title: t('aiChat.brief.portfolioIntro.title', 'Portfolio intro'), blurb: t('aiChat.brief.portfolioIntro.blurb', 'A name, a role, three words that matter'), swatches: ['#ffffff', '#111111', '#3b6cff'], seconds: 6,
    prompt: 'A 6-second portfolio intro for "Jonas Ruiz, motion designer". White frame, black type, one blue accent. The name, the role, then three words — "clear, quick, alive" — each with a different entrance. Minimal and sharp.',
  },
  {
    id: 'ambient-loop', title: t('aiChat.brief.ambientLoop.title', 'Ambient loop'), blurb: t('aiChat.brief.ambientLoop.blurb', 'Orbs, gradients, nothing in a hurry'), swatches: ['#0b0f1a', '#5b6cff', '#9ad7ff'], seconds: 12,
    prompt: 'A 12-second ambient background loop: soft gradient orbs drifting with wiggle expressions, slow colour shifts, a faint grain. No text. It should loop cleanly and never draw the eye.',
  },
  ];
}

/** The briefs shown before "All N" is opened. */
export const BRIEFS_SHOWN = 5;
