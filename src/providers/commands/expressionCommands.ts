/**
 * Add / Remove / Enable-Disable Expression as registry commands (AE's
 * Animation ▸ Add Expression, Alt+Shift+=) over the engine (B4 round 7).
 *
 * The targets are the focused inspector row or the timeline's selected
 * property rows (`expressionTargets`); each track's expression is read off the
 * document mirror (`trackExpressionFacts`, per member for an unseparated
 * vector) and every action is ONE engine batch of `setExpression`
 * (`inspectorEdits.expressionCommands`). Add attaches AE's default `value` and
 * asks the first row's inline editor to open.
 */

import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import type { PropertyRef } from '@stores/propertySelectionStore';
import {
  ADD_EXPRESSION_COMMAND,
  DEFAULT_EXPRESSION,
  expressionTargets,
  requestExpressionEditor,
} from '@core/animation/expressionEditorRequests';
import { edit } from '@core/engine/uiEdits';
import { trackExpressionFacts, type MemberExpressionFacts } from '@core/mirror/memberExpressions';
import { documentMirror } from '@stores/documentMirror';
import { useLayoutStore } from '@stores/layoutStore';
import { useSelectionStore } from '@stores/selectionStore';
import { expressionCommands } from '@layout/Inspector/inspectorEdits';
import { canCopyExpression, copyExpressionOnlyEdit } from '../clipboardEdits';

interface Row {
  ref: PropertyRef;
  facts: MemberExpressionFacts | null;
}

function rows(refs: ReadonlyArray<PropertyRef>): Row[] {
  const m = documentMirror();
  return refs.map((ref) => ({ ref, facts: trackExpressionFacts(m, ref.nodeId, ref.prop) }));
}

async function send(label: string, pairs: Array<{ nodeId: string; track: string; source: string }>, enabled: boolean): Promise<boolean> {
  const cmds = pairs.length > 0 ? expressionCommands(pairs, enabled) : null;
  if (!cmds || cmds.length === 0) return false;
  return (await edit(label, cmds)).ok;
}

function reveal(ref: PropertyRef): void {
  const selection = useSelectionStore.getState();
  if (!selection.ids.includes(ref.nodeId)) selection.set([ref.nodeId]);
  try {
    useLayoutStore.getState().openPanel('properties');
  } catch {
    /* headless: no layout to open */
  }
  requestExpressionEditor(ref);
}

/** Attach `value` to every target with none (one entry) and open the first target's editor. */
export async function addExpressionEdit(refs: ReadonlyArray<PropertyRef>, opts: { openEditor?: boolean } = {}): Promise<number> {
  const fresh = rows(refs).filter((r) => r.facts === null);
  if (fresh.length > 0) {
    await send(fresh.length === 1 ? 'Add Expression' : 'Add Expressions',
      fresh.map((r) => ({ nodeId: r.ref.nodeId, track: r.ref.prop, source: DEFAULT_EXPRESSION })), true);
  }
  const first = refs[0];
  if (first && opts.openEditor !== false) reveal(first);
  return fresh.length;
}

/** Drop every target's expression (one entry). */
export async function removeExpressionEdit(refs: ReadonlyArray<PropertyRef>): Promise<number> {
  const had = rows(refs).filter((r) => r.facts !== null);
  if (had.length === 0) return 0;
  await send(had.length === 1 ? 'Remove Expression' : 'Remove Expressions',
    had.map((r) => ({ nodeId: r.ref.nodeId, track: r.ref.prop, source: '' })), false);
  return had.length;
}

/** Enable every attached expression if any is off, else disable them all; the source is kept. */
export async function toggleExpressionEdit(refs: ReadonlyArray<PropertyRef>): Promise<boolean | null> {
  const had = rows(refs).filter((r) => r.facts !== null);
  if (had.length === 0) return null;
  const enable = had.some((r) => r.facts?.enabled === false);
  await send(enable ? 'Enable Expression' : 'Disable Expression',
    had.map((r) => ({ nodeId: r.ref.nodeId, track: r.ref.prop, source: r.facts!.source })), enable);
  return enable;
}

/**
 * Alt-click on a stopwatch (After Effects): a property with an expression
 * loses it; one without gets `value` and its editor opens — through `open`
 * when the surface has its own editor (the timeline's floating one), else the
 * Properties panel's row.
 */
export async function altClickStopwatchEdit(refs: ReadonlyArray<PropertyRef>, open?: (ref: PropertyRef) => void): Promise<void> {
  await documentMirror().loadTrees(refs.map((r) => r.nodeId));
  if (rows(refs).some((r) => r.facts !== null)) {
    await removeExpressionEdit(refs);
    return;
  }
  await addExpressionEdit(refs, { openEditor: open === undefined });
  const first = refs[0];
  if (first && open) open(first);
}

const anyHas = (): boolean => rows(expressionTargets()).some((r) => r.facts !== null);

export function buildExpressionCommands(): ReadonlyArray<Command> {
  return [
    {
      id: asCommandId(ADD_EXPRESSION_COMMAND),
      label: 'Add Expression',
      description: 'Add an expression to the selected property and open its editor',
      // AE's chord. `=` resolves from e.code 'Equal', so Shift's `+` (and
      // macOS Option's `±`) still match — see `chordKeyFromEvent`.
      shortcut: { key: '=', alt: true, shift: true },
      enabled: () => expressionTargets().length > 0,
      execute: () => {
        void addExpressionEdit(expressionTargets());
      },
    },
    {
      id: asCommandId('edit.copyExpressionOnly'),
      label: 'Copy Expression Only',
      description: 'Copy the selected property’s expression, without its keyframes or value',
      enabled: canCopyExpression,
      execute: () => {
        void copyExpressionOnlyEdit();
      },
    },
    {
      id: asCommandId('anim.removeExpression'),
      label: 'Remove Expression',
      description: 'Remove the expression from the selected property',
      enabled: anyHas,
      execute: () => {
        void removeExpressionEdit(expressionTargets());
      },
    },
    {
      id: asCommandId('anim.toggleExpression'),
      label: 'Enable/Disable Expression',
      description: 'Turn the selected property’s expression on or off, keeping its source',
      enabled: anyHas,
      execute: () => {
        void toggleExpressionEdit(expressionTargets());
      },
    },
  ];
}
