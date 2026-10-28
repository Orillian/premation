/**
 * Plugin SDK 1.3 — a native plugin's own box in its effect card (PR_PARAM_CUSTOM_UI):
 * AE's custom Effect Controls UI. The plugin draws it (PR_CMD_DRAW_PARAM_UI, through
 * the engine's `drawEffectParamUi`); the card shows the draw list as SVG, as wide as
 * the card and as tall as the plugin declared, and turns a press on one of its
 * handles into `dragEffectParamUi` steps inside ONE gesture (one undo entry; Esc
 * reverts the drag). The box is asked again when the time or the document changes.
 * An item the plugin drew without a colour takes the theme's (pluginParamUi.ts).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ParamUiItem } from '@motion/engine-api';
import { secondsToFlicks } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { GestureSession } from '@core/engine/uiEdits';
import { paths } from '@core/engine/propRefs';
import type { Effect } from '@core/inspector/effectCatalog';
import type { PluginEffectDef } from '@core/inspector/pluginEffectDefs';
import {
  DRAG_BEGIN,
  DRAG_END,
  DRAG_MOVE,
  paramUiColor,
  paramUiDragCommand,
  paramUiHandleAt,
  paramUiPathData,
} from '@core/nativePlugins/pluginParamUi';
import { useMirrorRevision } from '@hooks/useMirror';
import { useResizeObserver } from '@hooks/useResizeObserver';
import styles from './PluginCustomUi.module.css';

interface Drag {
  handle: number;
  start: { x: number; y: number };
  width: number;
  gesture: GestureSession;
}

export function PluginCustomUi({
  nodeId,
  effect,
  def,
  uiKey,
  label,
  height,
  description,
  time,
  disabled = false,
}: {
  nodeId: string;
  effect: Effect;
  def: PluginEffectDef;
  uiKey: string;
  label: string;
  height: number;
  description: string;
  /** The editor's time, seconds. */
  time: number;
  disabled?: boolean;
}): JSX.Element {
  const { ref, size } = useResizeObserver<HTMLDivElement>();
  const width = Math.max(0, Math.floor(size.width));
  const revision = useMirrorRevision(true);
  const [items, setItems] = useState<readonly ParamUiItem[]>([]);
  const drag = useRef<Drag | null>(null);

  useEffect(() => {
    if (width < 16) return;
    let alive = true;
    void engine()
      .query({ type: 'drawEffectParamUi', layer: nodeId, effect: paths.effectGroup(effect.id), key: uiKey, width, time: secondsToFlicks(time) })
      .then((res) => { if (alive) setItems(res.ok ? res.value.items : []); })
      .catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [nodeId, effect.id, uiKey, width, time, revision]);

  const pointIn = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = ref.current?.getBoundingClientRect();
    return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: 0, y: 0 };
  };

  const finish = useCallback((commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    void (commit ? d.gesture.end() : d.gesture.cancel());
  }, []);

  // Esc reverts a drag; a box that unmounts mid-drag still closes its gesture.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && drag.current) {
        e.preventDefault();
        finish(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      finish(true);
    };
  }, [finish]);

  const send = (d: Drag, at: { x: number; y: number }, phase: typeof DRAG_BEGIN | typeof DRAG_MOVE | typeof DRAG_END): void => {
    d.gesture.send([paramUiDragCommand(nodeId, effect.id, uiKey, d.handle, at, d.start, phase, d.width)], { keep: phase !== DRAG_MOVE });
  };

  return (
    <div className={styles.row} aria-disabled={disabled || undefined}>
      {label ? <div className={styles.label} title={description || undefined}>{label}</div> : null}
      <div
        ref={ref}
        className={styles.box}
        style={{ height }}
        role="group"
        aria-label={label || def.label}
        title={!label && description ? description : undefined}
        onPointerDown={(e) => {
          if (disabled || e.button !== 0) return;
          const at = pointIn(e);
          const hit = paramUiHandleAt(items, at.x, at.y);
          if (!hit) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          const d: Drag = { handle: hit.handle, start: at, width, gesture: new GestureSession(`${def.label}: ${label || def.label}`) };
          drag.current = d;
          send(d, at, DRAG_BEGIN);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) send(d, pointIn(e), DRAG_MOVE);
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          if (!d) return;
          send(d, pointIn(e), DRAG_END);
          finish(true);
        }}
        onPointerCancel={() => finish(false)}
      >
        {width >= 16 ? (
          <svg className={styles.svg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
            {items.map((it, i) => <ParamUiShape key={i} item={it} />)}
          </svg>
        ) : null}
      </div>
    </div>
  );
}

function ParamUiShape({ item }: { item: ParamUiItem }): JSX.Element | null {
  const color = paramUiColor(item);
  const p = item.points;
  switch (item.kind) {
    case 'line':
    case 'path':
      return <path d={paramUiPathData(item)} fill="none" stroke={color} strokeWidth={1} vectorEffect="non-scaling-stroke" />;
    case 'fill':
      return <path d={paramUiPathData(item)} fill={color} stroke="none" />;
    case 'text': {
      if (p.length < 2) return null;
      const anchor = item.align === 1 ? 'middle' : item.align === 2 ? 'end' : 'start';
      return <text x={p[0]} y={p[1]} fontSize={item.size || 11} textAnchor={anchor} fill={color} className={styles.text}>{item.text}</text>;
    }
    case 'handle': {
      if (p.length < 2) return null;
      const [x, y] = [p[0]!, p[1]!];
      if (item.shape === 1) return <circle cx={x} cy={y} r={4.5} fill={color} className={styles.handle} />;
      if (item.shape === 2) {
        return (
          <g stroke={color} strokeWidth={1.5} className={styles.handleGroup}>
            <line x1={x - 7} y1={y} x2={x + 7} y2={y} />
            <line x1={x} y1={y - 7} x2={x} y2={y + 7} />
            <circle cx={x} cy={y} r={3.5} fill="none" />
          </g>
        );
      }
      return <rect x={x - 4} y={y - 4} width={8} height={8} fill={color} className={styles.handle} />;
    }
    default:
      return null;
  }
}
