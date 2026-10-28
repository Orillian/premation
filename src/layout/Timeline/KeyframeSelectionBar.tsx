/**
 * The bar that floats over the lanes while keyframes are selected: the eases
 * people actually use, Reverse, and To playhead, one click each.
 *
 * Every one of these already existed — F9 and its Shift/Ctrl variants, the
 * diamond's right-click Keyframe Interpolation submenu, Animation ▸
 * Time-Reverse Keyframes — and that was the problem users reported: the
 * timeline was hard to drive because every verb was behind a chord you had to
 * know or a menu you had to find. Selecting keys is the moment you want them,
 * so that is when they appear, next to what you selected.
 *
 * - The button matching the selection's ease is lit (read from the document
 *   mirror, so it follows undo and edits made elsewhere); Hold toggles.
 * - Keys on a locked layer disable the actions and say why.
 * - A drag that starts elsewhere fades the bar and lets the pointer through,
 *   so a marquee or a key drag can cross it.
 * - Arrow keys / Home / End move between the buttons (the toolbar pattern).
 *
 * It renders on selection and mirror changes for the selected layers only;
 * playback never touches it. The playhead time is read at click time.
 */

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@components/Button';
import { IconButton } from '@components/IconButton';
import { Icon, type IconName } from '@components/Icon';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorKeys } from '@hooks/useMirror';
import { useUIStore } from '@stores/uiStore';
import { parseSelectionKey, resolveSelectionKey } from '@core/mirror/keySelection';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { asCommandId } from '@app-types/common';
import { setKeyInterpolationEdit } from '@layout/Menu/appEdits';
import { cn } from '@utils/cn';
import { t } from '@core/i18n';
import { alignKeyframesToTime, easePresetOnKeys, linearSidesOnKeys, reverseKeyframesUi } from './keyframeEdits';
import { activeEase, keyEaseFacts, toolbarStep, type BarEase, type KeyEaseFacts } from './keySelectionSummary';
import styles from './Timeline.module.css';

const selected = (): string[] => [...useKeyframeSelectionStore.getState().ids];

/** Pointer travel (px) before a press elsewhere counts as a drag that should pass under the bar. */
const DRAG_SLOP = 4;

function BarButton({ icon, label, title, onClick, disabled, pressed }: {
  icon: IconName;
  label: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
}): JSX.Element {
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={<Icon name={icon} size="sm" />}
      title={title}
      aria-label={label}
      aria-pressed={pressed}
      className={cn(pressed && styles.keySelOn)}
      onClick={onClick}
      disabled={disabled}
    >
      <span className={styles.keySelLabel}>{label}</span>
    </Button>
  );
}

interface Summary {
  /** Distinct engine keys that still exist. */
  keys: number;
  layers: number;
  locked: boolean;
  ease: BarEase | null;
}

/** The selection as it stands in the document (stale ids — keys since deleted — drop out). */
function summarize(ids: ReadonlySet<string>): Summary {
  const m = documentMirror();
  const seen = new Set<string>();
  const layers = new Set<string>();
  const facts: KeyEaseFacts[] = [];
  let locked = false;
  for (const id of ids) {
    const hit = resolveSelectionKey(m, id);
    if (!hit) continue;
    const k = `${hit.sel.layer}\u0000${hit.sel.keyId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    layers.add(hit.sel.layer);
    if (m.layer(hit.sel.layer)?.switches.locked) locked = true;
    facts.push(keyEaseFacts(hit.keys[hit.index - 1], hit.key, hit.keys[hit.index + 1]));
  }
  return { keys: seen.size, layers: layers.size, locked, ease: activeEase(facts) };
}

export const KeyframeSelectionBar = memo(function KeyframeSelectionBar({ playheadTime }: {
  /** The playhead now, in comp seconds — read when "To playhead" is clicked. */
  playheadTime: () => number;
}): JSX.Element | null {
  const ids = useKeyframeSelectionStore((s) => s.ids);
  // Re-read when the selected layers' keys or switches change (undo, an ease
  // applied from F9 or the graph, a lock) — and only for those layers.
  const watch = useMemo(() => {
    const layers = new Set<string>();
    for (const id of ids) {
      const layer = parseSelectionKey(id)?.layer;
      if (layer) layers.add(layer);
    }
    return [...layers].flatMap((l) => [`keys:${l}`, `layer:${l}`]);
  }, [ids]);
  const rev = useMirrorKeys(watch);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `rev` is the mirror's change signal for `watch`
  const sum = useMemo(() => summarize(ids), [ids, rev]);

  // A drag that started elsewhere passes under the bar.
  const barRef = useRef<HTMLDivElement | null>(null);
  const [passThrough, setPassThrough] = useState(false);
  const active = ids.size > 0;
  useEffect(() => {
    if (!active) return undefined;
    let start: { x: number; y: number } | null = null;
    const down = (e: PointerEvent): void => {
      start = barRef.current?.contains(e.target as Node) ? null : { x: e.clientX, y: e.clientY };
    };
    const move = (e: PointerEvent): void => {
      if (start && e.buttons !== 0 && Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG_SLOP) {
        start = null;
        setPassThrough(true);
      }
    };
    const up = (): void => { start = null; setPassThrough(false); };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
  }, [active]);

  // One Tab stop; the arrows move within (the WAI-ARIA toolbar pattern).
  const [focusIndex, setFocusIndex] = useState(0);
  useLayoutEffect(() => {
    const buttons = barRef.current?.querySelectorAll('button');
    if (!buttons || buttons.length === 0) return;
    let stop = Math.min(focusIndex, buttons.length - 1);
    if (buttons[stop]!.disabled) stop = [...buttons].findIndex((b) => !b.disabled);
    buttons.forEach((b, i) => { b.tabIndex = i === stop ? 0 : -1; });
  });
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const buttons = [...(barRef.current?.querySelectorAll('button') ?? [])];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = toolbarStep(current < 0 ? 0 : current, e.key, buttons.map((b) => !b.disabled));
    if (next < 0) return;
    e.preventDefault();
    e.stopPropagation();
    setFocusIndex(next);
    buttons[next]!.focus();
  };

  if (sum.keys === 0) return null;
  const off = sum.locked;
  const lockedTitle = t('timeline.keySelection.lockedTitle', 'A selected keyframe is on a locked layer — unlock it to edit');
  const tip = (title: string): string => (off ? lockedTitle : title);

  const toPlayhead = async (): Promise<void> => {
    const res = await alignKeyframesToTime(selected(), playheadTime());
    if (!res.moved || res.replaced === 0) return;
    useUIStore.getState().notify({
      level: 'warning',
      message: res.replaced === 1
        ? t('timeline.keySelection.replacedOne', 'Moved to the playhead — it replaced 1 keyframe there')
        : t('timeline.keySelection.replacedOther', 'Moved to the playhead — it replaced {n} keyframes there', { n: res.replaced }),
      durationMs: 6000,
      action: {
        label: t('timeline.keySelection.undo', 'Undo'),
        onSelect: () => { void getCommandSystem().execute(asCommandId('edit.undo')); },
      },
    });
  };

  return (
    <div className={styles.keySelDock}>
      <div
        ref={barRef}
        className={cn(styles.keySelBar, passThrough && styles.keySelPassThrough)}
        role="toolbar"
        aria-label={t('timeline.keySelection.label', 'Selected keyframes')}
        onKeyDown={onKeyDown}
        // The lanes under it start marquees and deselect on pointer-down.
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span className={styles.keySelCount} aria-live="polite">
          {off ? <Icon name="lock" size="sm" aria-label={lockedTitle} /> : null}
          {sum.keys === 1
            ? t('timeline.keySelection.countOne', '1 key')
            : t('timeline.keySelection.countOther', '{n} keys', { n: sum.keys })}
          {sum.layers > 1 ? (
            <span className={styles.keySelLayers}>
              {t('timeline.keySelection.layers', '· {n} layers', { n: sum.layers })}
            </span>
          ) : null}
        </span>
        <BarButton
          icon="ease"
          label={t('timeline.keyframeMenu.easyEase', 'Easy Ease')}
          title={tip(t('timeline.graph.easyEaseTitle', 'Easy Ease (F9)'))}
          pressed={sum.ease === 'Ease'}
          disabled={off}
          onClick={() => { void easePresetOnKeys(selected(), 'Ease'); }}
        />
        <BarButton
          icon="arrow-right"
          label={t('timeline.keySelection.in', 'In')}
          title={tip(t('timeline.graph.easyEaseInTitle', 'Easy Ease In (Shift+F9)'))}
          pressed={sum.ease === 'EaseIn'}
          disabled={off}
          onClick={() => { void easePresetOnKeys(selected(), 'EaseIn'); }}
        />
        <BarButton
          icon="arrow-left"
          label={t('timeline.keySelection.out', 'Out')}
          title={tip(t('timeline.graph.easyEaseOutTitle', 'Easy Ease Out (Ctrl+Shift+F9)'))}
          pressed={sum.ease === 'EaseOut'}
          disabled={off}
          onClick={() => { void easePresetOnKeys(selected(), 'EaseOut'); }}
        />
        <BarButton
          icon="minus"
          label={t('timeline.keyframeMenu.linear', 'Linear')}
          title={tip(t('timeline.keySelection.linearTitle', 'Linear interpolation'))}
          pressed={sum.ease === 'Linear'}
          disabled={off}
          onClick={() => { void linearSidesOnKeys(selected()); }}
        />
        <BarButton
          icon="square"
          label={t('timeline.keyframeMenu.hold', 'Hold')}
          title={tip(sum.ease === 'Hold'
            ? t('timeline.keySelection.holdOffTitle', 'Hold is on — click to interpolate again')
            : t('timeline.keySelection.holdTitle', 'Hold: the value jumps at the next keyframe'))}
          pressed={sum.ease === 'Hold'}
          disabled={off}
          onClick={() => {
            void (sum.ease === 'Hold'
              ? linearSidesOnKeys(selected())
              : setKeyInterpolationEdit(selected(), 'hold', 'Enable hold keyframe'));
          }}
        />
        <span className={styles.keySelDivider} aria-hidden />
        <BarButton
          icon="skip-back"
          label={t('timeline.keySelection.reverse', 'Reverse')}
          title={tip(sum.keys < 2
            ? t('timeline.keySelection.reverseNeedsTwo', 'Select at least two keyframes to reverse them')
            : t('timeline.keySelection.reverseTitle', 'Time-reverse the selected keyframes'))}
          disabled={off || sum.keys < 2}
          onClick={() => { void reverseKeyframesUi(selected()); }}
        />
        <BarButton
          icon="align-left"
          label={t('timeline.keySelection.toPlayhead', 'To playhead')}
          title={tip(t('timeline.keySelection.toPlayheadTitle', 'Move the selection so its first keyframe sits on the playhead'))}
          disabled={off}
          onClick={() => { void toPlayhead(); }}
        />
        <IconButton
          variant="ghost"
          size="sm"
          aria-label={t('timeline.keySelection.clear', 'Deselect keyframes')}
          onClick={() => useKeyframeSelectionStore.getState().clear()}
        >
          <Icon name="close" size="sm" />
        </IconButton>
      </div>
    </div>
  );
});
