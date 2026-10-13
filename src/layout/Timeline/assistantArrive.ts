/**
 * Which timeline rows should ease in.
 *
 * A row is "new" the first time the timeline sees its id. That fade runs only
 * while an assistant is working, so opening a project or scrolling a
 * virtualized row back into view does not replay it. Ids are remembered for
 * the session: a row that mounts, unmounts and mounts again stays still.
 */

const known = new Set<string>();

/**
 * True while `id` should fade in. An idle row is remembered immediately.
 * A row that appears during assistant work stays "new" until `assistantSeen`,
 * so React StrictMode's remount still plays the fade once.
 */
export function assistantArriving(id: string): boolean {
  if (known.has(id)) return false;
  const working = typeof document !== 'undefined' && document.documentElement.dataset.assistant === 'working';
  if (!working) {
    known.add(id);
    return false;
  }
  return true;
}

export function assistantSeen(ids: Iterable<string>): void {
  for (const id of ids) known.add(id);
}

export function resetAssistantArrivals(): void {
  known.clear();
}
