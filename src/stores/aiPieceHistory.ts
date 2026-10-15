/**
 * The last pieces the AI made in this editor, as fingerprints (@motion/author
 * variety.ts): fed to the next run so it knows what it just made, and to the
 * SAME_AS_LAST check. Newest first, at most eight.
 *
 * Editor state, not document state: it lives in this machine's local storage
 * (a per-user convenience), never in a project. Unavailable storage (a
 * private window, tests) = an empty history held in memory.
 */

import type { PieceFingerprint, PieceHistory } from '@motion/author';

const KEY = 'premation.aiPieceHistory.v1';
const MAX = 8;

let memory: PieceFingerprint[] | null = null;

function isFingerprint(v: unknown): v is PieceFingerprint {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  return typeof f.title === 'string' && typeof f.value === 'string' && typeof f.hue === 'string'
    && typeof f.medium === 'string' && typeof f.camera === 'string' && typeof f.lit === 'boolean';
}

function load(): PieceFingerprint[] {
  if (memory) return memory;
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    memory = Array.isArray(parsed) ? parsed.filter(isFingerprint).slice(0, MAX) : [];
  } catch {
    memory = [];
  }
  return memory;
}

export const aiPieceHistory: PieceHistory = {
  recent: () => load(),
  record: (fp) => {
    memory = [fp, ...load()].slice(0, MAX);
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(memory));
    } catch {
      // Storage full or blocked: the history still holds for this session.
    }
  },
};

/** Tests: forget everything. */
export function resetAiPieceHistory(): void {
  memory = null;
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}
