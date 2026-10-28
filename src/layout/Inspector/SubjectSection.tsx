/**
 * Properties ▸ Subject — where a footage layer's subject and its next moves
 * live (the approved Subject workflow mockup, screen 3). Before a selection it
 * says how to make one; after, it shows the subject and the actions as
 * buttons: the same list as right-click ▸ Subject and the subject chip
 * (Workspace/subjectActions.ts).
 */

import { useEffect, useState } from 'react';
import { useMirrorRevisionFrame } from '@hooks/useMirrorFrame';
import { documentMirror } from '@stores/documentMirror';
import { useUIStore } from '@stores/uiStore';
import { useSelectionStore } from '@stores/selectionStore';
import { t } from '@core/i18n';
import { COLOR_LOOKS, OUTLINE_PRESETS, colorSubject, outlineSubject, subjectActions, subjectStateOf, type SubjectState } from '@layout/Workspace/subjectActions';
import { matteOutlineKeys } from '@layout/Workspace/subjectTrack';
import { openTextBehind } from '@layout/Workspace/TextBehindDialog';
import styles from './SubjectSection.module.css';

const EMPTY: SubjectState = { selected: false, followed: false, frozen: false, cuts: false };

/** Footage layers only: a matte is cut from source pixels. */
export function isSubjectCandidate(nodeId: string): boolean {
  const m = documentMirror();
  const src = m.layer(nodeId)?.source;
  const type = src ? m.item(src)?.mediaType : undefined;
  return type === 'video' || type === 'image';
}

export function SubjectSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  const rev = useMirrorRevisionFrame();
  const [state, setState] = useState<SubjectState>(EMPTY);
  const [span, setSpan] = useState<number>(0);

  useEffect(() => {
    let live = true;
    void subjectStateOf(nodeId).then(async (s) => {
      const keys = await matteOutlineKeys(nodeId);
      if (!live) return;
      setState(s);
      setSpan(keys?.keys.length ?? 0);
    });
    return () => { live = false; };
  }, [nodeId, rev]);

  if (!isSubjectCandidate(nodeId)) return null;

  const actions = subjectActions(nodeId, state, { openTextBehind });
  const select = actions.find((a) => a.id === 'select')!;

  if (!state.selected) {
    return (
      <div className={styles.empty}>
        <p className={styles.help}>
          {t('inspector.subject.emptyHelp', 'Select a person or object with the Object Matte tool: hover it, then click. Its next moves appear here.')}
        </p>
        <button type="button" className={styles.primary} onClick={select.run}>{select.label}</button>
      </div>
    );
  }

  const name = documentMirror().layer(nodeId)?.name ?? nodeId;
  const grid = actions.filter((a) => a.id !== 'select' && a.id !== 'follow');
  const follow = actions.find((a) => a.id === 'follow')!;
  return (
    <div className={styles.root}>
      <div className={styles.card}>
        <div className={styles.cardText}>
          <span className={styles.cardTitle}>{t('inspector.subject.person', 'Subject · {name}', { name })}</span>
          <span className={styles.cardMeta}>{state.followed
            ? t('inspector.subject.followed', 'Followed over {n} frames', { n: span })
            : t('inspector.subject.oneFrame', 'Selected on one frame')}{state.frozen ? ` · ${t('inspector.subject.frozen', 'Frozen')}` : ''}</span>
        </div>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => {
            useSelectionStore.getState().set([nodeId]);
            useUIStore.getState().setActiveTool('object-matte');
          }}
        >
          {t('inspector.subject.edit', 'Edit')}
        </button>
      </div>
      {!state.followed && (
        <button type="button" className={styles.follow} disabled={follow.disabled} onClick={follow.run}>
          <span className={styles.actionTitle}>{follow.label}</span>
          <span className={styles.actionDesc}>{follow.description}</span>
        </button>
      )}
      <div className={styles.grid}>
        {grid.map((a, i) => (
          <button
            key={a.id}
            type="button"
            className={i === 0 ? styles.actionPrimary : styles.action}
            disabled={a.disabled}
            title={a.description}
            onClick={a.run}
          >
            <span className={styles.actionTitle}>{a.label}</span>
            <span className={styles.actionDesc}>{a.description}</span>
          </button>
        ))}
      </div>
      <div className={styles.looks} role="group" aria-label={t('inspector.subject.outlineLooks', 'Outline looks')}>
        <span className={styles.looksLabel}>{t('inspector.subject.outlineLooks', 'Outline looks')}</span>
        {(Object.keys(OUTLINE_PRESETS) as Array<keyof typeof OUTLINE_PRESETS>).map((k) => (
          <button key={k} type="button" className={styles.chip} onClick={() => { void outlineSubject(nodeId, k); }}>{OUTLINE_PRESETS[k].label()}</button>
        ))}
      </div>
      <div className={styles.looks} role="group" aria-label={t('inspector.subject.colorLooks', 'Color looks')}>
        <span className={styles.looksLabel}>{t('inspector.subject.colorLooks', 'Color looks')}</span>
        {(Object.keys(COLOR_LOOKS) as Array<keyof typeof COLOR_LOOKS>).map((k) => (
          <button key={k} type="button" className={styles.chip} onClick={() => { void colorSubject(nodeId, k); }}>{COLOR_LOOKS[k].label()}</button>
        ))}
      </div>
      <p className={styles.help}>{t('inspector.subject.footnote', 'Each action is one undo step and adds ordinary layers and effects you can edit later.')}</p>
    </div>
  );
}
