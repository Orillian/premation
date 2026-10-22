/**
 * DepthParallaxSection — Photo → 3D parallax (camera program D3) on an image
 * or video layer:
 *
 *   Depth Source  [AI estimate (Depth Anything) · <depth-map layers…>]
 *   Depth Scale · Mesh Detail · Edge Cut          (once the layer has a source)
 *   [Push In] [Orbit Sweep]                       (a camera move to show it off)
 *
 * The engine renders the layer as a camera-facing displaced grid
 * (threed_port.cpp); these rows only write its properties through the engine
 * API. Depth Scale 0 (or no source) = an ordinary flat layer.
 */

import { useState } from 'react';
import { t } from '@core/i18n';
import { Button } from '@components/Button';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { Icon } from '@components/Icon';
import { useComponentProp } from './useComponentProp';
import { KeyframeRow } from './KeyframeRow';
import { TwirlGroup } from './appearance/TwirlGroup';
import { useUIStore } from '@stores/uiStore';
import { documentMirror } from '@stores/documentMirror';
import { getTime } from '@stores/playbackClockStore';
import { applyAnimationPresetEdit } from '@layout/Menu/appEdits';
import { commandCamera } from '@core/scene/cameraCommands';
import {
  DEFAULT_DEPTH_SCALE, depthMapLayerChoices, isDepthParallaxCandidate, makeDepthFromLayer, makeDepthFromModel,
} from '@core/scene/depthParallax';
import styles from './TransformSection.module.css';

const TRANSFORM = { type: 'Transform' } as const;

function notify(message: string, level: 'info' | 'success' | 'warning'): void {
  useUIStore.getState().notify({ level, message, durationMs: 5000 });
}

/** A label for the stored source. */
function sourceLabel(source: string): string {
  if (!source) return t('inspector.depthParallax.none', 'None');
  if (source.startsWith('layer:')) return documentMirror().layer(source.slice(6))?.name ?? t('inspector.depthParallax.missingLayer', 'Missing layer');
  if (source.startsWith('seq:') || source.startsWith('src:')) return t('inspector.depthParallax.aiEstimate', 'AI estimate');
  return t('inspector.depthParallax.image', 'Image');
}

export function DepthParallaxSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  const [scaleRaw, setScale] = useComponentProp(nodeId, TRANSFORM, 'depthScale');
  const [detailRaw, setDetail] = useComponentProp(nodeId, TRANSFORM, 'depthMeshDetail');
  const [edgeRaw, setEdge] = useComponentProp(nodeId, TRANSFORM, 'depthEdgeCut');
  const [sourceRaw] = useComponentProp(nodeId, TRANSFORM, 'depthSource');
  const [busy, setBusy] = useState<string | null>(null);
  if (!isDepthParallaxCandidate(nodeId)) return null;
  const source = typeof sourceRaw === 'string' ? sourceRaw : '';
  const scale = typeof scaleRaw === 'number' ? scaleRaw : 0;
  const active = source !== '' && scale !== 0;

  const estimate = (): void => {
    setBusy(t('inspector.depthParallax.estimating', 'Estimating depth…'));
    void makeDepthFromModel(nodeId, scale || DEFAULT_DEPTH_SCALE, (p) => setBusy(t('inspector.depthParallax.estimatingPct', 'Estimating depth… {pct}%', { pct: Math.round(p * 100) }))).then((r) => {
      setBusy(null);
      notify(r.ok ? t('inspector.depthParallax.estimated', 'Depth estimated — the layer is 3D now; move a camera to see the parallax') : r.message, r.ok ? 'success' : 'warning');
    });
  };
  const items = (): DropdownItem[] => [
    { type: 'item', id: 'ai', label: t('inspector.depthParallax.aiItem', 'AI estimate (Depth Anything V2)'), onSelect: estimate },
    { type: 'separator' },
    { type: 'label', label: t('inspector.depthParallax.mapLayer', 'Depth map layer (white = near)') },
    ...depthMapLayerChoices(nodeId).map((c): DropdownItem => ({
      type: 'item', id: c.id, label: c.name,
      onSelect: () => { void makeDepthFromLayer(nodeId, c.id, scale || DEFAULT_DEPTH_SCALE); },
    })),
  ];
  const showOff = (preset: string): void => {
    const cam = commandCamera();
    if (!cam) {
      notify(t('inspector.depthParallax.needCamera', 'Add a camera to the composition first (Layer ▸ New ▸ Camera)'), 'info');
      return;
    }
    void applyAnimationPresetEdit([cam], preset, getTime());
  };

  return (
    <TwirlGroup
      prefKey="layer.depthParallax"
      label={<span title={t('inspector.depthParallax.hint', 'Make a photo or video 3D: its depth pushes each part toward or away from the camera, so a camera move reveals parallax')}>{t('inspector.depthParallax.title', 'Depth Parallax')}</span>}
      defaultOpen={active}
      summary={active ? sourceLabel(source) : t('inspector.depthParallax.off', 'Off')}
    >
      <div className={styles.popoverRow}>
        <span className={styles.popoverLabel}>{t('inspector.depthParallax.source', 'Depth Source')}</span>
        <Dropdown
          placement="bottom-end"
          trigger={
            <button type="button" className={styles.select} aria-label={t('inspector.depthParallax.source', 'Depth Source')} title={t('inspector.depthParallax.sourceHint', 'Where the depth comes from')}>
              <span>{busy ?? sourceLabel(source)}</span>
              <Icon name="chevron-down" size="sm" />
            </button>
          }
          items={items}
        />
      </div>
      {source !== '' && (
        <>
          <KeyframeRow nodeId={nodeId} prop="depthScale" label={t('inspector.depthParallax.scale', 'Depth Scale')} value={scale} unit="px" min={-5000} max={5000} onStatic={(v) => setScale(v)} />
          <KeyframeRow nodeId={nodeId} prop="depthMeshDetail" label={t('inspector.depthParallax.meshDetail', 'Mesh Detail')} value={typeof detailRaw === 'number' ? detailRaw : 128} min={2} max={256} precision={0} onStatic={(v) => setDetail(Math.round(v))} />
          <KeyframeRow nodeId={nodeId} prop="depthEdgeCut" label={t('inspector.depthParallax.edgeCut', 'Edge Cut')} value={typeof edgeRaw === 'number' ? edgeRaw : 0} min={0} max={1} precision={2} onStatic={(v) => setEdge(v)} />
          <div className={styles.actionRow}>
            <Button size="sm" variant="secondary" title={t('inspector.depthParallax.pushInHint', 'Push the active camera in from the playhead')} onClick={() => showOff('Push In')}>{t('inspector.depthParallax.pushIn', 'Push In')}</Button>
            <Button size="sm" variant="secondary" title={t('inspector.depthParallax.orbitHint', 'Orbit the active camera from the playhead')} onClick={() => showOff('Orbit Sweep')}>{t('inspector.depthParallax.orbit', 'Orbit Sweep')}</Button>
          </div>
        </>
      )}
    </TwirlGroup>
  );
}

export default DepthParallaxSection;
