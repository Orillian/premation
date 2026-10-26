/**
 * HandOverlay — the tracked hand in the viewport while the Performance bar's
 * source is the hand (docs/PERFORMANCE_ANIMATION_PLAN.md P1.4).
 *
 * A small inset in the viewport's top-right corner: the camera frame's
 * outline (mirrored, like the mapping), the 21-point skeleton of the hand that
 * drives, its palm centre, and a state dot — grey when open, the accent colour
 * while grabbed, red while a take records. Nothing modal and nothing over the
 * picture's centre.
 *
 * ## No React render per frame
 *
 * Landmarks arrive at the camera's rate (30–60 Hz). The component renders its
 * canvas once and then draws from a `onLiveFrame` listener, coalesced to one
 * paint per animation frame, with the grab / record state read from the hand
 * source's plain state object (`handSourceState`). React only reconciles when
 * the overlay appears or disappears (bar up or down, source toggled). The
 * colours are read from the theme's tokens once on mount.
 *
 * ## Never in an export
 *
 * This is DOM chrome inside the viewport stage, like every other overlay here.
 * The engine renders exports from the document; the stage's canvases are not
 * part of its frame, so nothing drawn here can reach a render.
 */

import { useEffect, useRef } from 'react';
import { HAND_CONNECTIONS, palmCenter, sideOf } from '@core/live/gestures';
import { onLiveFrame, latestLiveFrame, type LiveFrame } from '@core/live/liveInput';
import { handSourceState } from '@providers/commands/performanceHandSource';
import { useLiveInputStore } from '@stores/liveInputStore';
import { usePerformanceStore } from '@stores/performanceStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { t } from '@core/i18n';
import styles from './HandOverlay.module.css';

/** The inset's width, CSS px; its height follows the camera's aspect. */
const INSET_W = 192;
const DEFAULT_ASPECT = 9 / 16;

interface Palette {
  frame: string;
  bone: string;
  joint: string;
  grab: string;
  record: string;
  text: string;
}

function readPalette(el: Element): Palette {
  const cs = getComputedStyle(el);
  const token = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback;
  return {
    frame: token('--color-overlay-panel-border', 'rgba(255,255,255,0.25)'),
    bone: token('--color-overlay-text', '#e6e6e6'),
    joint: token('--color-overlay-text', '#e6e6e6'),
    grab: token('--color-primary', '#4f8cff'),
    record: token('--color-danger', '#e5484d'),
    text: token('--color-overlay-text', '#e6e6e6'),
  };
}

/** Draw one frame into the inset. Exported for the tests (jsdom has no 2D context). */
export function drawHandFrame(
  ctx: CanvasRenderingContext2D,
  size: { w: number; h: number; dpr: number },
  frame: LiveFrame | null,
  state: { present: boolean; grabbed: boolean; recording: boolean; hand: 'left' | 'right' },
  mirror: boolean,
  palette: Palette,
  labels: { noHand: string; left: string; right: string },
): void {
  const { w, h, dpr } = size;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  // The camera frame.
  ctx.lineWidth = 1;
  ctx.strokeStyle = palette.frame;
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.roundRect(0.5, 0.5, w - 1, h - 1, 4);
  ctx.fill();
  ctx.stroke();

  const colour = state.recording ? palette.record : state.grabbed ? palette.grab : palette.bone;
  const hands = frame?.hands ?? [];
  if (hands.length === 0 || !state.present) {
    ctx.fillStyle = palette.text;
    ctx.globalAlpha = 0.7;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(labels.noHand, w / 2, h / 2);
    ctx.globalAlpha = 1;
  }
  const px = (nx: number): number => (mirror ? 1 - nx : nx) * w;
  const py = (ny: number): number => ny * h;
  for (const hand of hands) {
    if (hand.landmarks.length < 63) continue;
    const drives = state.present && sideOf(hand) === state.hand;
    ctx.globalAlpha = drives ? 1 : 0.35;
    ctx.strokeStyle = drives ? colour : palette.bone;
    ctx.fillStyle = drives ? colour : palette.joint;
    ctx.lineWidth = drives ? 1.5 : 1;
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.moveTo(px(hand.landmarks[a * 3]!), py(hand.landmarks[a * 3 + 1]!));
      ctx.lineTo(px(hand.landmarks[b * 3]!), py(hand.landmarks[b * 3 + 1]!));
    }
    ctx.stroke();
    for (let i = 0; i < 21; i++) {
      ctx.beginPath();
      ctx.arc(px(hand.landmarks[i * 3]!), py(hand.landmarks[i * 3 + 1]!), i === 4 || i === 8 ? 2.2 : 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
    if (drives) {
      const c = palmCenter(hand);
      ctx.beginPath();
      ctx.arc(px(c.x), py(c.y), 3.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  // State dot and the hand's side, top-left of the inset.
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(9, 9, state.recording ? 4 : 3, 0, Math.PI * 2);
  ctx.fill();
  if (state.present) {
    ctx.fillStyle = palette.text;
    ctx.globalAlpha = 0.8;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(state.hand === 'left' ? labels.left : labels.right, 17, 9);
    ctx.globalAlpha = 1;
  }
}

export function HandOverlay(): JSX.Element | null {
  const phase = usePerformanceStore((s) => s.phase);
  const source = usePreferenceStore((s) => s.performanceSource);
  const mirror = usePreferenceStore((s) => s.performanceHandMirror);
  // The camera's size decides the inset's aspect: a state change, else ≤ 4×/s.
  const camW = useLiveInputStore((s) => s.width);
  const camH = useLiveInputStore((s) => s.height);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const shown = phase !== 'off' && source === 'hand';
  const aspect = camW > 0 && camH > 0 ? camH / camW : DEFAULT_ASPECT;
  const w = INSET_W;
  const h = Math.round(INSET_W * aspect);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!shown || !canvas) return undefined;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    const palette = readPalette(canvas);
    const labels = {
      noHand: t('performance.overlay.noHand', 'No hand'),
      left: t('performance.hand.left', 'Left'),
      right: t('performance.hand.right', 'Right'),
    };
    let raf: number | null = null;
    let pending: LiveFrame | null = latestLiveFrame();
    const paint = (): void => {
      raf = null;
      const st = handSourceState();
      // State on the element for tests and styling; no React state.
      canvas.dataset.grabbed = st.grabbed ? 'true' : 'false';
      canvas.dataset.recording = st.recording ? 'true' : 'false';
      canvas.dataset.present = st.present ? 'true' : 'false';
      if (ctx) drawHandFrame(ctx, { w, h, dpr }, pending, st, mirror, palette, labels);
    };
    const schedule = (): void => {
      if (raf !== null) return;
      raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(paint) : (paint(), null);
    };
    paint();
    const offFrame = onLiveFrame((f) => {
      pending = f;
      schedule();
    });
    // The camera stopping (no more frames) still needs a repaint: the readout changes ≤ 4×/s.
    const offStatus = useLiveInputStore.subscribe((s) => {
      if (s.state !== 'running') {
        pending = null;
        schedule();
      }
    });
    return () => {
      offFrame();
      offStatus();
      if (raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
    };
  }, [shown, w, h, mirror]);

  if (!shown) return null;
  return (
    <canvas
      ref={canvasRef}
      className={styles.inset}
      style={{ width: w, height: h }}
      data-hand-overlay=""
      aria-hidden
    />
  );
}
