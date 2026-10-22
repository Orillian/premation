/**
 * AssetDrawer — the footage header, as a drawer under the list.
 *
 * AE keeps a strip above the project panel that describes the selected
 * footage; this is that strip, docked at the bottom where it can be taller
 * and always present, so the panel answers "what IS this file" without a
 * dialog: codec, resolution, frame rate, duration, alpha, size, where the
 * bytes live, and — the part AE never had — which layers use it, each one
 * a click away.
 *
 * Tags are edited here too, because the drawer is the one place the panel
 * shows a single asset's own facts rather than a row in a list.
 */

import { useEffect, useState } from 'react';
import { Chip } from '@components/Chip';
import { Icon } from '@components/Icon';
import { Input } from '@components/Input';
import { LABEL_COLORS } from '@core/scene/labelColor';
import type { ImportedAsset } from '@stores/assetStore';
import { getAssetVisualInfo } from './assetVisuals';
import { formatBytes, formatDuration, formatImportDate, parseTags } from './assetListLogic';
import { assetDiskPath } from './assetReveal';
import { useEngineThumb } from './AssetThumb';
import styles from '@layout/EditorLayout/panels.module.css';
import { t } from '@core/i18n';

export interface AssetDrawerProps {
  asset: ImportedAsset | null;
  /** How many rows are selected — the drawer describes exactly one. */
  selectionCount: number;
  open: boolean;
  onToggle: () => void;
  /** Layer ids referencing the asset, with their names. */
  usedBy: ReadonlyArray<{ id: string; name: string }>;
  onSelectLayer: (layerId: string) => void;
  onSetTags: (assetId: string, tags: string[]) => void;
}

function fpsText(fps: number | undefined): string | null {
  if (!fps || fps <= 0) return null;
  return `${fps % 1 === 0 ? fps : fps.toFixed(3)} fps`;
}

export function AssetDrawer({ asset, selectionCount, open, onToggle, usedBy, onSelectLayer, onSetTags }: AssetDrawerProps): JSX.Element {
  const [tagDraft, setTagDraft] = useState('');
  const m = asset?.metadata ?? {};
  const visual = asset ? getAssetVisualInfo(asset) : null;
  const label = asset?.label ? LABEL_COLORS.find((c) => c.id === asset.label) : undefined;
  const path = asset ? assetDiskPath(asset) : null;
  // The item's picture, beside its facts — a still's own pixels, a video's poster.
  // A file only the engine decodes (a plugin-imported .ppm): its thumbnail (AssetThumb's useEngineThumb).
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => setImgFailed(false), [asset?.id]);
  const engineThumb = useEngineThumb(asset ?? null, imgFailed);
  const thumb = asset ? asset.thumbSrc ?? (engineThumb !== undefined ? engineThumb ?? undefined : asset.type === 'image' ? asset.src : undefined) : undefined;

  const commitTags = (): void => {
    if (!asset) return;
    const next = parseTags(tagDraft);
    if (next.length === 0) return;
    const merged = parseTags([...(asset.tags ?? []), ...next].join(','));
    onSetTags(asset.id, merged);
    setTagDraft('');
  };

  const heading = asset
    ? asset.name
    : selectionCount > 1
      ? t('assets.drawer.selected', '{n} assets selected', { n: selectionCount })
      : t('assets.drawer.details', 'Details');

  return (
    <div className={styles.assetDrawer} data-asset-drawer="">
      <button type="button" className={styles.assetDrawerHead} onClick={onToggle} aria-expanded={open} title={heading}>
        <span>{heading}</span>
        {visual && <span>{visual.label}</span>}
        <Icon name={open ? 'chevron-down' : 'chevron-up'} size="sm" />
      </button>
      {open && (
        asset ? (
          <div className={styles.assetDrawerBody}>
            {thumb ? <img src={thumb} alt="" className={styles.assetDrawerThumb} onError={() => setImgFailed(true)} /> : null}
            <dl className={styles.assetDrawerGrid}>
              {m.width && m.height ? (
                <>
                  <dt className={styles.assetDrawerKey}>{t('assets.drawer.resolution', 'Resolution')}</dt>
                  <dd className={styles.assetDrawerVal}>
                    {Math.round(m.width * (asset.interpret?.par ?? 1))}×{m.height}
                    {asset.interpret?.par && asset.interpret.par !== 1 ? ` (PAR ${asset.interpret.par.toFixed(3)})` : ''}
                  </dd>
                </>
              ) : null}
              {m.duration && m.duration > 0 ? (
                <>
                  <dt className={styles.assetDrawerKey}>{t('assets.drawer.duration', 'Duration')}</dt>
                  <dd className={styles.assetDrawerVal}>{formatDuration(m.duration)} ({m.duration.toFixed(2)}s)</dd>
                </>
              ) : null}
              {fpsText(asset.interpret?.conformFps ?? m.fps) ? (
                <>
                  <dt className={styles.assetDrawerKey}>{t('assets.drawer.frameRate', 'Frame rate')}</dt>
                  <dd className={styles.assetDrawerVal}>
                    {fpsText(asset.interpret?.conformFps ?? m.fps)}
                    {asset.interpret?.conformFps && m.fps && asset.interpret.conformFps !== m.fps
                      ? t('assets.drawer.conformedFrom', ' (conformed from {fps})', { fps: fpsText(m.fps) ?? '' })
                      : ''}
                  </dd>
                </>
              ) : null}
              {asset.type !== 'image' ? (
                <>
                  <dt className={styles.assetDrawerKey}>{t('assets.drawer.codec', 'Codec')}</dt>
                  <dd className={styles.assetDrawerVal}>
                    {m.codec ? m.codec.toUpperCase() : t('assets.drawer.unknown', 'Unknown')}
                    {m.container ? ` · ${m.container.split(',')[0]}` : ''}
                  </dd>
                </>
              ) : null}
              {asset.type !== 'audio' ? (
                <>
                  <dt className={styles.assetDrawerKey}>{t('assets.drawer.colour', 'Colour')}</dt>
                  <dd className={styles.assetDrawerVal}>
                    {m.hasAlpha === true
                      ? t('assets.drawer.rgbAlpha', 'RGB + alpha')
                      : m.hasAlpha === false
                        ? t('assets.drawer.rgbNoAlpha', 'RGB, no alpha')
                        : 'RGB'}
                    {asset.interpret?.alpha ? ` · ${asset.interpret.alpha}` : ''}
                  </dd>
                </>
              ) : null}
              {asset.type !== 'image' ? (
                <>
                  <dt className={styles.assetDrawerKey}>{t('assets.drawer.audio', 'Audio')}</dt>
                  <dd className={styles.assetDrawerVal}>
                    {m.hasAudioTrack === true
                      ? m.audioChannels
                        ? t('assets.drawer.channels', '{n} ch', { n: m.audioChannels })
                        : t('assets.drawer.audioYes', 'yes')
                      : m.hasAudioTrack === false ? t('assets.drawer.audioNone', 'none') : t('assets.drawer.notProbed', 'not probed')}
                  </dd>
                </>
              ) : null}
              <dt className={styles.assetDrawerKey}>{t('assets.drawer.size', 'Size')}</dt>
              <dd className={styles.assetDrawerVal}>{formatBytes(asset.size)}</dd>
              <dt className={styles.assetDrawerKey}>{t('assets.drawer.imported', 'Imported')}</dt>
              <dd className={styles.assetDrawerVal}>{formatImportDate(asset.importedAt)}</dd>
              {label ? (
                <>
                  <dt className={styles.assetDrawerKey}>{t('assets.drawer.label', 'Label')}</dt>
                  <dd className={styles.assetDrawerVal}>
                    <span className={styles.assetLabelDot} style={{ background: label.color }} aria-hidden /> {label.label}
                  </dd>
                </>
              ) : null}
              <dt className={styles.assetDrawerKey}>{t('assets.drawer.path', 'Path')}</dt>
              <dd className={`${styles.assetDrawerVal} ${styles.assetDrawerValWrap}`} title={path ?? undefined}>
                {path ?? (asset.src.startsWith('blob:')
                  ? t('assets.drawer.localStore', 'Local store (this device)')
                  : asset.src.startsWith('http') ? t('assets.drawer.cloud', 'Cloud') : asset.src)}
              </dd>
              <dt className={styles.assetDrawerKey}>{t('assets.drawer.tags', 'Tags')}</dt>
              <dd className={`${styles.assetDrawerVal} ${styles.assetDrawerValWrap}`}>
                <span className={styles.assetDrawerUsage}>
                  {(asset.tags ?? []).map((tag) => (
                    <Chip
                      key={tag}
                      size="sm"
                      removeLabel={t('assets.drawer.removeTag', 'Remove tag {tag}', { tag })}
                      onRemove={() => onSetTags(asset.id, (asset.tags ?? []).filter((x) => x !== tag))}
                    >
                      {tag}
                    </Chip>
                  ))}
                </span>
                <Input
                  size="sm"
                  fullWidth
                  value={tagDraft}
                  placeholder={t('assets.drawer.tagsPlaceholder', 'Add tags, comma-separated')}
                  aria-label={t('assets.drawer.addTags', 'Add tags')}
                  onChange={(e) => setTagDraft(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitTags(); }
                    if (e.key === 'Escape') setTagDraft('');
                    // The list's Delete / Ctrl+A handlers sit above this input.
                    e.stopPropagation();
                  }}
                  onBlur={commitTags}
                />
              </dd>
              <dt className={styles.assetDrawerKey}>{t('assets.drawer.usedBy', 'Used by')}</dt>
              <dd className={`${styles.assetDrawerVal} ${styles.assetDrawerValWrap}`}>
                {usedBy.length === 0 ? (
                  t('assets.drawer.noLayers', 'No layers')
                ) : (
                  <span className={styles.assetDrawerUsage}>
                    {usedBy.map((u) => (
                      <Chip key={u.id} size="sm" icon="layers" onSelect={() => onSelectLayer(u.id)}>
                        {u.name}
                      </Chip>
                    ))}
                  </span>
                )}
              </dd>
            </dl>
          </div>
        ) : (
          <div className={styles.assetDrawerEmpty}>
            {selectionCount > 1
              ? t('assets.drawer.selectOne', 'Select one asset to see its details.')
              : t('assets.drawer.selectAsset', 'Select an asset to see its details.')}
          </div>
        )
      )}
    </div>
  );
}
