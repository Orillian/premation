/**
 * MatteLane — After Effects' green Object Matte segments on the layer bar.
 *
 * AE 26 marks the frames a selection has been propagated to with green
 * segments along the bottom of the layer's bar (the frames Freeze would lock,
 * the ones 26.5 keeps in its disk cache). Here a propagated subject is the
 * layer's "Object Matte" outline mask (or the Roto Brush's own path), keyed
 * once per frame the walk reached; consecutive keys merge into one segment, a
 * gap in them is a gap in the matte.
 *
 * Same shape as `HeatLane` and `CacheBars`, for the same reason: the answer
 * moves with edits, so the lane subscribes itself and re-reads at most
 * {@link REFRESH_HZ} times a second, and no clip row re-renders for it.
 */

import { memo, useEffect, useState } from 'react';
import { flicksToSeconds } from '@motion/engine-api';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorRevisionFrame } from '@hooks/useMirrorFrame';
import { matteOutlineKeys } from '@layout/Workspace/subjectTrack';
import type { TimelineTrack } from './TimelineModel';
import { spanInWindow, type TimeWindow } from './visibleWindow';
import styles from './Timeline.module.css';
import { t } from '@core/i18n';

export const REFRESH_HZ = 4;

/** A run of consecutive matte frames, comp seconds [start, end). */
export interface MatteSpan {
  start: number;
  end: number;
}

/**
 * Key times (seconds, any order) → runs of frames. Keys one frame apart (with
 * half a frame of slack) join; each run covers its last frame too.
 */
export function matteSpans(times: readonly number[], fps: number): MatteSpan[] {
  const f = 1 / Math.max(1, fps);
  const sorted = [...times].sort((a, b) => a - b);
  const out: MatteSpan[] = [];
  for (const t0 of sorted) {
    const last = out[out.length - 1];
    if (last && t0 - (last.end - f) <= f * 1.5) last.end = Math.max(last.end, t0 + f);
    else out.push({ start: t0, end: t0 + f });
  }
  // A single keyed frame is a one-frame matte, not a propagation: AE shows
  // nothing until the selection has been carried.
  return out.length === 1 && sorted.length === 1 ? [] : out;
}

interface MatteLaneProps {
  tracks: ReadonlyArray<TimelineTrack>;
  trackRowIndex: ReadonlyMap<string, number>;
  pps: number;
  leftOffset: number;
  trackHeight: number;
  topPadding: number;
  window: TimeWindow;
  fps: number;
}

function MatteLaneImpl({ tracks, trackRowIndex, pps, leftOffset, trackHeight, topPadding, window: timeWindow, fps }: MatteLaneProps): JSX.Element | null {
  const rev = useMirrorRevisionFrame();
  const [spans, setSpans] = useState<ReadonlyMap<string, MatteSpan[]>>(new Map());

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      const m = documentMirror();
      // Footage layers only: a matte is cut from source pixels.
      const ids = tracks.flatMap((tr) => (tr.clips ?? []).map((c) => c.nodeId)).filter((id) => {
        const src = m.layer(id)?.source;
        const type = src ? m.item(src)?.mediaType : undefined;
        return type === 'video' || type === 'image';
      });
      void (async () => {
        const next = new Map<string, MatteSpan[]>();
        for (const id of ids) {
          const o = await matteOutlineKeys(id);
          if (!o) continue;
          const s = matteSpans(o.keys.map((k) => flicksToSeconds(k.time)), fps);
          if (s.length > 0) next.set(id, s);
        }
        if (live) setSpans((prev) => (sameSpans(prev, next) ? prev : next));
      })();
    }, 1000 / REFRESH_HZ);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [tracks, rev, fps]);

  if (spans.size === 0) return null;
  const bars: JSX.Element[] = [];
  for (const track of tracks) {
    const row = trackRowIndex.get(track.id);
    if (row === undefined) continue;
    const top = topPadding + row * trackHeight;
    for (const clip of track.clips ?? []) {
      const runs = spans.get(clip.nodeId);
      if (!runs) continue;
      runs.forEach((s, i) => {
        // Clipped to the bar: keys outside the layer's In/Out draw nothing.
        const a = Math.max(s.start, clip.start);
        const b = Math.min(s.end, clip.start + clip.duration);
        if (!(b > a) || !spanInWindow(a, b, timeWindow)) return;
        bars.push(
          <div
            key={`matte_${clip.id}_${i}`}
            className={styles.matteSpan}
            style={{ left: leftOffset + a * pps, width: Math.max(2, (b - a) * pps), top: top + trackHeight - 6 }}
            title={t('timeline.matte.span', 'Object Matte: {from}–{to} s', { from: a.toFixed(2), to: b.toFixed(2) })}
            aria-hidden
          />,
        );
      });
    }
  }
  return bars.length > 0 ? <>{bars}</> : null;
}

function sameSpans(a: ReadonlyMap<string, MatteSpan[]>, b: ReadonlyMap<string, MatteSpan[]>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, va] of a) {
    const vb = b.get(k);
    if (!vb || vb.length !== va.length) return false;
    for (let i = 0; i < va.length; i++) if (va[i]!.start !== vb[i]!.start || va[i]!.end !== vb[i]!.end) return false;
  }
  return true;
}

export const MatteLane = memo(MatteLaneImpl);
export default MatteLane;
