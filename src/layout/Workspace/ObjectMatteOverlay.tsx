/**
 * Object Matte tool — the on-canvas half (AE 26.2's Object Matte tool).
 *
 *   hover        rest the pointer on a subject and its matte is previewed
 *                (outline + tint), nothing written yet
 *   click        select that subject: the held preview is applied, or the
 *                frame is segmented from the click
 *   Shift-click  add to the selection (a foreground point)
 *   Alt-click    subtract from it (a background point)
 *   drag         a box around the subject (AE's Rectangle marquee)
 *
 * The prompts are the Roto Brush's (`rotoBrushStore`: a click is a one-point
 * stroke, the box rides beside them), so the tool options' Propagate, Refine
 * and Freeze carry the selection through the shot exactly as they do a
 * painted one. Segmenting is `core/workspace/rotoBrushTool.ts`; this file is
 * pointer plumbing and SVG.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useUIStore } from '@stores/uiStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useActiveCompSize, useMirrorRevisionFrame } from '@hooks/useMirrorFrame';
import { useCurrentTime } from '@stores/playbackClockStore';
import { useRotoBrushStore } from '@stores/rotoBrushStore';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import {
  boxAt,
  previewObjectMatte,
  segmentStrokesToMask,
  strokesAt,
  type ObjectMattePreview,
} from '@core/workspace/rotoBrushTool';
import { explainObjectMatteError } from '@core/tracking/samModelInstall';
import { settingsFps } from '@core/mirror/compFacts';
import { activeCompSettingsNow } from '@hooks/useMirrorFrame';
import { useLayerScreenMapping } from './useLayerScreenMapping';
import { useDisplayedCamera2D } from './useOverlayView';
import { autoInstallObjectMatte } from '@layout/Settings/objectMatteJob';
import styles from './ObjectMatteOverlay.module.css';
import { t } from '@core/i18n';

/** How long the pointer rests before a hover preview starts. */
const HOVER_MS = 300;
/** A press that moves further than this is a box, not a click. */
const DRAG_PX = 4;
/** A click this close (layer px) to the previewed point applies the held preview. */
const SAME_SPOT_PX = 6;

type Pt = { x: number; y: number };

interface Hover {
  at: Pt;
  time: number;
  preview: ObjectMattePreview;
}

/** A failed segment: a missing model starts its download (no dialog); anything else is said. */
function reportFailure(err: unknown): void {
  const message = err instanceof Error ? err.message : t('workspace.objectMatte.failed', 'Object Matte failed.');
  const store = useRotoBrushStore.getState();
  if (autoInstallObjectMatte(message)) {
    store.setStatus(t('workspace.objectMatte.downloading', 'Getting the Object Matte model (one time, about 14 MB)… try again when it finishes.'));
    return;
  }
  store.setStatus(explainObjectMatteError(message));
}

export function ObjectMatteOverlay(): JSX.Element | null {
  const activeTool = useUIStore((s) => s.activeTool);
  const ids = useSelectionStore((s) => s.ids);
  const time = useCurrentTime();
  const comp = useActiveCompSize();
  const sceneTick = useMirrorRevisionFrame();
  const busy = useRotoBrushStore((s) => s.busy);
  const status = useRotoBrushStore((s) => s.status);
  const box = useRotoBrushStore((s) => s.box);

  const active = activeTool === 'object-matte';
  const nodeId = ids.length === 1 ? ids[0]! : null;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [looking, setLooking] = useState(false);
  const [drag, setDrag] = useState<{ from: Pt; to: Pt } | null>(null);
  const pressRef = useRef<{ from: Pt; client: Pt; shift: boolean; alt: boolean } | null>(null);
  const hoverTimer = useRef<number | null>(null);
  // Bumped by every move: a preview that comes back for an older pointer position is stale.
  const hoverSeq = useRef(0);
  const hoverRef = useRef<Hover | null>(null);
  hoverRef.current = hover;

  useEffect(() => {
    if (active) useRotoBrushStore.getState().setNode(nodeId);
  }, [active, nodeId]);

  const camera = useDisplayedCamera2D();
  const mapping = useLayerScreenMapping(nodeId, time, comp, camera, sceneTick);

  const toLocal = useCallback(
    (clientX: number, clientY: number): Pt | null => {
      const el = rootRef.current;
      if (!el || !mapping) return null;
      const r = el.getBoundingClientRect();
      return mapping.screenToLocal(clientX - r.left, clientY - r.top);
    },
    [mapping],
  );

  const clearHover = useCallback((): void => {
    hoverSeq.current++;
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    hoverRef.current?.preview.discard();
    hoverRef.current = null;
    setHover(null);
    setLooking(false);
  }, []);

  // A new frame, layer or tool invalidates the preview: it is of one frame of one layer.
  useEffect(() => clearHover, [active, nodeId, time, sceneTick, clearHover]);

  const fps = (): number => settingsFps(activeCompSettingsNow());

  const scheduleHover = (p: Pt): void => {
    if (!nodeId) return;
    const seq = ++hoverSeq.current;
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null;
      if (useRotoBrushStore.getState().busy) return;
      setLooking(true);
      const probe = [{ id: 'hover', kind: 'fg' as const, points: [p], time }];
      void previewObjectMatte(nodeId, probe, time, {
        featherPx: useRotoBrushStore.getState().featherPx,
        isStale: () => seq !== hoverSeq.current,
      })
        .then((preview) => {
          if (seq !== hoverSeq.current) {
            preview?.discard();
            return;
          }
          setLooking(false);
          hoverRef.current?.preview.discard();
          setHover(preview ? { at: p, time, preview } : null);
        })
        .catch((err: unknown) => {
          if (seq !== hoverSeq.current) return;
          setLooking(false);
          reportFailure(err);
        });
    }, HOVER_MS);
  };

  /** Segment this frame from the store's prompts (after a click or a box). */
  const segment = (): void => {
    if (!nodeId) return;
    const store = useRotoBrushStore.getState();
    store.setBusy(true);
    store.setStatus(t('workspace.objectMatte.selecting', 'Selecting…'));
    const f = fps();
    void segmentStrokesToMask(nodeId, strokesAt(store.strokes, time, f), time, {
      featherPx: store.featherPx,
      replacePathId: store.maskPathId,
      box: boxAt(store.box, time, f),
    })
      .then((pathId) => {
        const s = useRotoBrushStore.getState();
        s.setMaskPathId(pathId);
        s.setStatus(pathId ? null : t('workspace.objectMatte.nothing', 'Nothing found there — click the subject itself, or drag a box around it.'));
        getWorkspaceController().requestRender();
      })
      .catch((err: unknown) => {
        reportFailure(err);
      })
      .finally(() => useRotoBrushStore.getState().setBusy(false));
  };

  const click = (p: Pt, shift: boolean, alt: boolean): void => {
    if (!nodeId) return;
    const mode = alt ? 'subtract' : shift ? 'add' : 'new';
    const store = useRotoBrushStore.getState();
    store.addPoint(p, time, mode, fps());
    const held = hoverRef.current;
    hoverRef.current = null;
    setHover(null);
    hoverSeq.current++;
    // A plain click where the preview was taken: write what the user saw.
    if (mode === 'new' && held && held.time === time && Math.hypot(held.at.x - p.x, held.at.y - p.y) <= SAME_SPOT_PX) {
      store.setBusy(true);
      void held.preview.apply()
        .then((pathId) => {
          if (pathId) {
            useRotoBrushStore.getState().setMaskPathId(pathId);
            useRotoBrushStore.getState().setStatus(null);
            getWorkspaceController().requestRender();
            return false;
          }
          return true;
        })
        .catch(() => true)
        .then((again) => {
          useRotoBrushStore.getState().setBusy(false);
          if (again) segment();
        });
      return;
    }
    held?.preview.discard();
    segment();
  };

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') clearHover();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, clearHover]);

  if (!active) return null;

  const toScreen = (x: number, y: number): Pt => (mapping ? mapping.localToScreen(x, y) : { x: 0, y: 0 });
  const outlinePath = (flat: readonly number[]): string => {
    if (!mapping || flat.length < 6) return '';
    let d = '';
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const s = toScreen(flat[i]!, flat[i + 1]!);
      d += `${i === 0 ? 'M' : 'L'} ${s.x.toFixed(1)} ${s.y.toFixed(1)} `;
    }
    return `${d}Z`;
  };
  const rectPath = (a: Pt, b: Pt): string => {
    const c = [toScreen(a.x, a.y), toScreen(b.x, a.y), toScreen(b.x, b.y), toScreen(a.x, b.y)];
    return `M ${c.map((q) => `${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(' L ')} Z`;
  };
  const shownBox = drag ?? (boxAt(box, time, fps()) ? { from: { x: box!.x0, y: box!.y0 }, to: { x: box!.x1, y: box!.y1 } } : null);

  const message = !nodeId
    ? t('workspace.objectMatte.selectLayer', 'Select one footage layer, then hover the subject.')
    : status ?? (looking
      ? t('workspace.objectMatte.looking', 'Looking…')
      : hover
        ? t('workspace.objectMatte.clickToSelect', 'Click to select · Shift-click adds · Alt-click subtracts · drag for a box')
        : null);

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-object-matte-overlay=""
      onPointerDown={(e) => {
        if (e.button !== 0 || !nodeId || busy) return;
        const p = toLocal(e.clientX, e.clientY);
        if (!p) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        pressRef.current = { from: p, client: { x: e.clientX, y: e.clientY }, shift: e.shiftKey, alt: e.altKey };
      }}
      onPointerMove={(e) => {
        const press = pressRef.current;
        const p = toLocal(e.clientX, e.clientY);
        if (!p) return;
        if (press) {
          if (drag || Math.hypot(e.clientX - press.client.x, e.clientY - press.client.y) > DRAG_PX) {
            if (!drag) clearHover();
            setDrag({ from: press.from, to: p });
          }
          return;
        }
        if (busy) return;
        const h = hoverRef.current;
        // Still on the previewed spot: keep it rather than re-asking the model.
        if (h && Math.hypot(h.at.x - p.x, h.at.y - p.y) <= SAME_SPOT_PX) return;
        scheduleHover(p);
      }}
      onPointerUp={(e) => {
        const press = pressRef.current;
        pressRef.current = null;
        if (!press || !nodeId) return;
        if (drag) {
          const d = drag;
          setDrag(null);
          if (Math.abs(d.to.x - d.from.x) < 2 || Math.abs(d.to.y - d.from.y) < 2) return;
          const store = useRotoBrushStore.getState();
          // A box starts the selection over on this frame (it wins over points in the engine).
          const f = fps();
          const half = 0.5 / Math.max(1, f);
          for (const s of store.strokes) if (s.time === undefined || Math.abs(s.time - time) <= half) store.removeStroke(s.id);
          store.setBox({ x0: d.from.x, y0: d.from.y, x1: d.to.x, y1: d.to.y, time });
          segment();
          return;
        }
        const p = toLocal(e.clientX, e.clientY) ?? press.from;
        click(p, press.shift, press.alt);
      }}
      onPointerLeave={() => {
        if (!pressRef.current) clearHover();
      }}
    >
      <svg className={styles.svg} aria-hidden="true">
        {hover && (
          <path className={styles.preview} d={outlinePath(hover.preview.outline)} />
        )}
        {shownBox && (
          <path className={styles.box} d={rectPath(shownBox.from, shownBox.to)} />
        )}
      </svg>
      {message && (
        <div className={styles.status} role="status">
          {busy && <span className={styles.spinner} aria-hidden="true" />}
          {message}
        </div>
      )}
    </div>
  );
}
