/**
 * @motion/author — author mode.
 *
 * ```
 * prompt
 *   ├─▶ [LLM]  DESIGN            designPrompt()           header, outline, globals
 *   ├─▶ [LLM]  BEATS (≤3/call)   beatsPrompt()            layers per beat
 *   ├─▶ [code] COERCE            coerceDesign/coerceBeat  valid script + repairs
 *   ├─▶ [code] COMPILE           compileScript()          ToolCall[] + per-beat ranges
 *   ├─▶ [code] ADVISE            adviseScript()           the caster's linters, per beat
 *   ├─▶ [host] EXECUTE + LOOK    (src/core/ai/author/AuthorRunner.ts)
 *   ├─▶ [LLM]  CRITIQUE          critiquePrompt()         keep / revise per beat
 *   └─▶ [LLM]  REVISE            revisePrompt()           → rebuildCalls()
 * ```
 *
 * Pure: builds prompts, validates responses, compiles calls. No network, no
 * document — the host executes inside the run's transaction.
 */

export * from './types';
export {
  ANIMATABLE,
  ANIMATABLE_PROPS,
  AI_EFFECT_TYPES,
  AUTHOR_EFFECTS,
  BLEND_MODES,
  CAMERA_ONLY,
  COLOUR_FIELDS,
  CREATE_FIELDS,
  PATH_OPS,
  PROP_ALIASES,
  STATIC_FIELDS,
  TEXT_ANIMATOR_FIELDS,
  LIGHT_ONLY,
  MATERIAL_FIELDS,
  PRIMITIVE_ONLY,
  THREE_D_ONLY,
  authorEffect,
  vocabularyCard,
  type FieldSpec,
} from './vocabulary';
export {
  IdPool,
  coerceBeat,
  coerceConcepts,
  coerceDesign,
  coerceScript,
  formatRepairs,
  nearestEffect,
  nearestParam,
  type CoerceContext,
  type Coerced,
} from './coerce';
export {
  TAIL_ROOT,
  beatRootId,
  compileScript,
  pathOpHandle,
  rebuildCalls,
  repeaterHandle,
  sameFrameKeys,
  trimHandle,
  type CompileOptions,
} from './compile';
export { adviseScript, formatAdvice, type Advice, type AdviseOptions, type AdvisorFinding } from './advisors';
export {
  BEATS_SCHEMA,
  CONCEPTS_SCHEMA,
  CRITIQUE_AXES,
  CRITIQUE_SCHEMA,
  DESIGN_SCHEMA,
  LAYER_SCHEMA,
  REVISE_SCHEMA,
  coerceCritique,
  shapeHint,
  type BeatCritique,
  type Critique,
  type CritiqueAxis,
  type CritiqueFinding,
} from './schema';
export {
  authorSystemPrompt,
  beatsPrompt,
  critiquePrompt,
  critiqueSystemPrompt,
  conceptsPrompt,
  describeConcept,
  designPrompt,
  revisePrompt,
  type AuthorBrief,
  type CritiqueInput,
} from './prompts';
export { AUTHOR_EXEMPLARS, selectAuthorExemplar, type AuthorExemplar } from './exemplars';
export {
  DIVERSITY_THRESHOLDS,
  depthSceneOfScript,
  diversityOf,
  describeRecent,
  fingerprintOf,
  fingerprintScript,
  hueFamily,
  lintVariety,
  luminance,
  valueOf,
  type DepthLayer,
  conceptDistance,
  type DiversityReport,
  type DiversityThresholds,
  type DepthScene,
  type PieceFingerprint,
  type PieceHistory,
  type VarietyFinding,
  type VarietyOptions,
} from './variety';
export { READABLE_RATIO, cleanSwatches, contrastRatio, ensureReadable } from './palette';
