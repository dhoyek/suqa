import { afterEach, describe, expect, it } from 'vitest';
import { FakeServer } from '../sync/fake-server';
import { makeDevice, wipeAll, RATE } from './helpers';
import { addToDraft, commitSale, newDraft } from '../sale';
import { openShift, shiftSummary } from '../shift';
import { allocate, debtLines, groupByPerson, settleDebt } from '../debts';

afterEach(wipeAll);

describe('debt book', () => {
  it('lists open debts per person, allocates a collection oldest-first, cash lands in the drawer, syncs', async () => {
    const server = new FakeServer();
    const p = server.addProduct({ id: 'p1', price_usd: 10, on_hand: 50 });
    const a = await makeDevice(server, 'A');
    const sh = await openShift(a.db, { float_usd_cents: 0, float_lbp: 0, opened_by: 'u1' });
    const sale = async (qty: number, name: string, phone: string) => {
      const d = addToDraft(newDraft('walkin'), p, qty);
      await commitSale(a.db, { draft: d, rate: RATE, lbpStep: 5000, changeIn: 'usd', shift_id: sh.id, payments: [{ tender: 'unpaid', amount: qty * 1000, currency: 'usd', unpaid_name: name, unpaid_phone: phone }] });
    };
    await sale(1, 'Abou Elie', '+961 70 000 000');      // $10
    await sale(2, 'Abou Elie', '96170000000');          // $20 (same person, different spelling of the number)
    await sale(3, 'Oum Joe', '70111111');               // $30
    const lines = await debtLines(a.db, { openOnly: true });
    expect(lines.map(l => l.outstanding_cents)).toEqual([1000, 2000, 3000]);
    const people = groupByPerson(lines);
    expect(people.map(x => [x.name, x.outstanding_cents])).toEqual([['Oum Joe', 3000], ['Abou Elie', 3000]]);
    const elie = people.find(x => x.name === 'Abou Elie')!;
    expect(allocate(elie.lines, 1500).map(x => x.amount_cents)).toEqual([1000, 500]);

    // collects 1,342,500 LBP ≈ $15 → first order closed, second keeps $5
    const r = await settleDebt(a.db, { phone: elie.phone, name: elie.name, tender: 'cash_lbp', currency: 'lbp', amount: 1342500, rate: RATE, lbpStep: 5000, lines: elie.lines, shift: sh, user_id: 'u1' });
    expect(r.settlement.amount_cents).toBe(1500); expect(r.allocations.map(x => x.amount_cents)).toEqual([1000, 500]); expect(r.unallocated_cents).toBe(0);
    const after = await debtLines(a.db, { openOnly: true, phones: ['70000000'] });
    expect(after).toHaveLength(1); expect(after[0].outstanding_cents).toBe(1500);   // $20 − $5
    expect((await debtLines(a.db, { phones: ['96170000000'] })).filter(l => l.closed)).toHaveLength(1);
    const s = await shiftSummary(a.db, sh);
    expect(s.in_lbp).toBe(1342500);                                       // drawer received the collection
    await a.engine.sync();
    expect(a.engine.status.pending).toBe(0); expect(a.engine.status.rejected).toBe(0);
  });
});

describe('undo a collection', () => {
  it('removes the settlement and its allocations so the debt is owed again', async () => {
    const server = new FakeServer();
    const p = server.addProduct({ id: 'p1', price_usd: 10, on_hand: 10 });
    const a = await makeDevice(server, 'A');
    const { addToDraft, newDraft, commitSale } = await import('../sale');
    const { debtLines, settleDebt, unsettleDebt } = await import('../debts');
    const d = addToDraft(newDraft('walkin'), p, 2);
    await commitSale(a.db, { draft: d, rate: RATE, lbpStep: 5000, changeIn: 'usd', payments: [{ tender: 'unpaid', amount: 2000, currency: 'usd', unpaid_name: 'x', unpaid_phone: '70000000' }] });
    const before = await debtLines(a.db, { openOnly: true });
    expect(before[0].outstanding_cents).toBe(2000);
    const r = await settleDebt(a.db, { phone: '70000000', name: 'x', tender: 'cash_usd', currency: 'usd', amount: 500, rate: RATE, lbpStep: 5000, lines: before, shift: null, user_id: 'u1' });
    expect((await debtLines(a.db, { openOnly: true }))[0].outstanding_cents).toBe(1500);
    await unsettleDebt(a.db, r.settlement, { shift: null, user_id: 'u1', reason: 'mistake' });
    expect((await debtLines(a.db, { openOnly: true }))[0].outstanding_cents).toBe(2000);
    expect(await a.db.debtSettlements.count()).toBe(0);
    expect((await a.db.outbox.toArray()).some(o => o.kind === 'debt.unsettle')).toBe(true);
  });
});
