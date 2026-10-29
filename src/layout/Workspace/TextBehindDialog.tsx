/**
 * Text Behind Subject — the popover the Subject actions open (approved mockup,
 * screen 4): which text, which subject, an entrance, a soft edge. Place Behind
 * builds the sandwich (placeBehindSubject.ts) — the cut-out copy on top, the
 * text, the full picture — as one entry; no text selected adds "Your Title"
 * first, already behind the person.
 *
 * Opened through `openTextBehind(layer)`; mounted once by the workspace.
 */

import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@components/Modal';
import { Button } from '@components/Button';
import { engine } from '@core/engine/engineInstance';
import { values } from '@core/engine/propRefs';
import { mirrorMaskHeaders } from '@core/mirror/effects';
import { playheadSeconds } from '@core/timeline/timelineView';
import { ROTO_PATH_NAME } from '@core/workspace/rotoBrushTool';
import { documentMirror } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { useTextBehindStore } from '@stores/textBehindStore';
import { applyAnimationPresetEdit } from '@layout/Menu/appEdits';
import { t } from '@core/i18n';
import { runPlaceBehindSubject } from './placeBehindSubjectCommand';
import { followSubject, subjectStateNow } from './subjectActions';
import styles from './TextBehindDialog.module.css';

export function openTextBehind(layer: string): void {
  useTextBehindStore.getState().open(layer);
}

const ENTRANCES = [
  { id: 'none', label: () => t('workspace.textBehind.animate.none', 'None') },
  { id: 'Rise Up', label: () => t('workspace.textBehind.animate.rise', 'Rise from behind') },
  { id: 'Fade In', label: () => t('workspace.textBehind.animate.fade', 'Fade in') },
  { id: 'Word Rise', label: () => t('workspace.textBehind.animate.words', 'Words rise') },
] as const;

const MATTE_NAMES = new Set(['Object Matte', ROTO_PATH_NAME, 'Roto Brush (Frozen)']);

export function TextBehindDialog(): JSX.Element | null {
  const layer = useTextBehindStore((s) => s.layer);
  const close = useTextBehindStore((s) => s.close);
  const selection = useSelectionStore((s) => s.ids);
  const [subject, setSubject] = useState<string>('');
  const [entrance, setEntrance] = useState<string>('Rise Up');
  // A subject selected on one frame does not move with the footage: follow it first (AE: propagate, then stack).
  const [followFirst, setFollowFirst] = useState(true);
  const [busy, setBusy] = useState(false);

  const m = documentMirror();
  const comp = layer ? m.layer(layer)?.comp : undefined;
  // The selected text layers of the subject's composition: what goes behind.
  const texts = useMemo(() => selection.filter((id) => m.layer(id)?.kind === 'text' && m.layer(id)?.comp === comp), [selection, comp, m]);
  // Footage layers of the composition with a subject selection.
  // Read while the popover is open: cheap, and it must see a matte made since.
  const subjects = (comp ? (m.comp(comp)?.layers ?? []) : []).filter((id) => {
    const tree = m.tree(id);
    return !!tree && mirrorMaskHeaders(tree).some((x) => MATTE_NAMES.has(x.name));
  });

  useEffect(() => {
    if (layer) setSubject(layer);
  }, [layer]);

  if (!layer) return null;
  const followed = subject ? subjectStateNow(subject).followed : false;

  const place = async (): Promise<void> => {
    if (!subject || !comp) return;
    setBusy(true);
    try {
      if (followFirst && !followed) await followSubject(subject);
      let behind = texts;
      if (behind.length === 0) {
        // A new title, created above the footage, then moved behind the person.
        const res = await engine().execute({
          type: 'createLayer', comp, kind: 'text', name: t('workspace.textBehind.newName', 'Your Title'),
          init: [{ path: 'text/sourceText', value: values.string(t('workspace.textBehind.newText', 'YOUR TITLE')) }],
        });
        if (!res.ok) {
          useUIStore.getState().notify({ level: 'warning', message: res.error.message, durationMs: 4000 });
          return;
        }
        behind = [(res.value as { layer: string }).layer];
      }
      const out = await runPlaceBehindSubject([subject, ...behind]);
      if (!out.ok) return;
      if (entrance !== 'none') await applyAnimationPresetEdit(behind, entrance, playheadSeconds());
      useSelectionStore.getState().set(behind);
      close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={close}
      id="text-behind-subject"
      title={t('workspace.textBehind.title', 'Text Behind Subject')}
      variant="floating"
      size="sm"
      primaryAction={() => { void place(); }}
      footer={(
        <div className={styles.footer}>
          <Button variant="secondary" size="sm" onClick={close}>{t('workspace.textBehind.cancel', 'Cancel')}</Button>
          <Button variant="primary" size="sm" loading={busy} disabled={!subject} onClick={() => { void place(); }}>{t('workspace.textBehind.place', 'Place Behind')}</Button>
        </div>
      )}
    >
      <div className={styles.grid}>
        <span className={styles.label}>{t('workspace.textBehind.layers', 'Layers')}</span>
        <span className={styles.value}>{texts.length > 0
          ? texts.map((id) => m.layer(id)?.name ?? id).join(', ')
          : t('workspace.textBehind.newLayer', 'A new title (no text is selected)')}</span>

        <label className={styles.label} htmlFor="tb-subject">{t('workspace.textBehind.subject', 'Subject')}</label>
        <select id="tb-subject" className={styles.select} value={subject} onChange={(e) => setSubject(e.target.value)}>
          {(subjects.length > 0 ? subjects : [layer]).map((id) => <option key={id} value={id}>{m.layer(id)?.name ?? id}</option>)}
        </select>

        <label className={styles.label} htmlFor="tb-animate">{t('workspace.textBehind.animate', 'Animate')}</label>
        <select id="tb-animate" className={styles.select} value={entrance} onChange={(e) => setEntrance(e.target.value)}>
          {ENTRANCES.map((x) => <option key={x.id} value={x.id}>{x.label()}</option>)}
        </select>
      </div>
      {!followed && (
        <label className={styles.check}>
          <input type="checkbox" checked={followFirst} onChange={(e) => setFollowFirst(e.target.checked)} />
          {t('workspace.textBehind.followFirst', 'Follow the subject through the shot first (it is selected on one frame)')}
        </label>
      )}
    </Modal>
  );
}
