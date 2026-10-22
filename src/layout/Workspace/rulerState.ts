/**
 * The comp viewer's ruler state that is NOT the document: where the pointer
 * is (the markers on both rulers), each comp's ruler origin (the zero point,
 * dragged out of the corner as in After Effects), the unit, and an in-flight
 * origin drag. Editor state, so it never enters the project; the origin and
 * unit last for the session.
 *
 * Module state rather than a store: only the viewport's painter and its
 * pointer handlers read it, and every write is followed by the viewport's own
 * `requestRender` — nothing in React follows it.
 */

import type { RulerUnit } from './rulerGeometry';

export interface RulerPoint {
  x: number;
  y: number;
}

let pointer: RulerPoint | null = null;
let unit: RulerUnit = 'px';
let originDrag: RulerPoint | null = null;
const origins = new Map<string, RulerPoint>();
const ZERO: RulerPoint = { x: 0, y: 0 };

/** The pointer in overlay (CSS px) space, or null while it is off the viewer. */
export const rulerPointer = (): RulerPoint | null => pointer;
/** True when the pointer marker moved (the caller repaints). */
export function setRulerPointer(p: RulerPoint | null): boolean {
  if (p === pointer || (p && pointer && p.x === pointer.x && p.y === pointer.y)) return false;
  pointer = p;
  return true;
}

export const rulerUnit = (): RulerUnit => unit;
export function setRulerUnit(next: RulerUnit): void {
  unit = next;
}

/** A comp's ruler origin in comp px; (0, 0) — the comp's top-left — until moved. */
export const rulerOrigin = (compId: string | null | undefined): RulerPoint =>
  (compId ? origins.get(compId) : undefined) ?? ZERO;
export function setRulerOrigin(compId: string, p: RulerPoint): void {
  if (p.x === 0 && p.y === 0) origins.delete(compId);
  else origins.set(compId, { x: p.x, y: p.y });
}
export function resetRulerOrigin(compId: string): void {
  origins.delete(compId);
}
export const hasRulerOrigin = (compId: string | null | undefined): boolean => !!compId && origins.has(compId);

/** The zero point being dragged out of the corner (overlay px), or null. */
export const rulerOriginDrag = (): RulerPoint | null => originDrag;
export function setRulerOriginDrag(p: RulerPoint | null): void {
  originDrag = p;
}
