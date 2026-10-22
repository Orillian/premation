/**
 * A row's keyframe diamonds — glyph per interpolation, colour per
 * interpolation, the selection ring and the hold tail. Split out of
 * `Timeline.tsx`.
 *
 * The glyphs of a row are ONE <svg> (a <g> per key); each key keeps an empty
 * <div> for the pointer (grab, select, context menu, hover tooltip). An inline
 * <svg> per diamond made every key its own paint chunk: with a tracked path
 * (600 keys) on screen the compositor re-layerized them every frame and
 * playback fell from 30 to 20 fps (docs/PROGRAM_PERFORMANCE.md U1).
 */

import { memo, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { cn } from '@utils/cn';
import { t } from '@core/i18n';
import { keyframeShapes, keyframePaths, describeShapes, keyframeInterp } from './keyframeShape';
import type { TimelineKeyframeRef } from './TimelineModel';
import { timeInWindow, type TimeWindow } from './visibleWindow';
import { formatKeyframeLabel, keyframeValues } from './keyframeTooltip';
import styles from './Timeline.module.css';
import { TIMELINE_LEFT_OFFSET } from './timelineShared';
import { areRowPropsEqual } from './rowMemo';

export const Keyframes = memo(function Keyframes({
  keyframes,
  pps,
  fps,
  startFrame,
  kfPreview,
  selectedKfIds,
  scaleGripIds,
  window,
  locked,
  onKeyframeDown,
  onKeyframeContextMenu,
}: {
  keyframes: ReadonlyArray<TimelineKeyframeRef>;
  pps: number;
  fps: number;
  startFrame: number;
  /** The shared empty Map unless one of THESE keyframes is being dragged. */
  kfPreview: ReadonlyMap<string, number>;
  selectedKfIds: Set<string>;
  /** Keyframes that are an END of the current multi-selection — the Alt grips. */
  scaleGripIds: Set<string>;
  window: TimeWindow;
  locked: boolean;
  onKeyframeDown: (kf: TimelineKeyframeRef, e: ReactPointerEvent<HTMLDivElement>, locked: boolean) => void;
  onKeyframeContextMenu?: (keyframeId: string, clientX: number, clientY: number) => void;
}): JSX.Element {
  // Hover styles the glyph (it is not a child of the hovered element any more).
  const [hovered, setHovered] = useState<string | null>(null);
  const glyphs: JSX.Element[] = [];
  return (
    <>
      {keyframes.map((kf) => {
        const dragging = kfPreview.has(kf.id);
        const time = dragging ? kfPreview.get(kf.id)! : kf.time;
        if (!dragging && !timeInWindow(time, window)) return null;
        const selected = selectedKfIds.has(kf.id);
        // Roving keeps its own full-circle glyph: it is a statement about TIME
        // (this key is auto-positioned for constant speed), not about the
        // interpolation curve, so it must stay distinguishable from auto-bezier.
        const shapes = keyframeShapes(kf.easeIn, kf.easeOut, { isFirst: kf.isFirst, isLast: kf.isLast });
        const paths = keyframePaths(shapes.left, shapes.right);
        const hold = shapes.right === 'hold' && !kf.isLast;
        const x = TIMELINE_LEFT_OFFSET + time * pps;
        if (!kf.roving) {
          glyphs.push(
            // The row's <svg> is the 12px band on the row's centre line: the glyph's 12×12 box at x.
            <g key={kf.id} transform={`translate(${x - 6} 0)`}>
              <g
                className={cn(
                  styles.kfGlyph,
                  dragging && styles.kfGlyphDragging,
                  selected && styles.kfGlyphSelected,
                  hovered === kf.id && !locked && styles.kfGlyphHover,
                )}
                data-interp={keyframeInterp(shapes, kf.isLast === true)}
              >
                <path d={paths.left} />
                <path d={paths.right} />
              </g>
            </g>,
          );
        }
        return (
          <div
            key={kf.id}
            className={cn(
              styles.keyframe,
              dragging && styles.keyframeDragging,
              selected && styles.keyframeSelected,
              kf.roving && styles.keyframeRoving,
              locked && styles.keyframeLocked,
            )}
            // Colour by interpolation (AE): the OUT side names the segment
            // that leaves this key, which is the one the eye follows.
            data-interp={keyframeInterp(shapes, kf.isLast === true)}
            data-hold={hold || undefined}
            style={{ left: `${x}px` }}
            onPointerDown={(e) => onKeyframeDown(kf, e, locked)}
            onContextMenu={(e) => {
              e.preventDefault();
              onKeyframeContextMenu?.(kf.id, e.clientX, e.clientY);
            }}
            // The value is looked up on HOVER, not on render: a title with the
            // value in it would have to be rebuilt for every diamond on every
            // value change. A DOM write on enter costs nothing until then.
            onPointerLeave={() => setHovered((h) => (h === kf.id ? null : h))}
            onPointerEnter={(e) => {
              setHovered(kf.id);
              const label = formatKeyframeLabel({
                time,
                fps,
                startFrame,
                values: keyframeValues(kf.id),
                ease: describeShapes(shapes.left, shapes.right),
              });
              e.currentTarget.title = scaleGripIds.has(kf.id)
                ? t('timeline.keyframe.hoverHintScale', '{label} — drag to move, Shift+click to multi-select, right-click for options, Alt+drag to scale the selection in time', { label })
                : t('timeline.keyframe.hoverHint', '{label} — drag to move, Shift+click to multi-select, right-click for options', { label });
            }}
          />
        );
      })}
      {glyphs.length > 0 && (
        <svg className={styles.keyframeGlyphs} aria-hidden focusable="false">
          {glyphs}
        </svg>
      )}
    </>
  );
}, areRowPropsEqual);
