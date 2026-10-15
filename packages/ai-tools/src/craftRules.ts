/**
 * The craft floor, stated once.
 *
 * Two prompts teach a model to author motion: the direct tool loop's
 * `SYSTEM_PROMPT` (src/core/ai/buildContext.ts) and author mode's system
 * prompt (`@motion/author` prompts.ts). They used to be one copy in the
 * first; a second hand-written copy in the second would drift the first
 * time either was tuned. So the rules live here and both interpolate them.
 *
 * Plain strings, no tool-specific syntax beyond names every mode shares.
 */

/** Timing, easing, stagger and distance — in two registers — and staging in depth. */
export const CRAFT_RULES = `CRAFT — this is what separates competent from good
- A property needs at least TWO keyframes at different times to animate. One keyframe holds a constant.
- Almost nothing should be linear. Use easeOut for things arriving, easeIn for things leaving, easeInOut for moves between two rests. Reserve linear for continuous motion (rotation, drifting).
- Overshoot reads as life: easing "bezier" with [0.34, 1.56, 0.64, 1] gives a confident pop. Understated beats bouncy.
- Stagger. When several things enter together, offset each by ~0.06-0.12s. Simultaneous entrances look mechanical.
- Animate opacity AND a transform together. Opacity alone looks flat.
- Respect the composition duration — never author past it.

TWO REGISTERS — decide which one each element is in; a good piece usually has both.
- ELEMENT register (type, UI, icons, cards entering and leaving): short and precise. A fade 0.3-0.5s, an entrance 0.4-0.8s, an emphasis pulse 0.2-0.3s; travel 20-60px; a multi-second entrance on a word feels broken.
- CINEMATIC register (cameras, lights, worlds, hero objects, backgrounds): long and continuous. Camera moves of 3-10s eased in and out — a push, a drift, an orbit, a crane — that span a whole beat or the whole piece and never stop dead; parallax from layers spread over 1000px+ of z; a light that travels across a surface; a rack focus between depths; slow scale drifts on plates (1.1 → 1.0 over the shot); a held hero frame at the end. Turn motionBlur on for anything fast.
- The registers layer: precise type entrances happen INSIDE a slow camera move, not instead of one.

STAGING IN DEPTH — when the idea has space, build the space.
- Put content layers in 3D at distinct depths (background z≈+600…+1200, subject 0, foreground −200…−500), THEN move a camera through them. A camera over flat 2D layers is only a zoom.
- Real objects beat cards: extruded type and shapes (extrusionDepth, bevelDepth), primitives (sphere, torus, box…), PBR materials (metal, roughness), glass (transparency, ior).
- Light them like a set: a key with soft shadows, a fill, a rim, an environment for reflections, and a surface for the shadows to land on.`;

/** The failure modes past runs shipped, each phrased as a prohibition. */
export const NEVER_RULES = `NEVER DO THESE (they are why past attempts looked amateur)
- NEVER leave layers stacked on the same spot. Give EVERY layer an explicit x,y so the composition is laid out deliberately — a title high, a subtitle below it, elements spaced apart. Two things at the same position is a bug, not a design.
- NEVER let everything appear at the same instant. Every element that enters MUST have its own entrance keyframes (opacity 0→100 paired with a transform), and their START times MUST be staggered by ~0.06–0.15s. If five things appear together with no offset, you have failed.
- NEVER leave an element at full opacity from frame 0 when it is supposed to animate in — its first opacity keyframe must be 0 at its start time. A layer with no entrance keyframes is just on-screen the whole time.
- NEVER animate a camera over layers that are all 2D (threeD off) or all at one depth: that is a flat zoom, not a camera move. Turn the layers 3D and give them different z first.
- NEVER default to a near-black background. The value of the frame is a decision from the brief: paper, daylight, a saturated colour field, a pale studio, a photograph — or dark when the brief is night, cinema or space. Dark is one choice, not the safe one.
- After you render and review, if the frames show overlap, empty space, or things appearing together — fix it. That is the whole point of looking.`;
