import { describe, expect, it } from 'vitest';
import { levelsOf, levelsTable } from '../photo-tidy';

const hist = (f: (i: number) => number) => { const h = new Array(256).fill(0).map((_, i) => f(i)); return { h, total: h.reduce((a, b) => a + b, 0) }; };
describe('tidying an item photo on the device', () => {
  it('a dim photo is stretched and its middle lifted', () => {
    const { h, total } = hist(i => (i >= 20 && i <= 120 ? 1 : 0));      // everything between 20 and 120: dark, low contrast
    const l = levelsOf(h, total);
    expect(l.lo).toBeGreaterThanOrEqual(20); expect(l.lo).toBeLessThanOrEqual(22);
    expect(l.hi).toBe(180);                                               // the white point is not pulled below 180: lifted, not burnt
    expect(l.gamma).toBeLessThan(1);
    const t = levelsTable(l); expect(t[20]).toBe(0); expect(t[70]).toBeGreaterThan(70); expect(t[255]).toBe(255);
  });
  it('a photo that is already fine stays as it is', () => {
    const { h, total } = hist(() => 1);                                   // spread over the whole range
    const l = levelsOf(h, total); expect(l.gamma).toBe(1);
    const t = levelsTable(l); expect(Math.abs(t[128] - 128)).toBeLessThanOrEqual(4);
  });
  it('a nearly flat photo is not blown up into noise', () => {
    const { h, total } = hist(i => (i >= 200 && i <= 215 ? 1 : 0));
    expect(levelsOf(h, total)).toMatchObject({ lo: 0, hi: 255 });
  });
});
