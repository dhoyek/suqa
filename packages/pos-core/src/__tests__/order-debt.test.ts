import { describe, expect, it } from 'vitest';
import { payOffOrderDebt } from '../money';

const R = 90000;
const debt = (amount: number) => ({ id: 'd', tender: 'unpaid' as const, amount, currency: 'usd' as const });
describe('an order saved as debt, paid at handover (mirror of script 129)', () => {
  it('cash in full: the debt line goes to zero', () => {
    const r = payOffOrderDebt([debt(800)], 0, [{ tender: 'cash_usd', amount: 800, currency: 'usd' }], 0, R);
    expect(r.changed).toEqual([{ ...debt(800), amount: 0 }]); expect(r.incoming[0].amount).toBe(800);
  });
  it('lira notes with change: only the order is paid', () => {
    expect(payOffOrderDebt([debt(800)], 0, [{ tender: 'cash_lbp', amount: 900000, currency: 'lbp' }], 200, R).changed[0].amount).toBe(0);
  });
  it('part by card, the rest still not paid: one debt for the rest', () => {
    const r = payOffOrderDebt([debt(800)], 0, [{ tender: 'card', amount: 500, currency: 'usd' }, { tender: 'unpaid', amount: 300, currency: 'usd' }], 0, R);
    expect(r.changed[0].amount).toBe(300); expect(r.incoming[1].amount).toBe(0);
  });
  it('still not paid: no second debt', () => {
    const r = payOffOrderDebt([debt(800)], 0, [{ tender: 'unpaid', amount: 800, currency: 'usd' }], 0, R);
    expect(r.changed).toEqual([]); expect(r.incoming[0].amount).toBe(0);
  });
  it('debt already collected in the Debts screen is not touched; no debt on the order = nothing changes', () => {
    const pays = [{ tender: 'cash_usd' as const, amount: 800, currency: 'usd' as const }];
    expect(payOffOrderDebt([debt(800)], 800, pays, 0, R)).toEqual({ changed: [], incoming: pays });
    expect(payOffOrderDebt([], 0, pays, 0, R)).toEqual({ changed: [], incoming: pays });
  });
});
