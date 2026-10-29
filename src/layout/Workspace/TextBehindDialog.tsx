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
import type { PropertyInit } from '@motion/engine-api';
import { values } from '@core/engine/propRefs';
import { edit } from '@core/engine/uiEdits';
import { mirrorMaskHeaders } from '@core/mirror/effects';
import { playheadSeconds } from '@core/timeline/timelineView';
import { ROTO_PATH_NAME } from '@core/workspace/rotoBrushTool';
import { documentMirror } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useTextBehindStore } from '@stores/textBehindStore';
import { applyAnimationPresetEdit } from '@layout/Menu/appEdits';
import { t } from '@core/i18n';
import { runPlaceBehindSubject } from './placeBehindSubjectCommand';
import { subjectBoundsInComp } from './placeBehindSubject';
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

/** Soft Edge: the subject's edge feathered by this many px where it covers the title. */
const SOFT_EDGE_PX = 4;

const MATTE_NAMES = new Set(['Object Matte', ROTO_PATH_NAME, 'Roto Brush (Frozen)']);

export function TextBehindDialog(): JSX.Element | null {
  const layer = useTextBehindStore((s) => s.layer);
  const close = useTextBehindStore((s) => s.close);
  const selection = useSelectionStore((s) => s.ids);
  const [subject, setSubject] = useState<string>('');
  const [entrance, setEntrance] = useState<string>('Rise Up');
  // A subject selected on one frame does not move with the footage: follow it first (AE: propagate, then stack).
  const [followFirst, setFollowFirst] = useState(true);
  // The subject's edge feathered where it covers the title (layer/behindSubjectSoftness).
  const [softEdge, setSoftEdge] = useState(true);
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
        // A new title, created above the footage, then moved behind the person: big and bold
        // across the subject at chest height, so the person visibly stands in front of it.
        const text = t('workspace.textBehind.newText', 'YOUR TITLE');
        const box = await subjectBoundsInComp(subject, playheadSeconds());
        const compW = useCompositionStore.getState().comp().width || 1920;
        const init: PropertyInit[] = [
          { path: 'text/sourceText', value: values.string(text) },
          { path: 'text/fontFamily', value: values.string('Anton') },
        ];
        if (box) {
          // Cap height about a quarter of the person: a headline they stand in front of. Anton is
          // ~0.45 em a glyph, so the line is kept inside 90 % of the frame.
          const byHeight = (box.y1 - box.y0) * 0.28;
          const byWidth = (compW * 0.9) / (0.45 * Math.max(4, text.length));
          const fontSize = Math.round(Math.max(48, Math.min(byHeight, byWidth)));
          init.push({ path: 'text/fontSize', value: values.scalar(fontSize) });
          // Centred on the person, slid back inside the footage's frame when that would run off it.
          const half = (0.45 * fontSize * text.length) / 2;
          const lo = box.frame.x0 + half;
          const hi = box.frame.x1 - half;
          const cx = lo <= hi ? Math.min(hi, Math.max(lo, (box.x0 + box.x1) / 2)) : (box.frame.x0 + box.frame.x1) / 2;
          init.push({ path: 'transform/position', value: { kind: 'vec2', value: { x: cx, y: box.y0 + (box.y1 - box.y0) * 0.38 } } });
        }
        const res = await engine().execute({
          type: 'createLayer', comp, kind: 'text', name: t('workspace.textBehind.newName', 'Your Title'), init,
        });
        if (!res.ok) {
          useUIStore.getState().notify({ level: 'warning', message: res.error.message, durationMs: 4000 });
          return;
        }
        behind = [(res.value as { layer: string }).layer];
      }
      const out = await runPlaceBehindSubject([subject, ...behind]);
      if (!out.ok) return;
      if (softEdge) {
        await edit(t('workspace.textBehind.softEdge', 'Soft Edge'), behind.map((id) => ({
          type: 'setProperty' as const, prop: { layer: id, path: 'layer/behindSubjectSoftness' }, value: values.scalar(SOFT_EDGE_PX),
        })));
      }
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
      <label className={styles.check}>
        <input type="checkbox" checked={softEdge} onChange={(e) => setSoftEdge(e.target.checked)} />
        {t('workspace.textBehind.softEdgeLabel', 'Soft edge where they overlap')}
      </label>
    </Modal>
  );
}
