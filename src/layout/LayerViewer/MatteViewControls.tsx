/**
 * The Layer panel's matte views on its bottom bar, as in After Effects 26:
 * Alpha, Alpha Boundary and Alpha Overlay toggles (Alt+4 / 5 / 6), the
 * overlay's colour and opacity, and Freeze for the Roto Brush matte.
 *
 * The views are the ENGINE's (setViewport `layerAlphaView`, with the overlay
 * tint `layerAlphaOverlayColor` / `layerAlphaOverlayOpacity`): it draws the
 * layer's real alpha — the Object Matte cut, masks, effects — not an outline
 * guessed in the page. Freeze is the Roto tool's own edit (rotoFreezeEdit),
 * one undo entry.
 */

import { useEffect, type ReactNode } from 'react';
import { ColorPicker } from '@components/ColorPicker';
import { ValueField } from '@components/ValueField';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import { edit } from '@core/engine/uiEdits';
import { rotoFreezeEdit, rotoMattes } from '@core/workspace/rotoBrushTool';
import { useLayerViewerStore, type LayerAlphaView } from '@stores/layerViewerStore';
import { t } from '@core/i18n';
import styles from './LayerViewer.module.css';

type View = Exclude<LayerAlphaView, 'off'>;

/** AE's glyphs, drawn small: the matte (white on black), its edge, the tint outside it. */
function glyph(view: View): ReactNode {
  const body = 'M8 2.5c2.6 0 4.5 2.3 4.5 5.5S10.6 13.5 8 13.5 3.5 11.2 3.5 8 5.4 2.5 8 2.5z';
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden>
      {view === 'alpha' ? (
        <>
          <rect x={1} y={1} width={14} height={14} rx={1.5} fill="currentColor" opacity={0.25} />
          <path d={body} fill="currentColor" />
        </>
      ) : view === 'boundary' ? (
        <>
          <rect x={1} y={1} width={14} height={14} rx={1.5} fill="none" stroke="currentColor" strokeOpacity={0.35} />
          <path d={body} fill="none" stroke="currentColor" strokeWidth={1.5} />
        </>
      ) : (
        <>
          <rect x={1} y={1} width={14} height={14} rx={1.5} fill="currentColor" opacity={0.55} />
          <path d={body} fill="var(--color-surface-0)" />
        </>
      )}
    </svg>
  );
}

function views(): ReadonlyArray<{ id: View; label: string; key: string }> {
  return [
    { id: 'alpha', label: t('layerViewer.alpha.alpha', 'Alpha'), key: '4' },
    { id: 'boundary', label: t('layerViewer.alpha.boundary', 'Alpha Boundary'), key: '5' },
    { id: 'overlay', label: t('layerViewer.alpha.overlay', 'Alpha Overlay'), key: '6' },
  ];
}

const DIGIT_VIEW: Readonly<Record<string, View>> = { Digit4: 'alpha', Digit5: 'boundary', Digit6: 'overlay', Numpad4: 'alpha', Numpad5: 'boundary', Numpad6: 'overlay' };

function typingInto(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function MatteViewControls({ nodeId, locked }: { nodeId: string; locked: boolean }): JSX.Element {
  const alphaView = useLayerViewerStore((s) => s.alphaView);
  const toggle = useLayerViewerStore((s) => s.toggleAlphaView);
  const overlayColor = useLayerViewerStore((s) => s.overlayColor);
  const overlayOpacity = useLayerViewerStore((s) => s.overlayOpacity);
  const setOverlay = useLayerViewerStore((s) => s.setOverlay);

  // Alt+4 / 5 / 6, as in After Effects: while the Layer panel is on show.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || typingInto(e.target)) return;
      const view = DIGIT_VIEW[e.code];
      if (!view) return;
      e.preventDefault();
      e.stopPropagation();
      useLayerViewerStore.getState().toggleAlphaView(view);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const mattes = rotoMattes(nodeId);
  const frozen = mattes.frozen.length > 0 || mattes.subjectFrozen.length > 0;
  const canFreeze = !locked && (frozen || mattes.live.length > 0 || mattes.subject.length > 0);

  return (
    <span className={styles.matteViews} role="group" aria-label={t('layerViewer.matteViews.group', 'Matte views')}>
      {views().map((v) => (
        <button
          key={v.id}
          type="button"
          className={cn(styles.viewToggle, alphaView === v.id && styles.viewToggleOn)}
          aria-pressed={alphaView === v.id}
          aria-label={v.label}
          title={t('layerViewer.matteViews.toggleTitle', '{view} (Alt+{key})', { view: v.label, key: v.key })}
          onClick={() => toggle(v.id)}
        >
          {glyph(v.id)}
        </button>
      ))}
      <span className={styles.overlaySwatch} title={t('layerViewer.matteViews.overlayColor', 'Alpha Overlay colour')}>
        <ColorPicker value={overlayColor} onChange={(hex) => setOverlay({ color: hex.slice(0, 7) })} alpha={false} compact aria-label={t('layerViewer.matteViews.overlayColor', 'Alpha Overlay colour')} />
      </span>
      <span className={styles.overlayOpacity} title={t('layerViewer.matteViews.overlayOpacity', 'Alpha Overlay opacity')}>
        <ValueField value={overlayOpacity} onChange={(v) => setOverlay({ opacity: Number(v) })} min={0} max={100} step={1} precision={0} unit="%" aria-label={t('layerViewer.matteViews.overlayOpacity', 'Alpha Overlay opacity')} />
      </span>
      <button
        type="button"
        className={cn(styles.viewToggle, styles.freeze, frozen && styles.viewToggleOn)}
        disabled={!canFreeze}
        aria-pressed={frozen}
        title={frozen
          ? t('topNav.roto.frozenTitle', 'The matte is frozen: strokes and Propagate cannot change it. Click to unfreeze.')
          : t('topNav.roto.freezeTitle', 'Freeze the matte so a new stroke or Propagate cannot replace it')}
        onClick={() => {
          const e = rotoFreezeEdit(nodeId, !frozen);
          if (e.commands.length) void edit(e.label, e.commands);
        }}
      >
        <Icon name={frozen ? 'lock' : 'unlock'} size="sm" />
        {frozen ? t('topNav.roto.frozen', 'Frozen') : t('topNav.roto.freeze', 'Freeze')}
      </button>
    </span>
  );
}
