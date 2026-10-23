/**
 * Ready-made Premation workflows, offered as MCP prompts — in Claude Desktop
 * they appear in the "+" menu as starting points ("Logo reveal", "Product
 * promo", …). Each is a brief that tells Claude how to plan and build a
 * complex piece with Premation's tools, so a one-line ask turns into a
 * designed, multi-step build that Claude checks with its own eyes.
 */

export interface PromptArg {
  name: string;
  description: string;
  required?: boolean;
}

export interface PremationPrompt {
  name: string;
  title: string;
  description: string;
  arguments: PromptArg[];
  build(args: Record<string, string>): string;
}

const HOW = [
  'How to work:',
  '- get_app_state first. If no project is open, create_project with the right frame; otherwise list_compositions and describe_scene.',
  '- Plan the piece as beats with timings before building, and tell me the plan in two or three lines.',
  '- Build each request inside begin_edit / end_edit so it is one undo step.',
  '- For the whole design, read get_author_guide and use author_scene; then refine with the individual tools (set_easing, text_animator, add_effect, add_camera_move, set_light).',
  '- After building, render_filmstrip across the piece and analyze_motion on each beat (render_motion_sheet on a hero move): judge timing, spacing and legibility from the measurements, fix what is weak, then save_project.',
].join('\n');

export const PREMATION_PROMPTS: readonly PremationPrompt[] = [
  {
    name: 'logo_reveal',
    title: 'Logo reveal',
    description: 'A cinematic reveal of a brand name or logo: build-up, reveal, settle, with light and camera.',
    arguments: [
      { name: 'brand', description: 'The name (or text) to reveal', required: true },
      { name: 'style', description: 'Mood, e.g. "dark tech, cyan glow" or "warm, elegant gold"' },
      { name: 'seconds', description: 'Length in seconds (default 6)' },
    ],
    build: (a) => [
      `In Premation, make a ${a.seconds || '6'}-second logo reveal for "${a.brand}"${a.style ? `, style: ${a.style}` : ''}.`,
      'Structure: a short build-up (particles, light sweep or shapes converging), the reveal on a strong beat, then a calm settle with a subtle camera drift. 1920×1080, 30 fps unless a project is already open.',
      HOW,
    ].join('\n\n'),
  },
  {
    name: 'kinetic_typography',
    title: 'Kinetic typography',
    description: 'Animate a quote or script line by line with rhythm, emphasis words and transitions.',
    arguments: [
      { name: 'text', description: 'The words to animate', required: true },
      { name: 'mood', description: 'e.g. "energetic", "calm", "dramatic"' },
    ],
    build: (a) => [
      `In Premation, create a kinetic typography piece for this text:\n"""${a.text}"""`,
      `Mood: ${a.mood || 'energetic'}. Break it into phrases, give each its own beat, emphasise the key words (scale, colour or weight), and transition between phrases with motion, not cuts. Use text_animator for per-word or per-letter motion.`,
      HOW,
    ].join('\n\n'),
  },
  {
    name: 'product_promo',
    title: 'Product promo',
    description: 'A multi-scene promo: hook, features, call to action — as compositions you can re-cut.',
    arguments: [
      { name: 'product', description: 'What is being promoted', required: true },
      { name: 'points', description: 'Key selling points, comma separated' },
      { name: 'format', description: '"16:9", "9:16" or "1:1" (default 16:9)' },
    ],
    build: (a) => [
      `In Premation, make a 15–20 second promo for ${a.product}${a.points ? `. Selling points: ${a.points}` : ''}. Format: ${a.format || '16:9'}.`,
      'Structure: hook (2–3 s) → one scene per selling point → call to action with the product name. Build each scene as its own composition (create_composition), then a main composition that sequences them (create_precomp / set_layer_timing) with transitions between scenes.',
      HOW,
    ].join('\n\n'),
  },
  {
    name: 'social_vertical',
    title: 'Vertical social clip',
    description: 'A 9:16 clip for Reels / Shorts / TikTok: big type, fast hook, safe margins.',
    arguments: [
      { name: 'topic', description: 'What the clip says', required: true },
      { name: 'seconds', description: 'Length (default 10)' },
    ],
    build: (a) => [
      `In Premation, make a ${a.seconds || '10'}-second vertical (1080×1920) clip about: ${a.topic}.`,
      'Hook in the first second, large legible type, keep text inside the middle 80% (UI overlays cover the edges), punchy easing, a clear ending frame.',
      HOW,
    ].join('\n\n'),
  },
  {
    name: 'polish_animation',
    title: 'Polish my animation',
    description: 'Review the open composition and improve timing, easing, spacing and hierarchy.',
    arguments: [{ name: 'focus', description: 'Anything specific to improve' }],
    build: (a) => [
      'In Premation, review the active composition and polish it like a senior motion designer.',
      `${a.focus ? `Focus on: ${a.focus}. ` : ''}Start with describe_scene, read_tracks and render_filmstrip. List the three biggest problems (timing, easing, overlap, hierarchy, legibility), fix them inside one begin_edit / end_edit, then show a new filmstrip and say what changed.`,
    ].join('\n\n'),
  },
];

export function findPrompt(name: string): PremationPrompt | undefined {
  return PREMATION_PROMPTS.find((p) => p.name === name);
}
