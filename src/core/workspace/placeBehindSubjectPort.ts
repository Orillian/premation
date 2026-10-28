/**
 * The seam the Assistant's `place_behind_subject` tool calls through. The
 * edit itself lives with the editor (layout/Workspace/placeBehindSubject*.ts:
 * it reorders layers and drives the Object Matte tool), which src/core must
 * not import; the editor registers it here when it loads.
 */

export type PlaceBehindSubjectOutcome =
  | { ok: true; subject: string; matte: 'kept' | 'made' | 'pending'; frames?: number }
  | { ok: false; message: string };

export type PlaceBehindSubjectRun = (
  layers: readonly string[],
  opts: { point?: { x: number; y: number } },
) => Promise<PlaceBehindSubjectOutcome>;

let run: PlaceBehindSubjectRun | null = null;

export function registerPlaceBehindSubject(fn: PlaceBehindSubjectRun | null): void {
  run = fn;
}

export function placeBehindSubject(layers: readonly string[], opts: { point?: { x: number; y: number } } = {}): Promise<PlaceBehindSubjectOutcome> {
  if (!run) return Promise.resolve({ ok: false, message: 'Place Behind Subject is not available in this editor.' });
  return run(layers, opts);
}
