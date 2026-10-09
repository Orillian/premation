/**
 * The playhead readout in the status bar. Written straight to its text node
 * on every clock tick (LiveTimecode) — a React render per played frame, even
 * of a leaf, was a text replacement + layout + full repaint each frame (U1).
 */

import { LiveTimecode } from '@layout/Timeline/LiveTimecode';
import styles from './EditorStatusBar.module.css';

export function StatusBarTimecode({ fps, startFrame }: { fps: number; startFrame: number }): JSX.Element {
  return <LiveTimecode fps={fps} startFrame={startFrame} className={styles.mono} />;
}
