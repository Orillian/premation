/**
 * ScenePanel — the layer tree for the open composition, plus the project's
 * composition list above it.
 *
 * Three jobs, all of them the document's structure rather than its values:
 *   • the composition list (open, duplicate, settings, delete);
 *   • the layer tree — selection, rename, the switch column, drag-to-reparent,
 *     the parent pick-whip, and the row menu (`sceneMenu`);
 *   • the filter row that narrows the tree five ways, and the view menu that
 *     says how much of the document to list and how densely.
 *
 * It reads the live scene graph directly (`defaultSceneGraph`) and re-derives
 * the tree from a structural change, so there is one source of truth for what
 * the document contains and this panel never holds a second copy of it.
 *
 * ── Why STRUCTURE and not the scene revision ──────────────────────────
 * The tree used to be keyed on `useSceneRevision().rev`. That counter ticks on
 * every value write as well as every structural one — `bumpSceneRevision` is
 * called per pointer move by `viewportGesture` — so dragging a layer on canvas
 * rebuilt this entire tree thirty to sixty times a second: every node of every
 * composition, its plugin ownership, its label colour and a fresh JSX label,
 * then the filter walk, the match count, the kind list and the footer's flatten
 * on top. The timeline was moved off `rev` for exactly this reason and the
 * Layers panel was not. Structure arrives as `SceneGraphChanged`; VALUES that
 * this tree actually displays (a name, a visibility flag, a label colour) each
 * announce themselves as `NodeUpdated`, which is the second signal below.
 *
 * Panel chrome (rows, the footer, the search row) comes from the shared
 * `EditorLayout/panels.module.css`, which the Scene, Assets and Inspector
 * panels all draw from — they are three views of one dock, not three designs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Panel } from '@components/Panel';
import { TreeView } from '@components/TreeView';
import { SearchField } from '@components/SearchField';
import { Icon } from '@components/Icon';
import { IconButton } from '@components/IconButton';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { PickWhip } from '@components/PickWhip';
import { useSelectionStore } from '@stores/selectionStore';
import { useProjectStore } from '@stores/projectStore';
import { documentMirror } from '@stores/documentMirror';
import { useActiveCompId, useMirrorRevision, useMirrorStructRevision } from '@hooks/useMirror';
import { useSearchFacts } from '@hooks/useSearchFacts';
import { mirrorCanBeParentOf } from '@core/mirror/parenting';
import { useUIStore } from '@stores/uiStore';
import { openContextMenu } from '@stores/contextMenuStore';
import {
  ROW_DENSITY,
  useSceneViewStore,
  type RowDensity,
  type SearchField as SearchFieldId,
} from '@stores/sceneViewStore';
import { getEventBus } from '@core/events/EventBus';
import type { RenameLayerResult } from '@core/scene/renameLayer';
import { isLayer } from '@core/mirror/docFacts';
import { activeCameraIdOf } from '@core/mirror/activeCamera';
import { getTime } from '@stores/playbackClockStore';
import { type SceneKind } from '@core/scene/sceneKind';
import { KIND_LABEL } from '@core/scene/sceneDerive';
import { parentLayer } from '@layout/Inspector/inspectorEdits';
import { moveLayersInTreeEdit, renameLayerEdit } from './sceneEdits';
import { LABEL_COLORS } from '@core/scene/labelColor';
import { LAYER_FLAGS } from '@core/scene/layerFlags';
import {
  countSceneMatches,
  filterSceneTree,
  isSceneFilterActive,
  toggleKind,
  withRevealed,
  type SceneFilter,
} from './sceneFilters';
import {
  collectIds,
  makeFactsReader,
  presentKinds,
  sceneGraphToTree,
} from './sceneRows';
import { SceneRowAV, SceneRowSwitches } from './SceneRowSwitches';
import { deleteLayersWithFeedback, sceneNodeMenuItems } from './sceneMenu';
import styles from '@layout/EditorLayout/panels.module.css';
import { CompositionList } from './CompositionList';
import { t } from '@core/i18n';

const KIND_ORDER = Object.keys(KIND_LABEL) as SceneKind[];

const SEARCH_FIELD_IDS: ReadonlyArray<SearchFieldId> = ['name', 'effects', 'expressions', 'source'];

function searchFieldLabel(id: SearchFieldId): string {
  switch (id) {
    case 'name': return t('scene.panel.fieldName', 'Layer name');
    case 'effects': return t('scene.panel.fieldEffects', 'Effect names');
    case 'expressions': return t('scene.panel.fieldExpressions', 'Expression text');
    case 'source': return t('scene.panel.fieldSource', 'Source file / comp');
  }
}

function densities(): ReadonlyArray<{ id: RowDensity; label: string }> {
  return [
    { id: 'compact', label: t('scene.panel.densityCompact', 'Compact') },
    { id: 'cozy', label: t('scene.panel.densityCozy', 'Cozy') },
    { id: 'comfortable', label: t('scene.panel.densityComfortable', 'Comfortable') },
  ];
}

/** Re-export for the layer-ordering tests, which assert what this panel LISTS. */
export { sceneGraphToTree } from './sceneRows';

/**
 * A counter that ticks when the document's STRUCTURE changes (B4: the mirror's
 * `docStruct`, not its revision).
 *
 * The tree draws structure, the values that appear on a row (names, switches,
 * labels, kinds, icons — all layer HEADERS) and, for the filters, keyframes and
 * the effect count — so any edit but a pure property VALUE write may change it.
 * A value write — every step of a viewport drag, a scrubbed or typed number —
 * cannot: on the plain revision this panel re-derived its whole tree (and
 * re-rendered every row) per pointer move. A played frame or a viewport hover is
 * not an edit either, so this never ticks per frame.
 */
function useDocumentRevision(): number {
  return useMirrorStructRevision();
}

/**
 * The ancestors of `id` in the tree, innermost first: its parent chain, then
 * the composition it belongs to (the tree's root row). From the document mirror.
 */
function ancestorChain(id: string): string[] {
  const m = documentMirror();
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur = m.layer(id);
  let parent = cur?.parent;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    chain.push(parent);
    cur = m.layer(parent);
    parent = cur?.parent;
  }
  if (cur && !seen.has(cur.comp)) chain.push(cur.comp);
  return chain;
}

/**
 * A row's lock and name: a layer's from the document mirror; a composition
 * ROOT's from its node.
 */
function rowLock(id: string): { locked: boolean; name: string | undefined } | null {
  const l = documentMirror().layer(id);
  if (l) return { locked: l.switches.locked, name: l.name };
  // A composition ROOT is not a layer in the API: it has no lock; its name is its settings'.
  const comp = documentMirror().comp(id);
  return comp ? { locked: false, name: comp.settings.name } : null;
}

export function ScenePanel(): JSX.Element {
  const selected = useSelectionStore((s) => s.ids);
  const setSelected = useSelectionStore((s) => s.set);
  const rev = useDocumentRevision();

  const activeTabId = useProjectStore((s) => s.activeTabId);
  // The active tab's composition (or a group opened in its own tab), when the document has it.
  const tabCompId = useActiveCompId();
  const activeCompId = tabCompId && (documentMirror().comp(tabCompId) || documentMirror().layer(tabCompId)) ? tabCompId : undefined;

  // ── View settings: panel-wide, persisted, outlive the panel's mount ──
  const scope = useSceneViewStore((s) => s.scope);
  const density = useSceneViewStore((s) => s.density);
  const switches = useSceneViewStore((s) => s.switches);
  const thumbnails = useSceneViewStore((s) => s.thumbnails);
  const hideShy = useSceneViewStore((s) => s.hideShy);
  const view = useSceneViewStore((s) => ({
    setScope: s.setScope, setDensity: s.setDensity, toggleSwitch: s.toggleSwitch,
    setThumbnails: s.setThumbnails, setHideShy: s.setHideShy,
  }));

  // ── Filters: per composition, so "show me the cameras" is a question
  //    about THIS comp and does not follow you into one with no cameras ──
  const filters = useSceneViewStore((s) => s.filters);
  const patchFilter = useSceneViewStore((s) => s.patchFilter);
  const clearFilterFor = useSceneViewStore((s) => s.clearFilter);
  const stored = useMemo(
    () => useSceneViewStore.getState().filterFor(activeCompId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filters, activeCompId],
  );
  const patch = useCallback(
    (p: Parameters<typeof patchFilter>[1]) => patchFilter(activeCompId, p),
    [patchFilter, activeCompId],
  );

  // The active camera mark (U5) is resolved when the tree is rebuilt — on a
  // structural change, never per played frame (this panel does not follow the
  // playhead; a camera whose bar starts later is marked once the stack changes
  // or the panel remounts).
  const tree = useMemo(
    () => sceneGraphToTree(scope, { thumbnails, activeCameraId: activeCameraIdOf(documentMirror(), activeCompId, getTime(activeTabId)) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rev, activeTabId, scope, thumbnails, activeCompId],
  );

  const q = stored.query.trim().toLowerCase();
  /*
    Search is one of FIVE questions this panel answers, not the only one. A
    stack of forty layers is narrowed by kind ("show me the cameras"), by label
    colour ("the shots I tagged red"), by whether a layer is animated and by
    whether it carries effects — and they compose, with the search, in
    `sceneFilters.ts`. The search itself now asks four FIELDS, because "where
    is that glow" is one question whether the word names the layer or the
    effect on it.
  */
  const kindFilter = useMemo(() => (stored.kinds ? new Set(stored.kinds) : null), [stored.kinds]);
  const filter: SceneFilter = {
    kinds: kindFilter,
    label: stored.label,
    animatedOnly: stored.animatedOnly,
    effectsOnly: stored.effectsOnly,
    threeDOnly: stored.threeDOnly,
    query: q,
    fields: stored.fields,
    hideShy,
  };
  const filterActive = isSceneFilterActive(filter);

  // Keyframes, effects and expressions are edits like any other: the document
  // revision (`rev`) ticks on them, so the "with keyframes" / "with effects"
  // filters re-ask when a keyframe or an effect is added.

  /*
    ONE facts reader per pass, shared by the filter walk and the match count.
    The expensive fields (every expression in the document; the asset list) are
    indexed once here and only when they are actually being searched, instead
    of being re-derived per node per keystroke by both walks.
  */
  // Effects / Expressions searched: the engine's document-wide facts (B4).
  // The facts include expression TEXT and effect names, which a value write can change, so a search that
  // reads them follows the plain revision (only while it searches those fields).
  const searchesFacts = q.length > 0 && (stored.fields.includes('effects') || stored.fields.includes('expressions'));
  const factsRev = useMirrorRevision(searchesFacts);
  const searchFacts = useSearchFacts(searchesFacts, factsRev);
  const factsOf = useMemo(
    () => makeFactsReader(stored.fields, q.length > 0, undefined, searchFacts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stored.fields, q, rev, searchFacts],
  );

  const filtered = useMemo(
    () => filterSceneTree(tree, filter, factsOf),
    // The filter object is rebuilt every render; its FIELDS are the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree, kindFilter, stored.label, stored.animatedOnly, stored.effectsOnly, stored.threeDOnly, q, stored.fields, hideShy, factsOf],
  );
  const matchCount = useMemo(
    () => (filterActive ? countSceneMatches(filtered, filter, factsOf) : 0),
    // Same fields as `filtered`, which already carries them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, filterActive, factsOf],
  );
  const kindChoices = useMemo(() => presentKinds(tree, KIND_ORDER), [tree]);
  const expandIds = useMemo(() => collectIds(filtered), [filtered]);
  // Expand only the top-level roots by default, so their LAYERS are visible
  // but groups stay shut. `collectIds` returns every descendant, so an imported
  // SVG icon — one group of dozens of paths — unfolded into dozens of rows the
  // moment it was added, burying the rest of the scene. The icon is one body on
  // canvas already (see `selectionGroup`); the tree now agrees with that.
  // Searching still expands everything, so matches stay reachable.
  const defaultExpandIds = useMemo(() => filtered.map((n) => n.id), [filtered]);
  // The ACTIVE composition's layers, root excluded. `defaultSceneGraph.size`
  // counted every node of every composition — each comp root included — so a
  // project with three comps reported a number that matched no list on screen.
  // B4: the composition's layers from the document mirror (every layer of it, groups' members included).
  const itemCount = useMemo(
    () => {
      const m = documentMirror();
      const id = tabCompId ?? m.compIds[0] ?? '';
      const comp = m.comp(id);
      if (comp) return comp.layers.length;
      // A group opened in its own tab: its members, at any depth.
      let n = 0;
      const walk = (ids: readonly string[]): void => {
        for (const c of ids) {
          n += 1;
          walk(m.layer(c)?.children ?? []);
        }
      };
      walk(m.layer(id)?.children ?? []);
      return n;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rev, tabCompId],
  );

  /*
   * Keep a reparented layer on screen.
   *
   * `parent` IS the tree here, so parenting MOVES the layer into the parent's
   * branch — and only top-level roots are expanded by default. Parent a
   * rectangle to a Null and it lands inside a branch that has never been
   * expanded (a Null has no children until that moment), so it vanishes from
   * this panel entirely while still rendering on canvas. Reported as
   * "missing layer after parent to null".
   *
   * The whole ancestor chain, not just the parent: the destination can itself
   * sit inside a shut group, and opening only the innermost branch would leave
   * the layer just as hidden one level up.
   */
  const [revealIds, setRevealIds] = useState<ReadonlyArray<string>>([]);
  // B4: a reparent is a layer whose mirror `parent` moved between two revisions (whichever engine made it).
  const parentsSeen = useRef<Map<string, string | undefined> | null>(null);
  useEffect(() => {
    const m = documentMirror();
    const prev = parentsSeen.current;
    const next = new Map<string, string | undefined>();
    let reveal: string[] | null = null;
    for (const id of m.layerIds()) {
      const parent = m.layer(id)?.parent;
      next.set(id, parent);
      if (prev && prev.has(id) && prev.get(id) !== parent) reveal = parent ? [parent, ...ancestorChain(parent)] : [];
    }
    parentsSeen.current = next;
    if (reveal) setRevealIds(reveal);
  }, [rev]);
  // While a filter drives the expansion set the tree is controlled and drops
  // `revealIds` on the floor (a controlled caller owns its reveal — this is
  // that caller). Merge the chain in here so a reparent during a search opens
  // its branch the same way it does without one.
  const controlledExpandIds = useMemo(() => withRevealed(expandIds, revealIds), [expandIds, revealIds]);

  /*
    Follow a selection this panel did not make.

    Clicking a layer on canvas, in the timeline, or through a command selects
    it everywhere — and this tree, which may have it scrolled a thousand rows
    away or shut inside a group, simply did not react. The tree scrolls to the
    newest member of the selection and opens its ancestors, but only when the
    selection CHANGED from outside: `ownSelection` marks the ids this panel just
    set, so clicking a row here does not make the list jump under the cursor.
  */
  const ownSelection = useRef<string | null>(null);
  const [scrollToId, setScrollToId] = useState<string | undefined>(undefined);
  useEffect(() => {
    const id = selected[selected.length - 1];
    if (!id || ownSelection.current === id) return;
    setScrollToId(id);
    const chain = ancestorChain(id);
    if (chain.length) setRevealIds(chain);
  }, [selected]);

  const selectFromTree = useCallback((ids: ReadonlyArray<string>) => {
    ownSelection.current = ids[ids.length - 1] ?? null;
    setSelected(ids);
  }, [setSelected]);

  const [renamingId, setRenamingId] = useState<string | null>(null);

  /** True (and says so) when the row is locked — locked means not editable here. */
  const refuseIfLocked = (id: string, what: string): boolean => {
    const row = rowLock(id);
    if (!row?.locked) return false;
    useUIStore.getState().notify({ level: 'info', message: `“${row.name ?? id}” is locked — unlock it to ${what}.`, durationMs: 3000 });
    return true;
  };

  const startRename = (id: string): void => {
    if (refuseIfLocked(id, 'rename it')) return;
    setRenamingId(id);
  };

  const commitRename = (id: string, name: string): void => {
    setRenamingId(null);
    if (refuseIfLocked(id, 'rename it')) return;

    // Not a bare `node.name = name`. Expressions reference layers by NAME and
    // resolve at evaluation time, so a plain rename silently zeroes every
    // reference to this layer — with the symptom appearing nowhere near the
    // rename that caused it. `renameLayerEdit` sends the engine's rename when
    // no expression names the old or new name, and otherwise keeps
    // `renameLayer`, which follows the rename through those references in the
    // SAME undo entry and reports the two cases it will not guess at.
    void renameLayerEdit(id, name).then((result) => reportRename(result, name));
  };

  /** What a rename did to expressions, said once (see `renameLayer`). */
  const reportRename = (result: RenameLayerResult, name: string): void => {
    if (!result.ok) return;

    if (result.repaired.length > 0) {
      useUIStore.getState().notify({
        level: 'info',
        message:
          result.repaired.length === 1
            ? '1 expression updated to follow the new name.'
            : `${result.repaired.length} expressions updated to follow the new name.`,
        durationMs: 4000,
      });
    }

    // The author's call, not ours — and worth saying out loud precisely because
    // it breaks nothing visibly today.
    if (result.captured.length > 0) {
      const n = result.captured.length;
      useUIStore.getState().notify({
        level: 'warning',
        message: n === 1
          ? t('scene.panel.expressionRetargetOne', '{n} expression naming “{name}” now read this layer instead of the one they read before.', { n, name: name.trim() })
          : t('scene.panel.expressionRetargetOther', '{n} expressions naming “{name}” now read this layer instead of the one they read before.', { n, name: name.trim() }),
        // Longer than the others: this one is a silent retarget the user cannot
        // see anywhere else, and it is the only notice they will get.
        durationMs: 10000,
      });
    } else if (result.nameAlreadyInUse) {
      useUIStore.getState().notify({
        level: 'warning',
        message: t('scene.panel.nameInUse', 'Another layer is already called “{name}”. An expression naming it can only reach one of them.', { name: name.trim() }),
        durationMs: 6000,
      });
    }
  };

  /*
    Drag-to-reorder / reparent from the layer tree.

    Three things the single-id version got wrong, all of them visible with more
    than one row selected or more than one lock in the stack:
      • it moved ONE layer of a multi-row drag and left the rest behind;
      • it checked the DRAGGED layer's lock and not the destination's, so a
        locked group happily accepted children;
      • each moved layer was its own undo entry.

    The tree DISPLAYS front first (reversed child order), while
    `moveNodeAdjacent` speaks child order — so display-before means child-after
    and vice versa. Dropped in reverse so a multi-row drag keeps the order the
    rows were in rather than inverting it.
  */
  const handleReorder = (
    ids: ReadonlyArray<string>,
    targetId: string | null,
    pos: 'before' | 'after' | 'inside',
  ): void => {
    const movable = ids.filter((id) => {
      // A composition root is not a layer and cannot be moved into one.
      const l = documentMirror().layer(id);
      return !!l && !l.switches.locked && isLayer(id);
    });
    if (movable.length === 0) {
      if (ids.length > 0) refuseIfLocked(ids[0]!, 'move it');
      return;
    }
    if (targetId !== null) {
      const target = rowLock(targetId);
      if (target?.locked && pos === 'inside') {
        useUIStore.getState().notify({
          level: 'info',
          message: `“${target.name ?? targetId}” is locked — unlock it to put layers inside it.`,
          durationMs: 3000,
        });
        return;
      }
    }

    // One entry: `setParent` + `reorderLayers` through the engine (the drop
    // rules are spelled out on `moveLayersInTreeEdit`).
    void moveLayersInTreeEdit(movable, targetId, pos);
  };

  const openNodeMenu = (id: string, e: React.MouseEvent): void => {
    openContextMenu(e.clientX, e.clientY, sceneNodeMenuItems(id, { startRename }));
  };

  const rowHeight = ROW_DENSITY[density];

  /** The view menu: scope, density, which switches, thumbnails, shy. */
  const viewMenuItems: DropdownItem[] = [
    { type: 'label', label: t('scene.panel.viewShow', 'Show') },
    ...(['comp', 'project'] as const).map((s): DropdownItem => ({
      type: 'item',
      id: `v-scope-${s}`,
      label: s === 'comp' ? t('scene.panel.scopeComp', 'This composition') : t('scene.panel.scopeProject', 'Whole project'),
      icon: scope === s ? 'check' : undefined,
      onSelect: () => view.setScope(s),
    })),
    { type: 'separator' },
    { type: 'label', label: t('scene.panel.rowHeight', 'Row height') },
    ...densities().map((d): DropdownItem => ({
      type: 'item',
      id: `v-density-${d.id}`,
      label: d.label,
      icon: density === d.id ? 'check' : undefined,
      onSelect: () => view.setDensity(d.id),
    })),
    { type: 'separator' },
    { type: 'label', label: t('scene.panel.switchesOnRow', 'Switches on each row') },
    ...LAYER_FLAGS.map((f): DropdownItem => ({
      type: 'checkbox',
      id: `v-switch-${f.id}`,
      label: f.label,
      checked: switches.includes(f.id),
      onChange: () => view.toggleSwitch(f.id),
    })),
    { type: 'separator' },
    {
      type: 'checkbox',
      id: 'v-thumbs',
      label: t('scene.panel.thumbnails', 'Source thumbnails'),
      checked: thumbnails,
      onChange: () => view.setThumbnails(!thumbnails),
    },
    {
      type: 'checkbox',
      id: 'v-shy',
      label: t('scene.panel.hideShy', 'Hide shy layers'),
      checked: hideShy,
      onChange: () => view.setHideShy(!hideShy),
    },
  ];

  /*
    The filter menu (owner redesign 2026-10-14). Six icon toggles in a row —
    kind, label, keyframes, effects, 3D, clear — plus a second magnifier for
    the search fields read as a toy strip; they are one menu now, and what is
    active is spelled out as chips under the search field.
  */
  const filterMenuItems = (): DropdownItem[] => [
    { type: 'label', label: t('scene.panel.filterKind', 'Kind') },
    ...(kindChoices.length === 0
      ? [{ type: 'item', id: 'no-kinds', label: t('scene.panel.noKinds', 'No layers yet'), disabled: true } as DropdownItem]
      : kindChoices.map((k): DropdownItem => ({
          type: 'checkbox',
          id: `kind-${k}`,
          label: KIND_LABEL[k],
          checked: kindFilter?.has(k) ?? false,
          // An empty set collapses back to "every kind" — unchecking the
          // last box means "stop filtering", not "show nothing".
          onChange: () => {
            const next = toggleKind(kindFilter, k);
            patch({ kinds: next ? [...next] : null });
          },
        }))),
    { type: 'separator' },
    { type: 'label', label: t('scene.panel.filterHas', 'Has') },
    { type: 'checkbox', id: 'has-keys', label: t('scene.panel.filterKeyframes', 'Keyframes'), checked: stored.animatedOnly, onChange: () => patch({ animatedOnly: !stored.animatedOnly }) },
    { type: 'checkbox', id: 'has-fx', label: t('scene.panel.filterEffects', 'Effects'), checked: stored.effectsOnly, onChange: () => patch({ effectsOnly: !stored.effectsOnly }) },
    // The 3D view (U5): cameras, lights and 3D layers; the active camera is marked.
    { type: 'checkbox', id: 'has-3d', label: t('scene.panel.filter3d', 'Cameras, lights and 3D layers'), checked: stored.threeDOnly, onChange: () => patch({ threeDOnly: !stored.threeDOnly }) },
    { type: 'separator' },
    { type: 'label', label: t('scene.panel.filterLabel', 'Label') },
    {
      type: 'custom',
      id: 'labels',
      render: (
        <div className={styles.filterSwatches} role="group" aria-label={t('scene.panel.labelColour', 'Label colour')}>
          {LABEL_COLORS.map((c) => (
            <button
              key={c.id}
              type="button"
              className={styles.filterSwatch}
              style={{ background: c.color }}
              aria-label={c.label}
              aria-pressed={stored.label === c.color}
              title={c.label}
              onClick={() => patch({ label: stored.label === c.color ? null : c.color })}
            />
          ))}
          {/* The set you forgot to tag — the other half of what a label is for. */}
          <button
            type="button"
            className={styles.filterSwatchNone}
            aria-pressed={stored.label === 'none'}
            onClick={() => patch({ label: stored.label === 'none' ? null : 'none' })}
          >
            {t('scene.panel.none', 'None')}
          </button>
        </div>
      ),
    },
    { type: 'separator' },
    // WHICH fields the box searches — visible here rather than a syntax
    // ("fx:glow"), because a search that silently looks in four places is as
    // confusing as one that silently looks in one.
    { type: 'label', label: t('scene.panel.searchIn', 'Search in') },
    ...SEARCH_FIELD_IDS.map((f): DropdownItem => ({
      type: 'checkbox',
      id: `field-${f}`,
      label: searchFieldLabel(f),
      checked: stored.fields.includes(f),
      onChange: () => patch({ fields: toggleField(stored.fields, f) }),
    })),
  ];

  /** The active filters as removable chips (the search text is in its own field). */
  const chips: Array<{ id: string; label: string; clear: () => void }> = [];
  if (kindFilter) chips.push({ id: 'kind', label: [...kindFilter].map((k) => KIND_LABEL[k]).join(', '), clear: () => patch({ kinds: null }) });
  if (stored.animatedOnly) chips.push({ id: 'keys', label: t('scene.panel.chipKeyframes', 'Has keyframes'), clear: () => patch({ animatedOnly: false }) });
  if (stored.effectsOnly) chips.push({ id: 'fx', label: t('scene.panel.chipEffects', 'Has effects'), clear: () => patch({ effectsOnly: false }) });
  if (stored.threeDOnly) chips.push({ id: '3d', label: t('scene.panel.chip3d', '3D only'), clear: () => patch({ threeDOnly: false }) });
  if (stored.label) {
    const name = stored.label === 'none' ? t('scene.panel.labelNone', 'None') : LABEL_COLORS.find((c) => c.color === stored.label)?.label ?? t('scene.panel.labelColourFallback', 'Colour');
    chips.push({ id: 'label', label: t('scene.panel.chipLabel', 'Label: {name}', { name }), clear: () => patch({ label: null }) });
  }
  const menuFilterActive = chips.length > 0;

  return (
    <Panel
      id="scene"
      title={t('scene.panel.scene', 'Scene')}
      icon="layers"
      hideHeader
      noScroll
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'scene' })}
    >
      <div className={styles.sceneShell} data-tour="scene-panel">
        <CompositionList collapsible />
        <div className={styles.layerSectionHead}>
          <span className={styles.compSectionLabel}>{t('scene.panel.layers', 'Layers')}</span>
          <span className={styles.compMeta}>{itemCount}</span>
        </div>
        <div className={styles.searchRow}>
          <SearchField
            className={styles.sceneSearch}
            placeholder={searchPlaceholder(stored.fields)}
            ariaLabel={t('scene.panel.searchAria', 'Search layers')}
            value={stored.query}
            onChange={(query) => patch({ query })}
          />
          <Dropdown
            placement="bottom-end"
            trigger={
              <IconButton
                size="sm"
                className={styles.sceneFilterTrigger}
                tooltip={t('scene.panel.filterLayers', 'Filter layers')}
                aria-label={t('scene.panel.layerFilters', 'Layer filters')}
                aria-pressed={menuFilterActive}
              >
                <Icon name="filter" size="sm" />
                {menuFilterActive && <span className={styles.sceneToolDot} aria-hidden="true" />}
              </IconButton>
            }
            items={filterMenuItems}
          />
          <Dropdown
            placement="bottom-end"
            trigger={
              <IconButton size="sm" tooltip={t('scene.panel.howThisPanelListsLayers', 'How this panel lists layers')} aria-label={t('scene.panel.layersPanelViewOptions', 'Layers panel view options')}>
                <Icon name="tune" size="sm" />
              </IconButton>
            }
            items={viewMenuItems}
          />
        </div>
        {filterActive && (
          <div className={styles.sceneChips} aria-label={t('scene.panel.activeLayerFilters', 'Active layer filters')}>
            {chips.map((c) => (
              <button
                key={c.id}
                type="button"
                className={styles.sceneChip}
                aria-label={t('scene.panel.removeFilter', 'Remove filter: {label}', { label: c.label })}
                onClick={c.clear}
              >
                <span className={styles.sceneChipText}>{c.label}</span>
                <Icon name="close" size="sm" />
              </button>
            ))}
            <button
              type="button"
              className={styles.sceneChipClear}
              aria-label={t('scene.panel.clearLayerFilters', 'Clear layer filters')}
              onClick={() => clearFilterFor(activeCompId)}
            >
              {t('scene.panel.clear', 'Clear')}
            </button>
          </div>
        )}
        {/* Column heads over AE's switch columns, so the glyphs name themselves. */}
        <div className={styles.layerColumns} aria-hidden="true">
          <span className={styles.avGutter}>
            <span className={styles.avHead}><Icon name="eye" size="sm" /></span>
            <span className={styles.avHead}><Icon name="audio" size="sm" /></span>
            <span className={styles.avHead}><Icon name="circle" size="sm" /></span>
            <span className={styles.avHead}><Icon name="lock" size="sm" /></span>
          </span>
          <span className={styles.layerColumnName}>{t('scene.panel.layerName', 'Layer name')}</span>
        </div>
        {/*
          A pick-whip drop surface. Rows already carry `data-id` from the shared
          TreeView and that id IS the scene node id here, so scoping the container
          is the entire integration — see `@core/whip/whipTarget` for why the
          alternative (teaching TreeView to emit whip attributes) would be worse
          for a component six panels use with four kinds of id.
        */}
        <div className={styles.sceneBody} data-whip-scope="layer">
          {filtered.length ? (
            <TreeView
              nodes={filtered}
              ariaLabel={t('scene.panel.layers', 'Layers')}
              rowHeight={rowHeight}
              selectedIds={selected}
              onSelect={selectFromTree}
              defaultExpandedIds={defaultExpandIds}
              expandedIds={filterActive ? controlledExpandIds : undefined}
              revealIds={revealIds}
              scrollToId={scrollToId}
              onNodeContextMenu={openNodeMenu}
              onReorder={handleReorder}
              renamingId={renamingId ?? undefined}
              onRename={commitRename}
              onRenameCancel={() => setRenamingId(null)}
              onRenameRequest={startRename}
              onDelete={(ids) => { void deleteLayersWithFeedback(ids); }}
              renderGutter={(node) => <SceneRowAV nodeId={node.id} />}
              /*
                The parent pick-whip, the gesture AE users reach for a hundred
                times a day. The tree was already a whip TARGET; being only a
                target meant you could parent a layer TO one of these rows and
                never FROM one. Composition roots get no whip — they are the
                document, not a layer that can have a parent.
              */
              renderLead={(node) => {
                // A composition root (no layer record) gets no whip.
                if (!documentMirror().layer(node.id)) return null;
                return (
                  <PickWhip
                    label={t('scene.panel.pickWhip', 'Parent pick-whip — drag onto a layer (Shift: jump to the parent · Alt: keep values)')}
                    accept={(target) => mirrorCanBeParentOf(documentMirror(), node.id, target.nodeId)}
                    // The inspector's writer (`setParent`); a composition root = no parent.
                    onPick={(target, m) => parentLayer(node.id, isLayer(target.nodeId) ? target.nodeId : null, m)}
                  />
                );
              }}
              renderActions={switches.length ? (node) => <SceneRowSwitches nodeId={node.id} flags={switches} /> : undefined}
            />
          ) : (
            <div className={styles.empty} role="status">
              {filterActive
                ? t('scene.panel.noMatch', 'No layers match this filter.')
                : t('scene.panel.empty', 'No layers yet. Add one from the “+ New layer” menu in the toolbar.')}
            </div>
          )}
        </div>
        <div className={styles.sceneFooter}>
          <span>{itemCount === 1 ? t('scene.panel.layerCountOne', '{n} layer', { n: itemCount }) : t('scene.panel.layerCountOther', '{n} layers', { n: itemCount })}</span>
          {filterActive && (
            <>
              <span>·</span>
              <span>{matchCount === 1 ? t('scene.panel.matchCountOne', '{n} match', { n: matchCount }) : t('scene.panel.matchCountOther', '{n} matches', { n: matchCount })}</span>
            </>
          )}
          <span>·</span>
          <span>{t('scene.panel.selectedCount', '{n} selected', { n: selected.length })}</span>
          <span className={styles.spacer} />
          <IconButton
            size="sm"
            tooltip={t('scene.panel.deleteTheSelectedLayers', 'Delete the selected layers')}
            aria-label={t('scene.panel.deleteSelectedLayers', 'Delete selected layers')}
            disabled={selected.length === 0}
            onClick={() => { void deleteLayersWithFeedback(selected); }}
          >
            <Icon name="trash" size="sm" />
          </IconButton>
        </div>
      </div>
    </Panel>
  );
}

/** Placeholder that says where the box is looking, so the answer is visible
 *  before a fruitless search rather than after it. */
function searchPlaceholder(fields: ReadonlyArray<SearchFieldId>): string {
  if (fields.length === 0 || (fields.length === 1 && fields[0] === 'name')) return t('scene.panel.searchPlaceholder', 'Search layers…');
  if (fields.length === SEARCH_FIELD_IDS.length) return t('scene.panel.searchPlaceholderAll', 'Search layers, effects, expressions…');
  return t('scene.panel.searchPlaceholderFields', 'Search {fields}…', { fields: fields.map((f) => searchFieldLabel(f).toLowerCase()).join(' · ') });
}

/** Toggle a search field; unchecking the last one falls back to the name,
 *  because a search box that looks in nothing is a box that does nothing. */
function toggleField(fields: ReadonlyArray<SearchFieldId>, id: SearchFieldId): SearchFieldId[] {
  const next = fields.includes(id) ? fields.filter((f) => f !== id) : [...fields, id];
  return next.length === 0 ? ['name'] : [...next];
}
