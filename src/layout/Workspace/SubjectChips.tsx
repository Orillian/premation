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
import { openContextMenu, type ContextMenuItem } from '@stores/contextMenuStore';
import { useActiveCompRootId, useMirrorRevisionFrame } from '@hooks/useMirrorFrame';
import { mirrorMaskHeaders } from '@core/mirror/effects';
import { edit } from '@core/engine/uiEdits';
import { Icon } from '@components/Icon';
import { t } from '@core/i18n';
import { runCreateSubjectTrack, runPlaceBehindSubject } from './placeBehindSubjectCommand';
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

/** One effect on the subject's layer, selected so Effect Controls shows it. */
async function addSubjectEffect(layer: string, effect: 'matte-stroke' | 'selective-color-ai'): Promise<void> {
  const label = effect === 'matte-stroke' ? 'Outline Subject' : 'Color Subject';
  const res = await edit(label, { type: 'addEffect', layers: [layer], effect, params: [] });
  if (res.ok) useSelectionStore.getState().set([layer]);
}

/** The gate: with no roto tool up, a document revision re-renders nothing here. */
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
    const others = useSelectionStore.getState().ids.filter((id) => id !== s.layer);
    const items: ContextMenuItem[] = [
      {
        id: 'behind',
        label: t('workspace.subjects.placeBehind', 'Place Selected Layers Behind'),
        disabled: others.length === 0,
        onSelect: () => { void runPlaceBehindSubject([s.layer, ...others]); },
      },
      {
        id: 'track',
        label: t('workspace.subjects.track', 'Create Subject Track (Null)'),
        disabled: !s.tracked,
        onSelect: () => { void runCreateSubjectTrack(s.layer); },
      },
      { id: 'sep', separator: true },
      // Both read the layer's own Object Matte when their matte layer is None.
      { id: 'outline', label: t('workspace.subjects.outline', 'Outline Subject (Matte Stroke)'), onSelect: () => { void addSubjectEffect(s.layer, 'matte-stroke'); } },
      { id: 'colour', label: t('workspace.subjects.colour', 'Color Subject (Selective Color AI)'), onSelect: () => { void addSubjectEffect(s.layer, 'selective-color-ai'); } },
    ];
    openContextMenu(x, y, items);
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
