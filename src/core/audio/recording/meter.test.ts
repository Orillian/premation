import { createMeter, meterFraction, METER_FLOOR_DB, METER_HOLD_MS, resetClip, updateMeter } from './meter';

describe('input meter', () => {
  it('attacks instantly and falls smoothly', () => {
    const m = createMeter(1);
    updateMeter(m, [0.5], 1000);
    expect(m.channels[0]!.levelDb).toBeCloseTo(-6.02, 1);
    updateMeter(m, [0], 1500);
    // 24 dB/s for 0.5 s.
    expect(m.channels[0]!.levelDb).toBeCloseTo(-18.02, 1);
  });

  it('holds the peak, then lets it fall', () => {
    const m = createMeter(1);
    updateMeter(m, [1], 1000);
    updateMeter(m, [0.01], 1000 + METER_HOLD_MS - 10);
    expect(m.channels[0]!.holdDb).toBe(0);
    updateMeter(m, [0.01], 1000 + METER_HOLD_MS + 990);
    expect(m.channels[0]!.holdDb).toBeLessThan(0);
  });

  it('latches a clip until reset', () => {
    const m = createMeter(2);
    updateMeter(m, [0.2, 0.999], 10);
    updateMeter(m, [0, 0], 20);
    expect(m.channels.map((c) => c.clipped)).toEqual([false, true]);
    resetClip(m);
    expect(m.channels[1]!.clipped).toBe(false);
  });

  it('maps dB to the bar', () => {
    expect(meterFraction(0)).toBe(1);
    expect(meterFraction(METER_FLOOR_DB)).toBe(0);
    expect(meterFraction(-30)).toBeCloseTo(0.5);
  });
});
