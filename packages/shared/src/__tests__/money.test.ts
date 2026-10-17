import { describe, it, expect } from 'vitest';
import { formatMoney, toLbp } from '../money';

describe('money', () => {
  it('rounds LBP to the nearest 1,000', () => {
    expect(toLbp(1.25, 89500)).toBe(112000);
    expect(toLbp(0.01, 89500)).toBe(1000);
    expect(toLbp(0, 89500)).toBe(0);
  });
  it('formats both currencies with Western digits in Arabic', () => {
    expect(formatMoney(1.25, 89500, 'both', 'ar')).toBe('$1.25 · 112,000 ل.ل.');
    expect(formatMoney(1.25, 89500, 'both', 'en')).toBe('$1.25 · 112,000 LBP');
    expect(formatMoney(10, 89500, 'usd', 'ar')).toBe('$10.00');
    expect(formatMoney(10, 89500, 'lbp', 'en')).toBe('895,000 LBP');
  });
});
