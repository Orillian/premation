/**
 * Bring the applied-effect stack on screen after an add.
 *
 * The stack lives in ONE place: the left-sidebar Effect Controls panel (AE's).
 * Properties carried a second copy of it as an "Effects" section; that copy is
 * gone (owner 2026-10-14) — two stacks of the same cards, and opening the
 * Properties tab after every add pushed the Effects & Presets tab you were
 * browsing out of its group.
 *
 * `openPanel` is a no-op for an unknown id, so this is safe in tests that
 * never register the panel.
 */

import { useLayoutStore } from '@stores/layoutStore';
import { groupOfPanel } from '@core/layout/dockGroups';
import type { EffectType } from '@core/inspector/effectCatalog';
import { addEffectEdit } from './effectEdits';

export function revealEffectControls(): void {
  useLayoutStore.getState().openPanel('effectControls');
}

/**
 * After an add: bring Effect Controls forward — unless it shares a dock group
 * with the Effects & Presets browser, where fronting it would hide the browser
 * mid-browse. Then the add stays put and the stack is one tab away.
 */
export function revealAppliedEffects(): void {
  const s = useLayoutStore.getState();
  const groups = [...s.dockGroups.leftSidebar, ...s.dockGroups.rightInspector];
  const browser = groupOfPanel(groups, 'effects');
  const controls = groupOfPanel(groups, 'effectControls');
  if (browser && controls && browser.id === controls.id) return;
  s.openPanel('effectControls');
}

/** Add an effect to a layer or several (ONE engine entry) and bring its parameters on screen. */
export function addEffectAndReveal(nodeIds: string | readonly string[], type: EffectType): void {
  void addEffectEdit(typeof nodeIds === 'string' ? [nodeIds] : nodeIds, type);
  revealAppliedEffects();
}
