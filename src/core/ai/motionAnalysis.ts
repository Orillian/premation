/**
 * Motion analysis: what each move DOES on screen, as numbers.
 *
 * A still or a filmstrip shows poses; timing is the difference between
 * adjacent frames, and a model reading pictures guesses at it. This reads the
 * per-frame screen samples of every layer (motionSampling.ts: through parents
 * and the 3D camera) and reports, per move, its duration, distance, peak speed
 * and where in the move it peaks (the ease shape), overshoot and settle; across
 * moves, which elements move together, how far apart their starts are, and how
 * many things move at once. Then the rules a senior motion designer applies to
 * product-UI motion, as findings with a time and a layer name.
 *
 * Pure: no engine, no DOM. Unit-tested on synthetic samples.
 */

/** One layer at one sample time, in composition pixels as the frame shows it. */
export interface MotionFrame {
  /** Centre of the rendered box. */
  cx: number;
  cy: number;
  /** √(width · height) of the rendered box: a scale that ignores aspect changes. */
  size: number;
  /** The rendered box's width and height (absent: a square of `size`). */
  w?: number;
  h?: number;
  /** Screen rotation, degrees. */
  rotation: number;
  /** 0–100. */
  opacity: number;
}

export interface LayerSamples {
  id: string;
  name: string;
  /** One entry per `MotionInput.times`; null where the layer is not on the timeline or has no box. */
  frames: readonly (MotionFrame | null)[];
  /**
   * The top-most ANIMATED ancestor whose motion this layer inherits (a group
   * null, a rig). Children of one moving group are one thing to the eye even
   * though each travels a different distance when the group scales.
   */
  rig?: { id: string; name: string };
}

export interface MotionInput {
  /** Sample times, composition seconds, ascending. */
  times: readonly number[];
  fps: number;
  compWidth: number;
  compHeight: number;
  layers: readonly LayerSamples[];
}

export type MotionChannel = 'position' | 'scale' | 'rotation' | 'opacity';

/**
 * How the speed is distributed over a move.
 *  - ease-out: fast start, long soft landing (peak in the first third) — the UI entrance
 *  - ease-in-out: peak in the middle
 *  - ease-in: slow start, hard arrival (peak in the last third) — right for exits only
 *  - linear: a speed plateau, no acceleration
 *  - overshoot: passes its target and comes back (a spring or an overshooting bezier)
 *  - there-and-back: ends where it started (a pulse, a nudge)
 *  - drift: slow and long (ambient)
 *  - cut: the whole change happens within one sample
 */
export type EaseShape = 'ease-out' | 'ease-in-out' | 'ease-in' | 'linear' | 'overshoot' | 'there-and-back' | 'drift' | 'cut';

export interface Move {
  layerIds: string[];
  layerNames: string[];
  channel: MotionChannel;
  startSec: number;
  endSec: number;
  /** px (position), % of size (scale, signed), degrees (rotation, signed), points (opacity, signed). For there-and-back: the farthest excursion. */
  amount: number;
  /** Position only: screen direction as an arrow. */
  direction?: string;
  /** Units of `amount` per second. */
  peakSpeed: number;
  /** Where in the move the speed peaks, 0–1. */
  peakAt: number;
  /** Speed of the first / last sample of the move relative to the peak: near 1 is a start or stop at full speed. */
  startRatio: number;
  endRatio: number;
  /** How far past its target it goes, % of the move. */
  overshootPct: number;
  /** Time spent in the last 2% of the travel (and any overshoot). */
  settleSec: number;
  shape: EaseShape;
  /** It runs past both ends of the window: its ease is not measured, only that it moves. */
  clipped?: boolean;
  /** On screen and visible right before / after the move (for start / stop rules). */
  visibleBefore: boolean;
  visibleAfter: boolean;
  /** The group it moves with (LayerSamples.rig). */
  rig?: { id: string; name: string };
  /** Screen centre and box size at the move's start. */
  at: { x: number; y: number; w: number; h: number };
}

export interface MotionFinding {
  rule: 'crowd' | 'same-frame' | 'linear' | 'hard-stop' | 'too-fast' | 'too-bouncy' | 'too-slow';
  atSec: number;
  message: string;
}

export interface MotionReport {
  startSec: number;
  endSec: number;
  stepSec: number;
  fps: number;
  layersSampled: number;
  moves: Move[];
  /** The most separate units in motion at one time. */
  peakConcurrent: { count: number; atSec: number; names: string[] };
  /** Starts of units close together in time (≤ 0.5 s apart), each with its offset from the one before in frames. */
  staggers: { atSec: number; entries: { name: string; atSec: number; offsetFrames: number; cluster: string }[] }[];
  findings: MotionFinding[];
  /** Samples are further apart than ~2 frames: shape rules that need frame accuracy were skipped. */
  coarse: boolean;
}

// ── Thresholds ─────────────────────────────────────────────────────────

/** Below this speed a channel counts as still (units per second). */
const STILL: Record<MotionChannel, number> = { position: 4, scale: 0.5, rotation: 0.5, opacity: 1.5 };
/** A move smaller than this is noise. */
const MIN_AMOUNT: Record<MotionChannel, number> = { position: 2, scale: 1, rotation: 1, opacity: 3 };
/** Peak speed under which a long move is ambient drift. */
const DRIFT_SPEED: Record<MotionChannel, number> = { position: 120, scale: 10, rotation: 15, opacity: 20 };
const DRIFT_MIN_SEC = 2.5;
/** Still samples a move may pause for and remain one move (a spring's turn-around). */
const MERGE_GAP = 2;

const ARROWS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];

function arrowOf(dx: number, dy: number): string {
  const a = Math.atan2(dy, dx); // screen y points down: ↓ is +π/2
  const i = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  return ARROWS[i]!;
}

/** Shortest signed difference between two angles, degrees. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

// ── Per-layer move detection ───────────────────────────────────────────

/**
 * The channel's scalar track for a layer: position is handled as a point, the
 * others as one number (rotation unwrapped, size as log so a 2× zoom and a ½×
 * zoom are equal moves).
 */
function scalarTrack(frames: readonly (MotionFrame | null)[], channel: Exclude<MotionChannel, 'position'>): (number | null)[] {
  const out: (number | null)[] = [];
  let unwrapped = 0;
  let prevRot: number | null = null;
  for (const f of frames) {
    if (!f) { out.push(null); prevRot = null; continue; }
    if (channel === 'scale') out.push(f.size > 0.5 ? 100 * Math.log(f.size) : null);
    else if (channel === 'opacity') out.push(f.opacity);
    else {
      unwrapped = prevRot === null ? f.rotation : unwrapped + angleDelta(prevRot, f.rotation);
      prevRot = f.rotation;
      out.push(unwrapped);
    }
  }
  return out;
}

/** Speed of each interval (i-1, i), units/s; NaN where either end is missing. */
function speeds(input: MotionInput, frames: readonly (MotionFrame | null)[], channel: MotionChannel, track: (number | null)[] | null): number[] {
  const out: number[] = [NaN];
  for (let i = 1; i < frames.length; i++) {
    const dt = input.times[i]! - input.times[i - 1]!;
    if (!(dt > 0)) { out.push(NaN); continue; }
    if (channel === 'position') {
      const a = frames[i - 1], b = frames[i];
      out.push(a && b ? Math.hypot(b.cx - a.cx, b.cy - a.cy) / dt : NaN);
    } else {
      const a = track![i - 1], b = track![i];
      out.push(a !== null && a !== undefined && b !== null && b !== undefined ? Math.abs(b - a) / dt : NaN);
    }
  }
  return out;
}

/** Runs of moving intervals [i0, i1] (interval indices), merged across short pauses, split at gaps in the samples. */
function runs(sp: readonly number[], still: number): [number, number][] {
  const out: [number, number][] = [];
  let start = -1, lastMoving = -1;
  for (let i = 1; i < sp.length; i++) {
    const v = sp[i]!;
    if (Number.isNaN(v)) {
      if (start >= 0) out.push([start, lastMoving]);
      start = -1;
      continue;
    }
    if (v > still) {
      if (start < 0) start = i;
      else if (i - lastMoving - 1 > MERGE_GAP) { out.push([start, lastMoving]); start = i; }
      lastMoving = i;
    }
  }
  if (start >= 0) out.push([start, lastMoving]);
  return out;
}

/** Below this share of the move's peak speed … */
const LULL_RATIO = 0.12;
/** … for this many samples, a move has ended even though something still drifts on. */
const LULL_SAMPLES = 8;

/**
 * Split a run where the speed falls to a lull and stays there: an entrance
 * that lands inside a slow camera push never drops below the still threshold,
 * and measured as one move it reads as a 3-second crawl. Each part is judged
 * on its own — the entrance as an entrance, the tail as a drift.
 */
function splitAtLull(sp: readonly number[], [i0, i1]: [number, number]): [number, number][] {
  const out: [number, number][] = [];
  let start = i0, peak = 0, lull = 0;
  for (let i = i0; i <= i1; i++) {
    const v = sp[i]!;
    if (v > peak) { peak = v; lull = 0; continue; }
    if (v < peak * LULL_RATIO) lull++;
    else lull = 0;
    // Only a lull that a LONG slow tail follows (≥ 2× the move, ≥ 30 samples):
    // an ease-out's own settle drops below the ratio too, and stays the move's.
    const head = i - LULL_SAMPLES - start, tail = i1 - (i - LULL_SAMPLES);
    if (lull === LULL_SAMPLES && head > 0 && tail >= Math.max(30, 2 * head)) {
      out.push([start, i - LULL_SAMPLES]);
      start = i - LULL_SAMPLES + 1;
      peak = 0;
      lull = 0;
      // Restart on the tail: the next peak is measured from here.
      for (let k = start; k <= i; k++) peak = Math.max(peak, sp[k]!);
    }
  }
  out.push([start, i1]);
  return out;
}

function visibleAt(input: MotionInput, f: MotionFrame | null | undefined): boolean {
  if (!f || f.opacity <= 2 || f.size < 3) return false;
  const half = f.size / 2;
  return f.cx + half > 0 && f.cx - half < input.compWidth && f.cy + half > 0 && f.cy - half < input.compHeight;
}

function measureMove(
  input: MotionInput,
  layer: LayerSamples,
  channel: MotionChannel,
  track: (number | null)[] | null,
  sp: readonly number[],
  i0: number,
  i1: number,
): Move | null {
  const a = i0 - 1, b = i1; // sample indices of the move's ends
  const t = input.times;
  const startSec = t[a]!, endSec = t[b]!;
  const dur = endSec - startSec;
  const fa = layer.frames[a]!, fb = layer.frames[b]!;

  // Progress along the move, 0 at its start, 1 at its end.
  // `net` and `farthest` are in the track's own units (px, log-size, degrees,
  // points); `amount` converts scale to % at the end.
  const progress: number[] = [];
  let net: number, farthest = 0, direction: string | undefined;
  if (channel === 'position') {
    const dx = fb.cx - fa.cx, dy = fb.cy - fa.cy;
    const len2 = dx * dx + dy * dy;
    for (let k = a; k <= b; k++) {
      const f = layer.frames[k]!;
      const ex = f.cx - fa.cx, ey = f.cy - fa.cy;
      farthest = Math.max(farthest, Math.hypot(ex, ey));
      progress.push(len2 > 0 ? (ex * dx + ey * dy) / len2 : 0);
    }
    net = Math.sqrt(len2);
    direction = arrowOf(dx, dy);
  } else {
    const va = track![a]!, vb = track![b]!;
    net = vb - va;
    for (let k = a; k <= b; k++) {
      const v = track![k]!;
      farthest = Math.max(farthest, Math.abs(v - va));
      progress.push(net !== 0 ? (v - va) / net : 0);
    }
  }
  const thereAndBack = Math.abs(net) < 0.25 * farthest;
  const signed = thereAndBack ? farthest : net;
  const amount = channel === 'scale' ? 100 * (Math.exp(signed / 100) - 1) : signed;
  if (Math.abs(amount) < MIN_AMOUNT[channel]) return null;

  let peak = 0, peakIdx = i0, plateau = 0;
  for (let i = i0; i <= i1; i++) {
    const v = sp[i]!;
    if (v > peak) { peak = v; peakIdx = i; }
  }
  for (let i = i0; i <= i1; i++) if (sp[i]! >= 0.85 * peak) plateau++;
  const intervals = i1 - i0 + 1;
  const peakMid = (t[peakIdx - 1]! + t[peakIdx]!) / 2;
  const peakAt = dur > 0 ? (peakMid - startSec) / dur : 0;
  // Speed is per scalar unit: for scale, log-size units are ≈ % per second.
  const peakSpeed = peak;

  let overshootPct = 0, settleSec = 0;
  if (!thereAndBack) {
    overshootPct = Math.max(0, (Math.max(...progress) - 1) * 100);
    const k = progress.findIndex((p) => p >= 0.98);
    settleSec = k >= 0 ? endSec - t[a + k]! : 0;
  }

  let shape: EaseShape;
  if (intervals <= 1) shape = 'cut';
  else if (thereAndBack) shape = 'there-and-back';
  else if (overshootPct >= 1.5) shape = 'overshoot';
  else if (dur >= DRIFT_MIN_SEC && peak < DRIFT_SPEED[channel]) shape = 'drift';
  else if (intervals >= 5 && plateau / intervals >= 0.55) shape = 'linear';
  else if (peakAt < 0.35) shape = 'ease-out';
  else if (peakAt > 0.65) shape = 'ease-in';
  else shape = 'ease-in-out';

  return {
    layerIds: [layer.id],
    layerNames: [layer.name],
    channel,
    startSec,
    endSec,
    amount,
    ...(direction && !thereAndBack ? { direction } : {}),
    peakSpeed,
    peakAt,
    startRatio: peak > 0 ? sp[i0]! / peak : 0,
    endRatio: peak > 0 ? sp[i1]! / peak : 0,
    overshootPct,
    settleSec,
    shape,
    ...(a === 0 && b === layer.frames.length - 1 && dur >= 1 ? { clipped: true } : {}),
    visibleBefore: a > 0 && visibleAt(input, layer.frames[a - 1]),
    visibleAfter: b < layer.frames.length - 1 && visibleAt(input, layer.frames[b + 1]),
    ...(layer.rig ? { rig: layer.rig } : {}),
    at: { x: fa.cx, y: fa.cy, w: fa.w ?? fa.size, h: fa.h ?? fa.size },
  };
}

export function layerMoves(input: MotionInput, layer: LayerSamples): Move[] {
  const out: Move[] = [];
  for (const channel of ['position', 'scale', 'rotation', 'opacity'] as const) {
    const track = channel === 'position' ? null : scalarTrack(layer.frames, channel);
    const sp = speeds(input, layer.frames, channel, track);
    for (const run of runs(sp, STILL[channel])) {
      for (const [i0, i1] of splitAtLull(sp, run)) {
        const m = measureMove(input, layer, channel, track, sp, i0, i1);
        if (m) out.push(m);
      }
    }
  }
  return out;
}

// ── Across layers ──────────────────────────────────────────────────────

/**
 * Layers that make the SAME move (same channel, same frames, same amount and
 * direction) are one unit: a card and its label moving under one parent are
 * one thing to the eye, and counting them twice would call every grouped
 * entrance "everything moves at once".
 */
function groupMoves(moves: readonly Move[], fps: number): Move[] {
  const byKey = new Map<string, Move>();
  for (const m of moves) {
    // Children of one moving group: one line per channel and window, whatever
    // distance each child travels (a scaled group moves its edges furthest).
    const key = m.rig
      ? [m.channel, `rig:${m.rig.id}`, Math.round(m.startSec * fps)].join('|')
      : [m.channel, Math.round(m.startSec * fps), Math.round(m.endSec * fps), Math.round(m.amount), m.direction ?? '', m.shape].join('|');
    const g = byKey.get(key);
    if (g) {
      g.layerIds.push(...m.layerIds);
      g.layerNames.push(...m.layerNames);
      // The child that travels furthest speaks for the group; the group ends when its last child settles.
      if (Math.abs(m.amount) > Math.abs(g.amount)) Object.assign(g, { amount: m.amount, direction: m.direction, peakSpeed: m.peakSpeed, peakAt: m.peakAt, shape: m.shape, overshootPct: m.overshootPct, settleSec: m.settleSec });
      g.endSec = Math.max(g.endSec, m.endSec);
    } else byKey.set(key, { ...m, layerIds: [...m.layerIds], layerNames: [...m.layerNames] });
  }
  return [...byKey.values()].sort((x, y) => x.startSec - y.startSec || x.channel.localeCompare(y.channel));
}

/** A unit is a set of layers moving together; its label for the report. */
function unitKey(m: Move): string {
  return m.rig ? `rig:${m.rig.id}` : [...m.layerIds].sort().join(',');
}

export function unitName(m: Move): string {
  const n = m.layerNames;
  if (m.rig) return n.length === 1 ? `'${n[0]}' (in '${m.rig.name}')` : `'${m.rig.name}' (${n.length} layers)`;
  return n.length <= 2 ? n.map((x) => `'${x}'`).join(' + ') : `'${n[0]}' + ${n.length - 1} more`;
}

/** Units starting within this long of each other, one inside the other, read as ONE thing entering. */
const CLUSTER_SEC = 0.12;

/** The same move a few frames apart (an avatar row popping in, a list sliding up) is ONE gesture — a cascade. */
const CASCADE_SEC = 0.35;

/** What a move is, independent of where and when: channel, direction, distance (10 px buckets) and length (0.1 s buckets). */
function signature(m: Move): string {
  return `${m.channel}|${m.direction ?? ''}|${Math.round(Math.abs(m.amount) / 10)}|${Math.round((m.endSec - m.startSec) * 10)}`;
}

/** Does `outer`'s box (at its start) hold `inner`'s centre? A label on its card, an icon in its row. */
function holds(outer: Move['at'], inner: Move['at']): boolean {
  return Math.abs(inner.x - outer.x) <= outer.w / 2 && Math.abs(inner.y - outer.y) <= outer.h / 2;
}

/**
 * Units that start together in the same place, as one visual element: what the
 * crowding and same-frame rules count. Union of every pair whose first starts
 * are within CLUSTER_SEC and where one's box holds the other's centre (a list
 * row's background, icon and label are one row; two rows are two).
 */
function clustersOf(moves: readonly Move[]): Map<string, string> {
  const first = new Map<string, Move>();
  for (const m of moves) {
    if (!active(m)) continue;
    const k = unitKey(m);
    const f = first.get(k);
    if (!f || m.startSec < f.startSec) first.set(k, m);
  }
  const keys = [...first.keys()];
  const parent = new Map(keys.map((k) => [k, k] as const));
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = first.get(keys[i]!)!, b = first.get(keys[j]!)!;
      const nested = Math.abs(a.startSec - b.startSec) <= CLUSTER_SEC && (holds(a.at, b.at) || holds(b.at, a.at));
      const cascade = Math.abs(a.startSec - b.startSec) <= CASCADE_SEC && signature(a) === signature(b);
      if (nested || cascade) parent.set(find(keys[i]!), find(keys[j]!));
    }
  }
  return new Map(keys.map((k) => [k, find(k)] as const));
}

const active = (m: Move): boolean => m.shape !== 'drift';

function concurrency(moves: readonly Move[], times: readonly number[], clusters: Map<string, string>): MotionReport['peakConcurrent'] {
  let best = { count: 0, atSec: times[0] ?? 0, names: [] as string[] };
  for (let i = 1; i < times.length; i++) {
    const mid = (times[i - 1]! + times[i]!) / 2;
    const units = new Map<string, string>();
    for (const m of moves) {
      if (!active(m) || m.shape === 'cut' || mid < m.startSec || mid > m.endSec) continue;
      const c = clusters.get(unitKey(m)) ?? unitKey(m);
      if (!units.has(c)) units.set(c, unitName(m));
    }
    if (units.size > best.count) best = { count: units.size, atSec: times[i - 1]!, names: [...units.values()] };
  }
  return best;
}

function staggersOf(moves: readonly Move[], fps: number, clusters: Map<string, string>): MotionReport['staggers'] {
  // First start of each unit per cluster: a unit's position and opacity starting together is one start.
  const starts = new Map<string, { at: number; name: string; cluster: string }>();
  for (const m of moves) {
    if (!active(m)) continue;
    const key = `${unitKey(m)}@${Math.round(m.startSec * fps)}`;
    if (!starts.has(key)) starts.set(key, { at: m.startSec, name: unitName(m), cluster: clusters.get(unitKey(m)) ?? unitKey(m) });
  }
  const sorted = [...starts.values()].sort((a, b) => a.at - b.at);
  const out: MotionReport['staggers'] = [];
  let cur: { at: number; name: string; cluster: string }[] = [];
  const flush = (): void => {
    if (cur.length >= 2) {
      out.push({
        atSec: cur[0]!.at,
        entries: cur.map((s, i) => ({ name: s.name, atSec: s.at, cluster: s.cluster, offsetFrames: i === 0 ? 0 : Math.round((s.at - cur[i - 1]!.at) * fps) })),
      });
    }
  };
  for (const s of sorted) {
    if (cur.length && s.at - cur[cur.length - 1]!.at > 0.5) { flush(); cur = []; }
    cur.push(s);
  }
  flush();
  return out;
}

const fmtS = (s: number): string => `${s.toFixed(2)}s`;

function rules(report: Omit<MotionReport, 'findings'>): MotionFinding[] {
  const out: MotionFinding[] = [];
  const { moves, fps, coarse } = report;
  const frames = (s: number): number => Math.round(s * fps);

  if (report.peakConcurrent.count > 4) {
    out.push({
      rule: 'crowd',
      atSec: report.peakConcurrent.atSec,
      message: `${report.peakConcurrent.count} separate things move at once at ${fmtS(report.peakConcurrent.atSec)} (${report.peakConcurrent.names.slice(0, 5).join(', ')}${report.peakConcurrent.names.length > 5 ? ', …' : ''}). The eye follows one or two: lead with the hero, hold or delay the rest.`,
    });
  }

  for (const s of report.staggers) {
    // Parts of one visual element (one cluster) starting together is not a missing stagger.
    let run = new Map<string, string>([[s.entries[0]!.cluster, s.entries[0]!.name]]);
    let at = s.entries[0]!.atSec;
    const emit = (): void => {
      const names = [...run.values()];
      if (names.length >= 3) out.push({ rule: 'same-frame', atSec: at, message: `${names.length} elements start on the same frame at ${fmtS(at)} (${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''}): stagger them 2–4 frames apart, in reading order.` });
    };
    for (const e of s.entries.slice(1)) {
      if (e.offsetFrames === 0) { if (!run.has(e.cluster)) run.set(e.cluster, e.name); continue; }
      emit();
      run = new Map([[e.cluster, e.name]]);
      at = e.atSec;
    }
    emit();
  }

  for (const m of moves) {
    if (m.channel === 'opacity' || m.shape === 'drift' || m.shape === 'cut' || m.clipped) continue;
    const who = unitName(m);
    const what = m.channel === 'position' ? `moves ${Math.round(Math.abs(m.amount))}px` : m.channel === 'scale' ? `scales ${m.amount > 0 ? '+' : ''}${Math.round(m.amount)}%` : `turns ${Math.round(m.amount)}°`;
    const span = `${fmtS(m.startSec)}–${fmtS(m.endSec)}`;
    if (m.shape === 'linear') {
      out.push({ rule: 'linear', atSec: m.startSec, message: `${who} ${what} at constant speed (${span}): linear motion reads mechanical. Ease it — a strong ease-out for an arrival (bezier [0.16,1,0.3,1]) or a spring.` });
    }
    if (!coarse && m.visibleAfter && m.endRatio >= 0.6 && m.shape !== 'linear') {
      out.push({ rule: 'hard-stop', atSec: m.endSec, message: `${who} ${what} and stops dead at ${fmtS(m.endSec)} (last frame still at ${Math.round(m.endRatio * 100)}% of its peak speed) while staying on screen: give the arrival an ease-out or a small settle.` });
    }
    // No hard-START rule: a strong ease-out (the UI entrance and iOS's snap)
    // leaves at full speed by design; only the arrival gives a move away.
    const dur = m.endSec - m.startSec;
    if (!coarse && m.channel === 'position' && Math.abs(m.amount) >= 40 && frames(dur) <= 3) {
      out.push({ rule: 'too-fast', atSec: m.startSec, message: `${who} ${what} in ${frames(dur)} frame(s) at ${fmtS(m.startSec)}: too fast to read as motion. UI moves sit at ~150–500 ms; give it at least 6–8 frames or make it a cut on purpose.` });
    }
    if (m.overshootPct > 12 && m.channel !== 'rotation') {
      out.push({ rule: 'too-bouncy', atSec: m.startSec, message: `${who} overshoots ${Math.round(m.overshootPct)}% at ${fmtS(m.startSec)}: playful, but too bouncy for product UI (2–6% reads as mass).` });
    }
    if ((m.channel === 'position' && Math.abs(m.amount) < 600 && dur > 1.2) || (m.channel === 'scale' && Math.abs(m.amount) < 60 && dur > 1.4)) {
      out.push({ rule: 'too-slow', atSec: m.startSec, message: `${who} ${what} over ${dur.toFixed(2)}s (${span}): slow for an interface element. If it is UI, ~0.3–0.6 s; if it is a camera-like drift, keep it and ignore this.` });
    }
  }
  return out;
}

/** Everything, from the samples. */
export function analyzeMotion(input: MotionInput): MotionReport {
  const t = input.times;
  const raw: Move[] = [];
  for (const layer of input.layers) raw.push(...layerMoves(input, layer));
  const moves = groupMoves(raw, input.fps);
  const clusters = clustersOf(moves);
  const stepSec = t.length > 1 ? (t[t.length - 1]! - t[0]!) / (t.length - 1) : 0;
  const base: Omit<MotionReport, 'findings'> = {
    startSec: t[0] ?? 0,
    endSec: t[t.length - 1] ?? 0,
    stepSec,
    fps: input.fps,
    layersSampled: input.layers.length,
    moves,
    peakConcurrent: concurrency(moves, t, clusters),
    staggers: staggersOf(moves, input.fps, clusters),
    coarse: stepSec > 2.5 / Math.max(1, input.fps),
  };
  const order: MotionFinding['rule'][] = ['crowd', 'same-frame', 'linear', 'hard-stop', 'too-fast', 'too-bouncy', 'too-slow'];
  const findings = rules(base).sort((a, b) => order.indexOf(a.rule) - order.indexOf(b.rule) || a.atSec - b.atSec);
  return { ...base, findings };
}

// ── The report as text ────────────────────────────────────────────────

function amountText(m: Move): string {
  switch (m.channel) {
    case 'position': return `${Math.round(Math.abs(m.amount))}px${m.direction ? ` ${m.direction}` : ''}`;
    case 'scale': return `${m.amount > 0 ? '+' : ''}${Math.round(m.amount)}%`;
    case 'rotation': return `${m.amount > 0 ? '+' : ''}${Math.round(m.amount)}°`;
    case 'opacity': return `${m.amount > 0 ? '+' : ''}${Math.round(m.amount)}`;
  }
}

function speedText(m: Move): string {
  const unit = m.channel === 'position' ? 'px/s' : m.channel === 'scale' ? '%/s' : m.channel === 'rotation' ? '°/s' : '/s';
  return `${Math.round(m.peakSpeed)}${unit}`;
}

export function formatMotionReport(r: MotionReport, o: { maxMoves?: number; maxFindings?: number } = {}): string {
  const maxMoves = o.maxMoves ?? 60;
  const maxFindings = o.maxFindings ?? 25;
  const stepFrames = Math.max(1, Math.round(r.stepSec * r.fps));
  const lines: string[] = [
    `Motion ${fmtS(r.startSec)}–${fmtS(r.endSec)}, sampled every ${stepFrames === 1 ? 'frame' : `${stepFrames} frames`} at ${r.fps} fps, in screen pixels (through parents and the 3D camera). ${r.layersSampled} layer(s) sampled, ${r.moves.length} move(s); layers that move identically are one unit.`,
  ];
  if (r.coarse) lines.push('Samples are more than 2 frames apart here: dead-stop and too-fast checks were skipped. Call analyze_motion on a shorter window for frame accuracy.');

  if (r.moves.length) {
    lines.push('', 'Moves — window, frames, unit, channel, amount, peak speed @ where in the move, shape, overshoot, settle:');
    const shown = r.moves.slice(0, maxMoves);
    for (const m of shown) {
      const f = Math.round((m.endSec - m.startSec) * r.fps);
      const extra = [
        m.overshootPct >= 0.5 ? `overshoot ${m.overshootPct.toFixed(1)}%` : '',
        m.settleSec > 0 && m.shape !== 'cut' ? `settle ${m.settleSec.toFixed(2)}s` : '',
      ].filter(Boolean).join(', ');
      lines.push(`- ${fmtS(m.startSec)}–${fmtS(m.endSec)} ${f}f ${unitName(m)} ${m.channel} ${amountText(m)}, peak ${speedText(m)} @${Math.round(m.peakAt * 100)}%, ${m.shape}${extra ? `, ${extra}` : ''}`);
    }
    if (r.moves.length > shown.length) lines.push(`- … ${r.moves.length - shown.length} more (narrow the window or pass nodeIds)`);
  } else {
    lines.push('', 'Nothing moves on screen in this window.');
  }

  if (r.staggers.length) {
    lines.push('', 'Choreography — starts close together (offset from the previous start, frames):');
    for (const s of r.staggers.slice(0, 12)) {
      lines.push(`- ${fmtS(s.atSec)}: ${s.entries.map((e, i) => (i === 0 ? e.name : `+${e.offsetFrames}f ${e.name}`)).join(' · ')}`);
    }
  }
  if (r.peakConcurrent.count > 0) lines.push(`Most at once: ${r.peakConcurrent.count} unit(s) moving at ${fmtS(r.peakConcurrent.atSec)}.`);

  lines.push('');
  if (r.findings.length) {
    lines.push('Findings:');
    for (const f of r.findings.slice(0, maxFindings)) lines.push(`- ${f.message}`);
    if (r.findings.length > maxFindings) lines.push(`- … ${r.findings.length - maxFindings} more`);
  } else {
    lines.push('Findings: none — no linear, dead-stop, crowded or same-frame motion measured.');
  }
  return lines.join('\n');
}
