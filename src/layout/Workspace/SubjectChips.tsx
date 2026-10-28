/**
 * Subject chips — the subjects Object Matte has cut out in this composition,
 * as a row above the viewer while a roto tool is up (AE 26's Object Matte
 * keeps its selections as named entries; here they are layers whose matte
 * runs through the shot).
 *
 * A chip selects its layer; its menu does the next thing a subject is for:
 * put the selected layers behind it, make a null that follows it, or outline
 * / colour it (Matte Stroke / Selective Color (AI), which read the layer's own
 * matte when their matte layer is None).
 */

import { useEffect, useState } from 'react';
import { useUIStore } from '@stores/uiStore';
import { useSelectionStore } from '@stores/selectionStore';
import { documentMirror } from '@stores/documentMirror';
import { openContextMenu } from '@stores/contextMenuStore';
import { useActiveCompRootId, useMirrorRevisionFrame } from '@hooks/useMirrorFrame';
import { mirrorMaskHeaders } from '@core/mirror/effects';
import { Icon } from '@components/Icon';
import { t } from '@core/i18n';
import { subjectMenuItems } from './subjectActions';
import { openTextBehind } from './TextBehindDialog';
import { matteOutlineKeys } from './subjectTrack';
import styles from './SubjectChips.module.css';

interface Subject {
  layer: string;
  name: string;
  /** The matte runs through the shot (keyed outline), not one frame. */
  tracked: boolean;
}

const MATTE_NAMES = new Set(['Object Matte', 'Roto Brush', 'Roto Brush (Frozen)']);

/** Footage layers of `comp` with a subject matte, front first. */
async function subjectsOf(comp: string): Promise<Subject[]> {
  const m = documentMirror();
  const layers = (m.comp(comp)?.layers ?? []).filter((id) => {
    const src = m.layer(id)?.source;
    const type = src ? m.item(src)?.mediaType : undefined;
    return type === 'video' || type === 'image';
  });
  await m.loadTrees(layers);
  const out: Subject[] = [];
  for (const id of layers) {
    if (!mirrorMaskHeaders(m.tree(id)).some((x) => MATTE_NAMES.has(x.name))) continue;
    out.push({ layer: id, name: m.layer(id)?.name ?? id, tracked: (await matteOutlineKeys(id)) !== null });
  }
  return out;
}

export function SubjectChips(): JSX.Element | null {
  const on = useUIStore((s) => s.activeTool === 'object-matte' || s.activeTool === 'roto');
  return on ? <SubjectChipsActive /> : null;
}

function SubjectChipsActive(): JSX.Element | null {
  const tool = useUIStore((s) => s.activeTool);
  const comp = useActiveCompRootId();
  const rev = useMirrorRevisionFrame();
  const selected = useSelectionStore((s) => s.ids);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const on = tool === 'object-matte' || tool === 'roto';

  useEffect(() => {
    if (!on) return;
    let live = true;
    void subjectsOf(comp).then((s) => { if (live) setSubjects(s); });
    return () => { live = false; };
  }, [on, comp, rev]);

  if (!on || subjects.length === 0) return null;

  const menu = (s: Subject, x: number, y: number): void => {
    // The same actions as Properties ▸ Subject and right-click ▸ Subject.
    openContextMenu(x, y, subjectMenuItems(s.layer, { openTextBehind }));
  };

  return (
    <div className={styles.row} role="toolbar" aria-label={t('workspace.subjects.aria', 'Subjects')}>
      {subjects.map((s, i) => {
        const label = t('workspace.subjects.chip', 'Subject {n}', { n: i + 1 });
        const active = selected.includes(s.layer);
        return (
          <span key={s.layer} className={active ? styles.chipActive : styles.chip}>
            <button
              type="button"
              className={styles.pick}
              title={s.tracked
                ? t('workspace.subjects.titleTracked', '{name}: matte through the shot', { name: s.name })
                : t('workspace.subjects.titleFrame', '{name}: matte on one frame (Propagate to follow it)', { name: s.name })}
              aria-pressed={active}
              onClick={() => useSelectionStore.getState().set([s.layer])}
            >
              <Icon name="object-matte" size="sm" />
              {label}
            </button>
            <button
              type="button"
              className={styles.more}
              aria-label={t('workspace.subjects.menu', '{label} actions', { label })}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                menu(s, r.left, r.bottom + 2);
              }}
            >
              <Icon name="chevron-down" size="sm" />
            </button>
          </span>
        );
      })}
    </div>
  );
}
