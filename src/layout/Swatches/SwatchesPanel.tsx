/**
 * SwatchesPanel — the project palette at full size.
 *
 * The ColorPicker popover carries the same two lists, and deliberately so: one
 * is for reaching a colour while you are already editing one, this one is for
 * MANAGING the palette (naming, ordering, pruning) and for pushing a colour
 * onto a selection without opening a picker at all. Both read the same store,
 * so a rename here is visible in every picker in the app on the next render —
 * there is one palette, shown twice, not two palettes to keep in sync.
 *
 * Reordering is up/down buttons rather than drag-and-drop. A palette is
 * reordered rarely and by a few positions; buttons are keyboard-reachable,
 * need no pointer precision, and cost none of the drag machinery a swatch grid
 * would otherwise pull in.
 */

import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@components/Icon';
import { ColorPicker } from '@components/ColorPicker';
import { EmptyState } from '@components/EmptyState';
import { useSwatchStore } from '@stores/swatchStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useMirrorRevision, useRetainTrees } from '@hooks/useMirror';
import { solidFill } from '@core/paint/fill';
import { edit } from '@core/engine/uiEdits';
import { fieldCommands } from '@layout/Text/textEdits';
import styles from './SwatchesPanel.module.css';
import { t } from '@core/i18n';

/**
 * Paint every selected layer with `hex`.
 *
 * Routed through `layer/fillPaint` — the same write the Appearance section's fill
 * ColorPicker uses — rather than touching the graph directly, because that
 * function is what keeps the fill STACK and the legacy single-fill slot
 * agreeing with each other. Writing `fx.props.fill` here would paint the layer
 * and leave a multi-fill layer's stack showing the old colour.
 *
 * One engine batch so painting eight layers is one undo, not eight.
 *
 * A gradient-filled layer becomes solid. There is no unambiguous "set the
 * colour of a gradient" — which stop? — so the honest reading of "apply this
 * swatch" is the one the user can see happen and undo.
 */
function applyToSelection(ids: readonly string[], hex: string): void {
  // ONE engine batch (G1): each layer's primary fill paint, `layer/fillPaint` —
  // the engine keeps the fill stack and its single-fill slot agreeing.
  void edit(`Apply Swatch`, ids.flatMap((id) => fieldCommands(id, 'layer/fillPaint', solidFill(hex))));
}

export function SwatchesPanel(): JSX.Element {
  const swatches = useSwatchStore((s) => s.swatches);
  const documentColors = useSwatchStore((s) => s.documentColors);
  const addSwatch = useSwatchStore((s) => s.addSwatch);
  const renameSwatch = useSwatchStore((s) => s.renameSwatch);
  const removeSwatch = useSwatchStore((s) => s.removeSwatch);
  const moveSwatch = useSwatchStore((s) => s.moveSwatch);
  const refreshDocumentColors = useSwatchStore((s) => s.refreshDocumentColors);

  const selectedIds = useSelectionStore((s) => s.ids);
  // B4: the document mirror's revision — it moves on every edit (a paint edit,
  // an add, a delete) and never on playback.
  const sceneRevision = useMirrorRevision();

  const [draft, setDraft] = useState('#5282b8');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  /**
   * Document colours are derived, so something has to decide WHEN. The scene
   * revision is that trigger: it bumps on a paint edit, an add or a delete —
   * exactly the events that can change the answer — and not on playback, which
   * is what a per-frame derivation would have cost.
   */
  useEffect(() => {
    refreshDocumentColors();
  }, [refreshDocumentColors, sceneRevision]);

  const commitRename = useCallback(() => {
    if (editingId) renameSwatch(editingId, draftName);
    setEditingId(null);
  }, [editingId, draftName, renameSwatch]);

  // Apply resolves each layer's fill property on the mirror's tree: keep the
  // selection's trees loaded, or the click would find nothing to write.
  useRetainTrees(selectedIds);
  const canApply = selectedIds.length > 0;

  return (
    <div className={styles.panelRoot}>
      <div className={styles.addRow}>
        <ColorPicker value={draft} onChange={setDraft} aria-label={t('swatches.panel.newColor', 'New swatch color')} />
        <button
          type="button"
          className={styles.addBtn}
          onClick={() => {
            const added = addSwatch(draft);
            if (added) {
              setEditingId(added.id);
              setDraftName(added.name);
            }
          }}
          title={t('swatches.panel.addTitle', 'Add this color to the project palette')}
        >
          <Icon name="plus" size="sm" />
          <span>{t('swatches.panel.add', 'Add')}</span>
        </button>
      </div>

      <div className={styles.sectionLabel}>{t('swatches.panel.projectSwatches', 'Project Swatches')}</div>

      {swatches.length === 0 ? (
        <EmptyState
          compact
          icon="palette"
          title={t('swatches.panel.emptyTitle', 'No swatches yet')}
          message={t('swatches.panel.emptyMessage', 'Pick a colour above and add it, or promote one of the document colours below.')}
          action={{
            label: t('swatches.panel.addPicked', 'Add the picked colour'),
            onClick: () => {
              const added = addSwatch(draft);
              if (added) {
                setEditingId(added.id);
                setDraftName(added.name);
              }
            },
          }}
        />
      ) : (
        <ul className={styles.list}>
          {swatches.map((sw, i) => (
            <li key={sw.id} className={styles.row}>
              <button
                type="button"
                className={styles.rowSwatch}
                style={{ background: sw.hex }}
                title={t('swatches.panel.applyTitle', 'Apply {name} to the selected layers', { name: sw.name })}
                aria-label={t('swatches.panel.applyAria', 'Apply {name} to selection', { name: sw.name })}
                disabled={!canApply}
                onClick={() => applyToSelection(selectedIds, sw.hex)}
              />
              {editingId === sw.id ? (
                <input
                  className={styles.rowInput}
                  value={draftName}
                  autoFocus
                  aria-label={t('swatches.panel.swatchName', 'Swatch name')}
                  onChange={(e) => setDraftName(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className={styles.rowName}
                  title={t('swatches.panel.rename', 'Rename')}
                  onClick={() => {
                    setEditingId(sw.id);
                    setDraftName(sw.name);
                  }}
                >
                  <span className={styles.rowNameText}>{sw.name}</span>
                  <span className={styles.rowHex}>{sw.hex.toUpperCase()}</span>
                </button>
              )}
              <div className={styles.rowActions}>
                <button
                  type="button"
                  className={styles.iconBtn}
                  title={t('swatches.panel.moveUp', 'Move up')}
                  aria-label={t('swatches.panel.moveUpAria', 'Move {name} up', { name: sw.name })}
                  disabled={i === 0}
                  onClick={() => moveSwatch(sw.id, i - 1)}
                >
                  <Icon name="chevron-up" size="sm" />
                </button>
                <button
                  type="button"
                  className={styles.iconBtn}
                  title={t('swatches.panel.moveDown', 'Move down')}
                  aria-label={t('swatches.panel.moveDownAria', 'Move {name} down', { name: sw.name })}
                  disabled={i === swatches.length - 1}
                  onClick={() => moveSwatch(sw.id, i + 1)}
                >
                  <Icon name="chevron-down" size="sm" />
                </button>
                <button
                  type="button"
                  className={styles.iconBtn}
                  title={t('swatches.panel.delete', 'Delete swatch')}
                  aria-label={t('swatches.panel.deleteAria', 'Delete {name}', { name: sw.name })}
                  onClick={() => {
                    removeSwatch(sw.id);
                    if (editingId === sw.id) setEditingId(null);
                  }}
                >
                  <Icon name="trash" size="sm" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {swatches.length > 0 && (
        <p className={styles.hint}>
          {canApply
            ? selectedIds.length === 1
              ? t('swatches.panel.hintOne', 'Click a swatch to fill {n} selected layer.', { n: selectedIds.length })
              : t('swatches.panel.hintOther', 'Click a swatch to fill {n} selected layers.', { n: selectedIds.length })
            : t('swatches.panel.hintNone', 'Select layers to apply a swatch as their fill.')}
        </p>
      )}

      <div className={styles.sectionLabel}>{t('swatches.panel.documentColors', 'Document Colors')}</div>
      {documentColors.length === 0 ? (
        <EmptyState
          compact
          icon="brush"
          message={t('swatches.panel.documentEmpty', 'Nothing in this composition is painted yet.')}
        />
      ) : (
        <div className={styles.grid} role="listbox" aria-label={t('swatches.panel.documentColorsAria', 'Document colors')}>
          {documentColors.map((hex) => (
            <button
              key={hex}
              type="button"
              className={styles.gridSwatch}
              style={{ background: hex }}
              title={t('swatches.panel.docColorTitle', '{hex} — click to add to the project palette', { hex: hex.toUpperCase() })}
              aria-label={t('swatches.panel.docColorAria', 'Add {hex} to project swatches', { hex })}
              onClick={() => addSwatch(hex)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default SwatchesPanel;
