/**
 * The names After Effects addresses an effect parameter by
 * (`effect("Gaussian Blur")("Blurriness")`), for a pick-whip onto an effect
 * parameter's track (`effect.<id>.<key>`). Read off the document mirror; the
 * engine's `effect()` matches an effect by its definition's label and a
 * parameter by its label (docs/EXPRESSION_LANGUAGE.md).
 */

import { documentMirror } from '@stores/documentMirror';
import { mirrorEffects } from '@core/mirror/effects';
import { effectDefFor } from '@core/inspector/effectCatalog';
import type { WhipEffectNames } from './whipTarget';

export function whipEffectNames(nodeId: string, prop: string): WhipEffectNames | undefined {
  const m = /^effect\.([^.]+)\.([^.]+)$/.exec(prop);
  if (!m) return undefined;
  const effect = mirrorEffects(documentMirror().tree(nodeId)).find((e) => e.id === m[1]);
  const def = effect ? effectDefFor(effect.type) : undefined;
  const param = def?.params.find((p) => p.key === m[2]);
  return def && param ? { effect: def.label, param: param.label } : undefined;
}
