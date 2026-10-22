import { useState } from 'react';
import { t } from '@core/i18n';
import { useSelectionStore } from '@stores/selectionStore';
import { useActiveCompSize } from './inspectorMirror';
import { distributeMinimum, type AlignMode } from '@core/scene/alignNodes';
import { alignLayers } from './inspectorEdits';
import { Icon, type IconName } from '@components/Icon';
import { IconButton } from '@components/IconButton';
import styles from './AlignSection.module.css';

type AlignTo = 'selection' | 'composition';

function alignActions(): { id: AlignMode; icon: IconName; label: string }[] {
  return [
  { id: 'left',      icon: 'align-left',   label: t('inspector.align.alignLeft', 'Align Left') },
  { id: 'center-h',  icon: 'align-center', label: t('inspector.align.alignHCenters', 'Align Horizontal Centers') },
  { id: 'right',     icon: 'align-right',  label: t('inspector.align.alignRight', 'Align Right') },
  { id: 'top',       icon: 'align-top',    label: t('inspector.align.alignTop', 'Align Top') },
  { id: 'middle-v',  icon: 'align-middle', label: t('inspector.align.alignVCenters', 'Align Vertical Centers') },
  { id: 'bottom',    icon: 'align-bottom', label: t('inspector.align.alignBottom', 'Align Bottom') },
  ];
}

/**
 * AE's Distribute row: the six edge / centre buttons in AE's order, then the
 * two Distribute Spacing buttons. The edge buttons reuse the align glyph of the
 * edge they space (there is no separate distribute-by-edge glyph in the set);
 * the tooltips carry the distinction.
 */
function distributeActions(): { id: AlignMode; icon: IconName; label: string }[] {
  return [
  { id: 'distribute-top',     icon: 'align-top',             label: t('inspector.align.distTop', 'Distribute Top Edges') },
  { id: 'distribute-v',       icon: 'align-middle',          label: t('inspector.align.distVCenters', 'Distribute Vertical Centers') },
  { id: 'distribute-bottom',  icon: 'align-bottom',          label: t('inspector.align.distBottom', 'Distribute Bottom Edges') },
  { id: 'distribute-left',    icon: 'align-left',            label: t('inspector.align.distLeft', 'Distribute Left Edges') },
  { id: 'distribute-h',       icon: 'align-center',          label: t('inspector.align.distHCenters', 'Distribute Horizontal Centers') },
  { id: 'distribute-right',   icon: 'align-right',           label: t('inspector.align.distRight', 'Distribute Right Edges') },
  { id: 'distribute-space-h', icon: 'distribute-horizontal', label: t('inspector.align.distHSpacing', 'Distribute Horizontal Spacing') },
  { id: 'distribute-space-v', icon: 'distribute-vertical',   label: t('inspector.align.distVSpacing', 'Distribute Vertical Spacing') },
  ];
}

/** What each "Align Layers to" choice does — the select's tooltip, not a paragraph in the panel. */
function alignToHint(to: AlignTo): string {
  return to === 'selection'
    ? t('inspector.align.hintSelection', 'Selection: align the layers to each other. Distribute needs three or more; the outermost two stay put.')
    : t('inspector.align.hintComposition', 'Composition: align each layer to the composition frame. Distribute spreads them edge to edge across it.');
}

/**
 * Align — After Effects' Align panel: "Align Layers to" (a labelled select),
 * then the Align Layers, Distribute Layers and Distribute Spacing rows, each
 * under its label-role caption.
 *
 * The buttons are ghost icon buttons in a grid, not bordered boxes: a panel
 * whose every control is outlined reads as a form, and this is a toolbar.
 * Disabled buttons stay in place (dimmed) so the grid never reflows as the
 * selection changes; each one's tooltip names it.
 */
export function AlignPanel(): JSX.Element {
  const selectedIds = useSelectionStore((s) => s.ids);
  const [alignTo, setAlignTo] = useState<AlignTo>('selection');

  const { width: compWidth, height: compHeight } = useActiveCompSize();

  const alignMin = alignTo === 'composition' ? 1 : 2;
  // B3-legacy: not a write — the ratchet's `distribute…` verb match on a pure count (rule false positive; belongs in NOT_WRITES).
  const distributeMin = distributeMinimum(alignTo);
  const count = selectedIds.length;

  const run = (mode: AlignMode): void => { void alignLayers(selectedIds, mode, alignTo, compWidth, compHeight); };

  const renderButton = (a: { id: AlignMode; icon: IconName; label: string }, min: number): JSX.Element => {
    const disabled = count < min;
    return (
      <IconButton
        key={a.id}
        size="md"
        variant="ghost"
        aria-label={a.label}
        tooltip={disabled ? t('inspector.align.needMin', '{label} — select {min} or more layers', { label: a.label, min }) : a.label}
        disabled={disabled}
        onClick={() => run(a.id)}
      >
        <Icon name={a.icon} size="md" />
      </IconButton>
    );
  };

  const buttonRow = (caption: string, actions: ReturnType<typeof alignActions>, min: number): JSX.Element => (
    <div className={styles.group} role="group" aria-label={caption}>
      <span className={styles.caption}>{caption}</span>
      <div className={styles.grid}>
        {actions.map((a) => renderButton(a, min))}
      </div>
    </div>
  );

  return (
    <div className={styles.panelRoot}>
      <label className={styles.targetRow}>
        <span className={styles.caption}>{t('inspector.align.alignTo', 'Align Layers to')}</span>
        <select
          className={styles.select}
          aria-label={t('inspector.align.alignTo', 'Align Layers to')}
          title={alignToHint(alignTo)}
          value={alignTo}
          onChange={(e) => setAlignTo(e.currentTarget.value as AlignTo)}
        >
          <option value="selection">{t('inspector.align.selection', 'Selection')}</option>
          <option value="composition">{t('inspector.align.composition', 'Composition')}</option>
        </select>
      </label>

      {buttonRow(t('inspector.align.alignLayers', 'Align Layers'), alignActions(), alignMin)}
      {buttonRow(t('inspector.align.distributeLayers', 'Distribute Layers'), distributeActions().slice(0, 6), distributeMin)}
      {buttonRow(t('inspector.align.distributeSpacing', 'Distribute Spacing'), distributeActions().slice(6), distributeMin)}

      {count === 0 && <p className={styles.help}>{t('inspector.align.empty', 'Select layers to align them.')}</p>}
    </div>
  );
}
