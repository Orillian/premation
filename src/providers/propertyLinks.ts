/**
 * Edit ▸ Copy with Property Links (After Effects, Ctrl+Alt+C).
 *
 * Copied LAYERS paste as copies whose every numeric property follows the
 * original — the engine's `linkProperty` writes AE's own pick-whip expression
 * on each member track, so the link is ordinary, visible and removable.
 * Copied PROPERTY ROWS paste onto the selected layers: each layer's same
 * property follows the copied one.
 *
 * Only properties the engine can link are sent (numeric members on both
 * sides, same type and dimensions), so one unlinkable property never sinks
 * the whole paste.
 */

import type { Command, PropRef } from '@motion/engine-api';
import type { MirrorTreeLike } from '@core/mirror/trackIndex';
import { membersOf } from '@core/mirror/trackIndex';

/** The properties of `tree` a link can drive: numeric, animatable, not a path. */
export function linkablePaths(tree: MirrorTreeLike | undefined): string[] {
  if (!tree) return [];
  const out: string[] = [];
  for (const [path, info] of tree.nodes) {
    if (info.kind !== 'property' || !info.animatable || info.valueType === 'path') continue;
    if (membersOf(info).length === 0) continue;
    out.push(path);
  }
  return out;
}

/** Whether `a` and `b` describe properties one can follow the other. */
function compatible(tree: MirrorTreeLike, other: MirrorTreeLike, path: string): boolean {
  const a = tree.nodes.get(path);
  const b = other.nodes.get(path);
  return !!a && !!b && a.valueType === b.valueType && a.dimensions === b.dimensions && membersOf(a).length === membersOf(b).length;
}

/**
 * The `linkProperty` commands that make `follower` follow `leader` on every
 * path in `paths` both layers carry. Pure: the trees come from the mirror.
 */
export function linkCommands(
  leader: MirrorTreeLike,
  follower: MirrorTreeLike,
  paths: readonly string[],
): Command[] {
  const cmds: Command[] = [];
  for (const path of paths) {
    if (!compatible(leader, follower, path)) continue;
    const prop: PropRef = { layer: follower.layer, path };
    const target: PropRef = { layer: leader.layer, path };
    cmds.push({ type: 'linkProperty', prop, target });
  }
  return cmds;
}
