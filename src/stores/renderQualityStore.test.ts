/**
 * Adaptive Resolution â€” the viewport degrades during a drag that is measured
 * slow, and not otherwise. A drag on a comp that renders inside budget keeps
 * full quality; that is the whole point of the `slowInteract` gate.
 */

import { useRenderQualityStore, effectiveResolutionOf, bindAdaptiveResolution } from './renderQualityStore';

beforeEach(() => {
  useRenderQualityStore.setState({ resolution: 1, adaptive: true, adaptiveFloor: 2, interacting: false, slowInteract: false, draft: false });
});

describe('effectiveResolutionOf', () => {
  it('is the chosen resolution while idle', () => {
    expect(effectiveResolutionOf({ resolution: 1, adaptive: true, adaptiveFloor: 2, interacting: false })).toBe(1);
  });
  it('a drag alone does NOT degrade â€” the comp renders fast enough', () => {
    expect(effectiveResolutionOf({ resolution: 1, adaptive: true, adaptiveFloor: 2, interacting: true })).toBe(1);
  });
  it('drops to the floor while interacting AND measured slow', () => {
    expect(effectiveResolutionOf({ resolution: 1, adaptive: true, adaptiveFloor: 2, interacting: true, slowInteract: true })).toBe(2);
  });
  it('slowInteract without a live drag does not degrade', () => {
    expect(effectiveResolutionOf({ resolution: 1, adaptive: true, adaptiveFloor: 2, interacting: false, slowInteract: true })).toBe(1);
  });
  it('never gives MORE than the user chose', () => {
    // Quarter chosen, Half floor, dragging slow â†’ stays Quarter.
    expect(effectiveResolutionOf({ resolution: 4, adaptive: true, adaptiveFloor: 2, interacting: true, slowInteract: true })).toBe(4);
  });
  it('does nothing when adaptive is off', () => {
    expect(effectiveResolutionOf({ resolution: 1, adaptive: false, adaptiveFloor: 4, interacting: true, slowInteract: true })).toBe(1);
  });
});

describe('interact auto-quality', () => {
  it('degrades after two over-budget drag frames, not after one hitch', () => {
    const s = useRenderQualityStore.getState();
    s.setInteracting(true);
    s.reportInteractFrame(50, 30);
    expect(useRenderQualityStore.getState().slowInteract).toBe(false);
    s.reportInteractFrame(50, 30);
    expect(useRenderQualityStore.getState().slowInteract).toBe(true);
    expect(useRenderQualityStore.getState().effectiveResolution()).toBe(2);
  });

  it('a fast frame in between resets the count', () => {
    const s = useRenderQualityStore.getState();
    s.reportInteractFrame(50, 30); s.reportInteractFrame(5, 30); s.reportInteractFrame(50, 30);
    expect(useRenderQualityStore.getState().slowInteract).toBe(false);
  });

  it('stays sticky across drags and restores after a long cheap run', () => {
    const s = useRenderQualityStore.getState();
    s.reportInteractFrame(50, 30); s.reportInteractFrame(50, 30);
    expect(useRenderQualityStore.getState().slowInteract).toBe(true);
    // Drag ends and a new one begins â€” still degraded, no re-measure jank.
    s.setInteracting(false);
    s.setInteracting(true);
    expect(useRenderQualityStore.getState().slowInteract).toBe(true);
    for (let i = 0; i < 30; i++) s.reportInteractFrame(5, 30);
    expect(useRenderQualityStore.getState().slowInteract).toBe(false);
  });

  it('does nothing when adaptive is off', () => {
    useRenderQualityStore.getState().setAdaptive(false);
    for (let i = 0; i < 5; i++) useRenderQualityStore.getState().reportInteractFrame(100, 30);
    expect(useRenderQualityStore.getState().slowInteract).toBe(false);
    useRenderQualityStore.getState().setAdaptive(true);
  });
});

describe('bindAdaptiveResolution', () => {
  beforeEach(() => useRenderQualityStore.setState({ slowInteract: true }));

  it('degrades on drag start (comp known slow) and releases a frame after drag end', () => {
    jest.useFakeTimers();
    let emit: (d: boolean) => void = () => {};
    const unbind = bindAdaptiveResolution((cb) => { emit = cb; return () => {}; });
    emit(true);
    expect(useRenderQualityStore.getState().effectiveResolution()).toBe(2);
    emit(false);
    // Still degraded inside the debounce windowâ€¦
    expect(useRenderQualityStore.getState().effectiveResolution()).toBe(2);
    jest.advanceTimersByTime(40);
    expect(useRenderQualityStore.getState().effectiveResolution()).toBe(1);
    unbind();
    jest.useRealTimers();
  });

  it('a quick re-grab inside the window never renders full-res in between', () => {
    jest.useFakeTimers();
    let emit: (d: boolean) => void = () => {};
    const seen: number[] = [];
    const unsub = useRenderQualityStore.subscribe((s) => seen.push(s.effectiveResolution()));
    const unbind = bindAdaptiveResolution((cb) => { emit = cb; return () => {}; });
    emit(true); emit(false); jest.advanceTimersByTime(10); emit(true);
    jest.advanceTimersByTime(100);
    expect(seen).not.toContain(1);
    unbind(); unsub();
    jest.useRealTimers();
  });

  it('the render key changes with the effective resolution', () => {
    const idle = useRenderQualityStore.getState().key();
    useRenderQualityStore.getState().setInteracting(true);
    expect(useRenderQualityStore.getState().key()).not.toBe(idle);
  });
});

describe('playback auto-quality (A1: no pumping)', () => {
  const FPS = 30;
  const BUDGET = 1000 / FPS;
  /** A simulated playback clock: frames reported at the comp's rate from `t0`. */
  const play = (t0 = 0) => {
    const s = useRenderQualityStore.getState();
    s.setSlowPlayback(false);
    s.notePlaybackStart(t0);
    let t = t0;
    let switches = 0;
    let last = useRenderQualityStore.getState().slowPlayback;
    let lastSwitch = Number.NaN;
    const frame = (slow: boolean): void => {
      t += BUDGET;
      useRenderQualityStore.getState().reportPlaybackFrame(slow ? BUDGET * 2 : BUDGET / 4, BUDGET, t);
      const cur = useRenderQualityStore.getState().slowPlayback;
      if (cur !== last) { switches++; last = cur; lastSwitch = t; }
    };
    const seconds = (n: number, slow: boolean | ((i: number) => boolean)): void => {
      const count = Math.round(n * FPS);
      for (let i = 0; i < count; i++) frame(typeof slow === 'function' ? slow(i) : slow);
    };
    return { frame, seconds, switches: () => switches, now: () => t, lastSwitch: () => lastSwitch, degraded: () => useRenderQualityStore.getState().slowPlayback };
  };

  beforeEach(() => useRenderQualityStore.getState().setSlowPlayback(false));

  it('three slow frames (a hitch) do not degrade; eight slow of the last twelve do', () => {
    const p = play();
    p.seconds(2.5, false);  // past the warm-up
    p.frame(true); p.frame(true); p.frame(true);
    expect(p.degraded()).toBe(false);
    for (let i = 0; i < 5; i++) p.frame(true);
    expect(p.degraded()).toBe(true);
    expect(useRenderQualityStore.getState().effectiveResolution()).toBe(2);
  });

  it('ignores the first two seconds after play starts (cold caches)', () => {
    const p = play();
    p.seconds(1.9, true);
    expect(p.degraded()).toBe(false);
    p.seconds(1, true);
    expect(p.degraded()).toBe(true);
  });

  it('a seek restarts the warm-up', () => {
    const p = play();
    p.seconds(3, false);
    useRenderQualityStore.getState().notePlaybackStart(p.now());
    p.seconds(1.5, true);
    expect(p.degraded()).toBe(false);
  });

  it('the Samurai pattern — bursty drops in seconds 0–8, clean after — switches at most once in 20 s', () => {
    const p = play();
    // Bursts of six dropped frames every 1.3 s (≈ 40 drops in the first 8 s).
    p.seconds(8, (i) => i % 40 < 6);
    p.seconds(12, false);
    expect(p.switches()).toBeLessThanOrEqual(1);
  });

  it('a comp that is slow for five seconds straight still degrades, once', () => {
    const p = play();
    p.seconds(5, true);
    expect(p.degraded()).toBe(true);
    expect(p.switches()).toBe(1);
  });

  it('restores no sooner than the minimum switch gap after a degrade, and only after a long cheap run', () => {
    const p = play();
    p.seconds(3, true);
    expect(p.degraded()).toBe(true);
    const degradedAt = p.lastSwitch();
    // Cheap at once — but the restore waits.
    while (p.now() - degradedAt < 9_900) p.frame(false);
    expect(p.degraded()).toBe(true);
    p.seconds(0.3, false);
    expect(p.degraded()).toBe(false);
    expect(p.switches()).toBe(2);
  });

  it('backs off: full resolution that does not hold doubles the next restore wait past the gap', () => {
    const p = play();
    const waitForRestore = (): number => {
      const from = p.now();
      while (p.degraded() && p.now() - from < 120_000) p.frame(false);
      return p.now() - from;
    };
    p.seconds(3, true);                    // degrade #1 (delay 3 s → gap 10 s applies)
    expect(waitForRestore()).toBeLessThan(10_500);
    p.seconds(10.5, true);                 // degrade #2 within 20 s of the restore → delay 6 s (gap still 10 s)
    expect(p.degraded()).toBe(true);
    expect(waitForRestore()).toBeLessThan(10_500);
    p.seconds(10.5, true);                 // degrade #3 → delay 12 s: longer than the gap now
    expect(p.degraded()).toBe(true);
    const third = waitForRestore();
    expect(third).toBeGreaterThan(11_500);
    expect(third).toBeLessThan(12_500);
    // Stopping playback resets the back-off.
    useRenderQualityStore.getState().setSlowPlayback(false);
    const q = play(p.now());
    q.seconds(3, true);
    expect(waitForRestoreOn(q)).toBeLessThan(10_500);
  });

  const waitForRestoreOn = (p: ReturnType<typeof play>): number => {
    const from = p.now();
    while (p.degraded() && p.now() - from < 120_000) p.frame(false);
    return p.now() - from;
  };

  it('never more than one switch per ten seconds, however the frames fall', () => {
    const p = play();
    // Alternate 1 s slow / 1 s fast for a minute.
    const stamps: number[] = [];
    let last = p.degraded();
    for (let i = 0; i < 60 * FPS; i++) {
      p.frame(Math.floor(i / FPS) % 2 === 0);
      if (p.degraded() !== last) { last = p.degraded(); stamps.push(p.now()); }
    }
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]! - stamps[i - 1]!).toBeGreaterThanOrEqual(10_000);
  });

  it('does nothing when adaptive is off', () => {
    useRenderQualityStore.getState().setAdaptive(false);
    const p = play();
    p.seconds(5, true);
    expect(p.degraded()).toBe(false);
    useRenderQualityStore.getState().setAdaptive(true);
  });
});
