/**
 * Keyframe selection + drag for the timeline lanes — moved whole out of
 * `Timeline.tsx`. The composer hands over the values the closures read and
 * gets back the selection, the live preview, the grip set and the snap line.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { snapKeyframeGroup, type SnapTarget } from './keyframeSnap';
import { scaleSelection, scaleGrip } from './keyframeTimeScale';
import type { TimelineModel, TimelineKeyframeRef } from './TimelineModel';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { snapForDrag } from './snapCommands';
import { documentMirror } from '@stores/documentMirror';
import { resolveSelectionKey } from '@core/mirror/keySelection';
import { flicksToSeconds } from '@motion/engine-api';
import { keyframeDragLines, keyframeValues } from './keyframeTooltip';
import type { Dispatch, SetStateAction, MutableRefObject } from 'react';
import type { DragHudState } from './DragHudOverlay';
import type { TimelineProps } from './Timeline';

/** A selected key's comp time from the document mirror (undefined when the id no longer resolves). */
function mirrorKeyTime(id: string): number | undefined {
  const r = resolveSelectionKey(documentMirror(), id);
  return r ? flicksToSeconds(r.key.time) : undefined;
}

export interface UseKeyframeDragArgs {
  model: TimelineModel;
  currentTime: number;
  pps: number;
  scrollLeft: number;
  totalSeconds: number;
  snapOn: boolean;
  lanesRef: MutableRefObject<HTMLDivElement | null>;
  setDragHud: Dispatch<SetStateAction<DragHudState | null>>;
  onKeyframeMove: TimelineProps['onKeyframeMove'];
  onKeyframesMove?: TimelineProps['onKeyframesMove'];
  onKeyframeSeek: TimelineProps['onKeyframeSeek'];
}

export function useKeyframeDrag({
  model,
  currentTime,
  pps,
  scrollLeft,
  totalSeconds,
  snapOn,
  lanesRef,
  setDragHud,
  onKeyframeMove,
  onKeyframesMove,
  onKeyframeSeek,
}: UseKeyframeDragArgs) {
  // ── Multi-keyframe selection ────────────────────────────────────────────────
  // Shared with GraphEditor / F9 / easing pills — store is the source of truth
  // (not a one-way mirror from local state, which would wipe graph selections).
  const selectedKfIds = useKeyframeSelectionStore((s) => s.ids);
  const setSelectedKfIds = useKeyframeSelectionStore((s) => s.set);
  const activeKf = useRef<{
    ids: string[];
    times: Map<string, number>;
    startX: number;
    moved: boolean;
    /** Which keyframe the pointer went down on — the grip for Alt time-scaling. */
    grabbedId: string;
    /** A plain press on a diamond already in a multi-selection: a click collapses the selection to it. */
    collapseOnClick?: boolean;
  } | null>(null);
  const [kfPreview, setKfPreview] = useState<Map<string, number>>(new Map());
  const kfPreviewRef = useRef<Map<string, number>>(new Map());

  // Build a lookup from keyframe id → time across all visible tracks
  const kfTimeById = useMemo<Map<string, number>>(() => {
    const m = new Map<string, number>();
    for (const track of model.tracks) {
      for (const kf of track.keyframes ?? []) m.set(kf.id, kf.time);
      for (const prop of track.properties ?? []) {
        for (const kf of prop.keyframes) m.set(kf.id, kf.time);
      }
    }
    return m;
  }, [model.tracks]);
  const kfDragLive = useRef({ currentTime, kfTimeById, frameRate: model.frameRate });
  kfDragLive.current = { currentTime, kfTimeById, frameRate: model.frameRate };

  const onKeyframeDown = useCallback((kf: TimelineKeyframeRef, e: ReactPointerEvent<HTMLDivElement>, locked = false) => {
    e.stopPropagation();

    // A right (or middle) press: the diamond joins the selection if it is not
    // in it (the context menu that follows acts on the selection), and that is
    // all — no drag, and no "click seeks" on release. Treating it as a left
    // press started a drag and a seek under the menu that was opening.
    if (e.button !== 0) {
      if (!selectedKfIds.has(kf.id)) setSelectedKfIds(new Set([kf.id]));
      return;
    }

    // Compute next selection synchronously to avoid stale closure in drag start
    const nextSel = new Set(selectedKfIds);
    const wasSelected = nextSel.has(kf.id);
    if (e.shiftKey) {
      if (nextSel.has(kf.id)) nextSel.delete(kf.id);
      else nextSel.add(kf.id);
    } else {
      if (!nextSel.has(kf.id)) { nextSel.clear(); nextSel.add(kf.id); }
    }
    setSelectedKfIds(nextSel);

    // Every selected key's time: the lanes' own map, else the mirror (a key
    // selected in the graph editor, or on a collapsed row, is not in the
    // lanes' map — it used to be dragged from time 0 and committed there).
    const times = new Map<string, number>();
    for (const id of nextSel) {
      const t = id === kf.id ? kf.time : (kfTimeById.get(id) ?? mirrorKeyTime(id));
      if (t !== undefined) times.set(id, t);
    }
    // Locked layer: the selection above still happens (so the inspector and
    // the graph can show the key), but there is nothing to drag.
    if (locked) return;
    // A plain press on a diamond already in a multi-selection keeps the set
    // for the drag; a CLICK (no move) collapses the selection to that diamond
    // on release, as AE does — clicking a property name selects every key of
    // the row, and F9 after a click on one diamond then eased the whole row.
    const collapseOnClick = !e.shiftKey && wasSelected && nextSel.size > 1;
    activeKf.current = { ids: [...times.keys()], times, startX: e.clientX, moved: false, grabbedId: kf.id, collapseOnClick };

    const emptyPreview = new Map<string, number>();
    kfPreviewRef.current = emptyPreview;
    setKfPreview(emptyPreview);
  }, [selectedKfIds, kfTimeById, setSelectedKfIds]);

  /**
   * Which selected keyframes are an END of the selection, and so act as the
   * grip for Alt time-scaling. Computed once over the whole selection because
   * a row only sees its own keyframes and the selection spans rows.
   */
  const scaleGripIds = useMemo<Set<string>>(() => {
    const out = new Set<string>();
    if (selectedKfIds.size < 2) return out;
    const times = new Map<string, number>();
    for (const id of selectedKfIds) {
      const t = kfTimeById.get(id);
      if (t !== undefined) times.set(id, t);
    }
    for (const id of times.keys()) if (scaleGrip(times, id)) out.add(id);
    return out;
  }, [selectedKfIds, kfTimeById]);

  /** What the in-flight drag is snapped to — drives the indicator line. */
  const [kfSnap, setKfSnap] = useState<SnapTarget | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const d = activeKf.current;
      if (!d || !lanesRef.current) return;
      const dx = e.clientX - d.startX;
      if (!d.moved && Math.abs(dx) < 3) return;
      d.moved = true;
      const dtSec = dx / pps;
      const live = kfDragLive.current;
      const frameDur = 1 / (live.frameRate || 30);

      // Alt on an END of a multi-selection is AE's time-scale gesture: the
      // group stretches about its opposite end instead of sliding. Everywhere
      // else — a single keyframe, or an interior one — Alt keeps its existing
      // meaning of "free the drag from snapping", because there is no span to
      // scale in those cases and the two readings can never both apply.
      if (e.altKey) {
        const scaled = scaleSelection(d.times, d.grabbedId, dtSec, frameDur);
        if (scaled) {
          setKfSnap(null);
          kfPreviewRef.current = scaled;
          setKfPreview(scaled);
          return;
        }
      }

      // Snap to the playhead, then to other keyframes, then to the frame grid.
      // Alt frees the drag entirely. The dragged keys are excluded from the
      // target list — a keyframe must not snap to itself.
      const dragging = new Set(d.ids);
      const others: number[] = [];
      for (const [id, t] of live.kfTimeById) if (!dragging.has(id)) others.push(t);

      const moved = [...d.times.values()].map((t) => t + dtSec);
      const { delta, target } = snapKeyframeGroup(moved, {
        pixelsPerSecond: pps,
        frameDuration: frameDur,
        // The RESOLVED playhead (separate prop first): model.currentTime is a
        // non-reactive snapshot when the host splits the playhead out, and
        // snapping to a stale snapshot missed the real playhead position.
        playheadTime: live.currentTime,
        keyframeTimes: others,
        disabled: !snapForDrag(snapOn, e.altKey),
      });
      setKfSnap(target);

      const newPreview = new Map<string, number>();
      for (const [id, origTime] of d.times) {
        newPreview.set(id, Math.max(0, origTime + dtSec + delta));
      }
      kfPreviewRef.current = newPreview;
      setKfPreview(newPreview);
      // The read-out: where the grabbed key now sits, how far it moved, and
      // the value it carries — the same badge slip / slide / roll show.
      const grabbedFrom = d.times.get(d.grabbedId) ?? 0;
      setDragHud({
        x: e.clientX,
        y: e.clientY,
        lines: keyframeDragLines({
          fromTime: grabbedFrom,
          toTime: newPreview.get(d.grabbedId) ?? grabbedFrom,
          fps: live.frameRate || 30,
          values: keyframeValues(d.grabbedId),
        }),
      });
    };
    const onUp = (): void => {
      const d = activeKf.current;
      if (!d) return;
      activeKf.current = null;
      setKfSnap(null);
      setDragHud(null);
      if (d.moved) {
        // Commit moves for all dragged keyframes — as ONE edit when the host
        // takes the whole set (one undo entry per drag).
        const moves = [...d.times].map(([id, origTime]) => {
          const dtSec = (kfPreviewRef.current.get(id) ?? origTime) - origTime;
          return { keyframeId: id, time: Math.max(0, origTime + dtSec) };
        });
        if (onKeyframesMove) onKeyframesMove(moves);
        else for (const m of moves) onKeyframeMove?.(m.keyframeId, m.time);
      } else {
        if (d.collapseOnClick) setSelectedKfIds(new Set([d.grabbedId]));
        // Click without move → seek to the key that was CLICKED (not the
        // first of a multi-key selection).
        onKeyframeSeek?.(d.grabbedId);
      }
      const emptyPreview = new Map<string, number>();
      kfPreviewRef.current = emptyPreview;
      setKfPreview(emptyPreview);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [
    pps, scrollLeft, totalSeconds, onKeyframeMove, onKeyframesMove, onKeyframeSeek, snapOn,
    // Stable for the life of the composer (a ref + a state setter); listed so the array is honest.
    lanesRef, setDragHud,
  ]);

  return { selectedKfIds, setSelectedKfIds, kfPreview, onKeyframeDown, scaleGripIds, kfSnap };
}
