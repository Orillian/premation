/**
 * Tooltips for built-in effect controls whose behaviour is not what the name
 * alone says — the Object Matte card's propagation settings, which change
 * nothing until the next propagation (they are baked into the matte frames).
 * A native plugin's descriptions come from its own definition instead.
 */

import { t } from '@core/i18n';

const NEXT = (): string => t('effects.objectMatte.nextPropagation', 'Applies on the next propagation: the matte frames are made with it.');

/** The tooltip of `type`'s param `key`, if it has one. */
export function builtinParamHint(type: string, key: string): string | undefined {
  if (type !== 'object-matte') return undefined;
  switch (key) {
    case 'version':
      return t('effects.objectMatte.versionHint', 'The Object Matte model version the matte was made with.');
    case 'quality':
      return `${t('effects.objectMatte.qualityHint', 'Best refines the edge band at twice the Edge Radius (slower).')} ${NEXT()}`;
    case 'edgeRadius':
    case 'decontaminate':
    case 'decontaminationAmount':
    case 'motionBlur':
    case 'reduceChatter':
    case 'chatterAmount':
    case 'renderRefineEdge':
      return NEXT();
    case 'invert':
      return t('effects.objectMatte.invertHint', 'Keep the background instead of the subject. Live.');
    case 'fineTune':
      return t('effects.objectMatte.fineTuneHint', 'Apply Feather, Contrast and Shift Edge to the matte. Live.');
    case 'feather':
    case 'contrast':
    case 'shiftEdge':
      return t('effects.objectMatte.liveHint', 'Live, while Fine-tune Roto Brush Matte is on.');
    default:
      return undefined;
  }
}

/** The tooltip of `type`'s control group `group`, if it has one. */
export function builtinGroupHint(type: string, group: string): string | undefined {
  if (type !== 'object-matte') return undefined;
  if (group === 'Propagation') return NEXT();
  return undefined;
}
