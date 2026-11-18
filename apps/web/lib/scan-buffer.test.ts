import { describe, expect, it } from 'vitest';
import { ScanBuffer } from './scan-buffer';

const feed = (gaps: number[], code: string, enterGap: number) => { const b = new ScanBuffer(); let t = 1000; const firsts: number[] = [];
  [...code].forEach((c, i) => { t += i === 0 ? 5000 : gaps[i - 1] ?? 10; if (b.char(c, t)) firsts.push(i); }); t += enterGap; return { code: b.enter(t), firsts }; };

describe('scanner burst detection', () => {
  it('reads an even burst', () => { expect(feed([], '762210096759', 10)).toEqual({ code: '762210096759', firsts: [0] }); expect(feed([], '1234', 10).code).toBe('1234'); });
  it('keeps the whole code when the first keys lag (slow computer)', () => {
    expect(feed([120], '762210096759', 10).code).toBe('762210096759');          // the case from the shop: the first gap is slow
    expect(feed([90, 70], '6221134032963', 10).code).toBe('6221134032963');
    expect(feed([10, 10, 150, 10, 10, 60, 10, 80], '5283001200911', 30).code).toBe('5283001200911');   // three slow gaps, long code
  });
  it('leaves a person typing alone', () => {
    const human = (s: string) => feed([...s].map(() => 140), s, 180).code;
    expect(human('1234')).toBeNull(); expect(human('03123456')).toBeNull(); expect(human('pepsi 2l')).toBeNull(); expect(human('762210096759')).toBeNull();
    expect(feed([120, 110], '123', 10).code).toBeNull();                         // short and slow: not a scan
    expect(feed([120], '12345', 10).code).toBeNull();                            // one slow gap needs six characters
  });
  it('a pause starts a new code: nothing from before leaks in', () => {
    const b = new ScanBuffer(); let t = 0; for (const c of 'abc') { t += 10; b.char(c, t); } t += 2000;
    for (const c of '4006381333931') { t += 8; b.char(c, t); } expect(b.enter(t + 8)).toBe('4006381333931');
  });
});
