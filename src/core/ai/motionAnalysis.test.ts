import { analyzeMotion, formatMotionReport, type LayerSamples, type MotionFrame, type MotionInput } from './motionAnalysis';
import { sampleTimes } from './motionSampling';

const FPS = 60;
const times = (start: number, end: number): number[] => sampleTimes(start, end, FPS, 10_000);

/** A layer whose centre follows `x(t)` along y = 540 (null outside [from, to)). */
function layer(id: string, x: (t: number) => number, ts: readonly number[], o: { from?: number; to?: number; y?: number; size?: number } = {}): LayerSamples {
  const frames: (MotionFrame | null)[] = ts.map((t) =>
    t < (o.from ?? -Infinity) || t >= (o.to ?? Infinity) ? null : { cx: x(t), cy: o.y ?? 540, size: o.size ?? 200, rotation: 0, opacity: 100 },
  );
  return { id, name: id, frames };
}

/** A move of `px` pixels from x 400 between t0 and t1 shaped by `ease(u)`. */
const move = (t0: number, t1: number, px: number, ease: (u: number) => number) => (t: number): number => {
  const u = Math.max(0, Math.min(1, (t - t0) / (t1 - t0)));
  return 400 + px * ease(u);
};

const input = (ts: number[], layers: LayerSamples[]): MotionInput => ({ times: ts, fps: FPS, compWidth: 1920, compHeight: 1080, layers });

const linear = (u: number): number => u;
const easeOutCubic = (u: number): number => 1 - (1 - u) ** 3;
const easeInCubic = (u: number): number => u ** 3;
/** easeOutBack with s = 2.6: ≈ 20% overshoot. */
const backOut = (u: number): number => {
  const s = 2.6;
  const v = u - 1;
  return 1 + (s + 1) * v ** 3 + s * v ** 2;
};

describe('analyzeMotion: one move', () => {
  const ts = times(0, 2);

  it('measures a linear move and flags it', () => {
    const r = analyzeMotion(input(ts, [layer('Card', move(0.5, 1, 300, linear), ts)]));
    expect(r.moves).toHaveLength(1);
    const m = r.moves[0]!;
    expect(m).toMatchObject({ channel: 'position', shape: 'linear', direction: '→' });
    expect(m.amount).toBeCloseTo(300, 0);
    expect(m.startSec).toBeCloseTo(0.5, 2);
    expect(m.endSec).toBeCloseTo(1, 2);
    expect(m.peakSpeed).toBeCloseTo(600, -1);
    expect(r.findings.map((f) => f.rule)).toEqual(['linear']);
  });

  it('reads a cubic ease-out as ease-out with no findings', () => {
    const r = analyzeMotion(input(ts, [layer('Card', move(0.5, 1, 300, easeOutCubic), ts)]));
    const m = r.moves[0]!;
    expect(m.shape).toBe('ease-out');
    expect(m.peakAt).toBeLessThan(0.2);
    expect(m.endRatio).toBeLessThan(0.1);
    expect(m.settleSec).toBeGreaterThan(0.1);
    expect(r.findings).toEqual([]);
  });

  it('measures overshoot and calls 20% too bouncy for UI', () => {
    const r = analyzeMotion(input(ts, [layer('Toggle', move(0.5, 1, 200, backOut), ts)]));
    const m = r.moves[0]!;
    expect(m.shape).toBe('overshoot');
    expect(m.overshootPct).toBeGreaterThan(15);
    expect(m.overshootPct).toBeLessThan(25);
    expect(r.findings.map((f) => f.rule)).toContain('too-bouncy');
  });

  it('calls an ease-in arrival that stays on screen a dead stop, but not an exit that leaves', () => {
    const stays = analyzeMotion(input(ts, [layer('Card', move(0.5, 1, 300, easeInCubic), ts)]));
    expect(stays.moves[0]!.shape).toBe('ease-in');
    expect(stays.findings.map((f) => f.rule)).toEqual(['hard-stop']);
    // Off the right edge after the move: an exit may leave at full speed.
    const exits = analyzeMotion(input(ts, [layer('Card', move(0.5, 1, 2000, easeInCubic), ts)]));
    expect(exits.findings.map((f) => f.rule)).not.toContain('hard-stop');
  });

  it('treats a slow, long move as drift and says nothing about it', () => {
    const long = times(0, 6);
    const r = analyzeMotion(input(long, [layer('Bg', move(0, 6, 120, linear), long)]));
    expect(r.moves[0]!.shape).toBe('drift');
    expect(r.findings).toEqual([]);
  });

  it('calls a move that ends where it started there-and-back', () => {
    const r = analyzeMotion(input(ts, [layer('Badge', move(0.5, 1, 80, (u) => Math.sin(Math.PI * u)), ts)]));
    expect(r.moves[0]).toMatchObject({ shape: 'there-and-back' });
    expect(r.moves[0]!.amount).toBeCloseTo(80, 0);
  });

  it('reads a layer cut in (no samples before its in point) as no move', () => {
    const r = analyzeMotion(input(ts, [layer('Pop', () => 960, ts, { from: 1 })]));
    expect(r.moves).toEqual([]);
  });
});

describe('analyzeMotion: choreography', () => {
  const ts = times(0, 2);

  it('groups layers that move identically into one unit', () => {
    const r = analyzeMotion(input(ts, [
      layer('Card', move(0.5, 1, 300, easeOutCubic), ts),
      layer('Card label', move(0.5, 1, 300, easeOutCubic), ts, { y: 600 }),
    ]));
    expect(r.moves).toHaveLength(1);
    expect(r.moves[0]!.layerNames).toEqual(['Card', 'Card label']);
  });

  it('flags three elements starting on the same frame and reports stagger offsets in frames', () => {
    const same = analyzeMotion(input(ts, ['A', 'B', 'C'].map((n, i) => layer(n, move(0.5, 1, 100 + 50 * i, easeOutCubic), ts, { y: 200 + 200 * i }))));
    expect(same.findings.map((f) => f.rule)).toContain('same-frame');

    const staggered = analyzeMotion(input(ts, ['A', 'B', 'C'].map((n, i) => layer(n, move(0.5 + (i * 3) / FPS, 1 + (i * 3) / FPS, 100 + 50 * i, easeOutCubic), ts, { y: 200 + 200 * i }))));
    expect(staggered.findings.map((f) => f.rule)).not.toContain('same-frame');
    expect(staggered.staggers[0]!.entries.map((e) => e.offsetFrames)).toEqual([0, 3, 3]);
  });

  it('flags more than four things moving at once', () => {
    const r = analyzeMotion(input(ts, Array.from({ length: 6 }, (_, i) => layer(`L${i}`, move(0.4 + (i * 4) / FPS, 1.2, 100 + 30 * i, easeOutCubic), ts, { y: 100 + 150 * i }))));
    expect(r.peakConcurrent.count).toBe(6);
    expect(r.findings[0]!.rule).toBe('crowd');
  });

  it('skips frame-accuracy rules on coarse samples and says so', () => {
    const coarse = sampleTimes(0, 2, FPS, 12);
    const r = analyzeMotion(input(coarse, [layer('Card', move(0.5, 1, 300, easeInCubic), coarse)]));
    expect(r.coarse).toBe(true);
    expect(r.findings.map((f) => f.rule)).not.toContain('hard-stop');
    expect(formatMotionReport(r)).toMatch(/more than 2 frames apart/);
  });
});

describe('formatMotionReport', () => {
  it('lists each move with frames, amount, speed, shape and the findings', () => {
    const ts = times(0, 2);
    const text = formatMotionReport(analyzeMotion(input(ts, [layer('Card', move(0.5, 1, 300, linear), ts)])));
    expect(text).toMatch(/sampled every frame at 60 fps/);
    expect(text).toMatch(/0\.50s–1\.00s 30f 'Card' position 300px →, peak 6\d\dpx\/s @\d+%, linear/);
    expect(text).toMatch(/Findings:\n- 'Card' moves 300px at constant speed/);
  });
});

describe('sampleTimes', () => {
  it('samples every frame of a short window and thins a long one evenly', () => {
    expect(sampleTimes(1, 2, 30, 900)).toHaveLength(31);
    const long = sampleTimes(0, 60, 60, 900);
    expect(long.length).toBeLessThanOrEqual(901);
    expect(long[1]! - long[0]!).toBeCloseTo(4 / 60, 6);
  });
});
