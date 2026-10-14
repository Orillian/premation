/**
 * The crosshair beside a camera's Focus Distance (camera program U6): arms a
 * one-shot "pick focus on canvas" — the next click on a layer in the
 * viewport puts this camera's focal plane on it (focusPickStore.ts; the
 * viewport takes the click in useWorkspace). Pressed while armed; a second
 * press or Esc cancels (the store owns the Esc listener).
 *
 * Drawn like the row's other in-label toggle (Scale's constrain lock), so it
 * reads as part of the Focus Distance row rather than as a separate verb.
 */

import { Icon } from '@components/Icon';
import { useFocusPickStore } from '@layout/Workspace/focusPickStore';
import styles from './TransformSection.module.css';

export function FocusPickButton({ nodeId }: { nodeId: string }): JSX.Element {
  const armed = useFocusPickStore((s) => s.camera === nodeId);
  return (
    <button
      type="button"
      className={armed ? `${styles.lockToggle} ${styles.lockToggleActive}` : styles.lockToggle}
      title={armed ? 'Click a layer in the viewer to focus on it (Esc cancels)' : 'Pick focus on canvas: click a layer in the viewer'}
      aria-label="Pick focus on canvas"
      aria-pressed={armed}
      onClick={() => {
        const s = useFocusPickStore.getState();
        if (armed) s.cancel();
        else s.arm(nodeId);
      }}
    >
      <Icon name="crosshair" size="sm" />
    </button>
  );
}

export default FocusPickButton;
