/**
 * "Undo Claude's last change" from the activity panel — but only when the
 * newest history entry IS Claude's. A user who edited after Claude would
 * otherwise lose their own edit to a button that promised Claude's.
 */

import type { EngineClient } from '@motion/engine-api';

export type ClaudeUndoResult = { ok: true; label: string } | { ok: false; reason: string };

/** Claude's entries are labelled `Claude: …` and made with origin `ai` (mcpHost). */
export function isClaudeEntry(e: { label: string; origin?: string } | undefined): boolean {
  return !!e && e.label.startsWith('Claude:') && (e.origin === undefined || e.origin === 'ai');
}

export async function undoLastClaudeStep(client: EngineClient): Promise<ClaudeUndoResult> {
  const h = await client.query({ type: 'getHistory' });
  if (!h.ok) return { ok: false, reason: 'The history is not available.' };
  if (h.value.gestureOpen) return { ok: false, reason: 'Claude is in the middle of a change — Stop it first.' };
  const top = h.value.entries[h.value.position - 1];
  if (!isClaudeEntry(top)) return { ok: false, reason: 'The last change is yours, not Claude\'s — use Edit ▸ Undo.' };
  const r = await client.execute({ type: 'undo' }, { origin: 'ui' });
  return r.ok ? { ok: true, label: top!.label } : { ok: false, reason: r.error.message || 'Undo failed.' };
}
