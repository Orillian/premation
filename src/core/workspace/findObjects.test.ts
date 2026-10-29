import { objectAt, type FoundObject } from './rotoBrushTool';

/** A rectangle as a found object (layer px). */
function box(x0: number, y0: number, x1: number, y1: number, area: number): FoundObject {
  return { outline: [x0, y0, x1, y0, x1, y1, x0, y1], seed: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, area, bounds: { x0, y0, x1, y1 } };
}

describe('the Object Matte hover finds the object under the pointer without the model', () => {
  const person = box(-100, -200, 100, 200, 0.08);
  const phone = box(-20, -40, 20, 0, 0.004);  // held in front of the person
  const bench = box(200, 100, 400, 200, 0.05);

  it('picks the object whose outline holds the point', () => {
    expect(objectAt([person, bench], { x: 300, y: 150 })).toBe(bench);
    expect(objectAt([person, bench], { x: 0, y: 150 })).toBe(person);
  });

  it('prefers the smaller of two overlapping objects (the thing in front)', () => {
    expect(objectAt([person, phone], { x: 0, y: -20 })).toBe(phone);
    expect(objectAt([phone, person], { x: 0, y: -20 })).toBe(phone);
  });

  it('answers null on empty background', () => {
    expect(objectAt([person, phone, bench], { x: 500, y: -500 })).toBeNull();
  });
});
