import { afterEach, describe, expect, it } from 'vitest';
import { FakeServer } from '../sync/fake-server';
import { makeDevice, wipeAll, RATE } from './helpers';
import { openShift, shiftSummary } from '../shift';
import { adjustSupplierBalance, paySupplier, supplierStatement, upsertSupplier } from '../purchases';

afterEach(wipeAll);

describe('supplier balance correction', () => {
  it('sets the balance, keeps the reason in the statement, moves no cash, and a reason is required', async () => {
    const server = new FakeServer();
    const a = await makeDevice(server, 'A');
    const sh = await openShift(a.db, { float_usd_cents: 10000, float_lbp: 0, opened_by: 'u1' });
    const sup = await upsertSupplier(a.db, server.shop.id, { name: 'Sanabel' });

    await expect(adjustSupplierBalance(a.db, { supplier: sup, new_balance_cents: 5000, reason: '  ', rate: RATE, user_id: 'u1' })).rejects.toThrow('reason_required');
    const row = await adjustSupplierBalance(a.db, { supplier: sup, new_balance_cents: 5000, reason: 'رصيد النظام القديم', rate: RATE, user_id: 'u1' });
    expect(row?.tender).toBe('adjust'); expect(row?.amount_cents).toBe(-5000); expect(row?.from_drawer).toBe(false);
    expect((await a.db.suppliers.get(sup.id))!.balance_cents).toBe(5000);

    // an ordinary payment afterwards nets against the corrected balance — nothing counted twice
    await paySupplier(a.db, { supplier: (await a.db.suppliers.get(sup.id))!, tender: 'cash_usd', currency: 'usd', amount: 2000, rate: RATE, from_drawer: true, shift: sh, user_id: 'u1' });
    const s2 = (await a.db.suppliers.get(sup.id))!;
    expect(s2.balance_cents).toBe(3000);
    expect(await adjustSupplierBalance(a.db, { supplier: s2, new_balance_cents: 3000, reason: 'same', rate: RATE, user_id: 'u1' })).toBeNull();   // no change → nothing recorded

    const st = await supplierStatement(a.db, s2);
    expect(st.map(x => x.kind)).toEqual(['payment', 'adjust']);
    expect(st[1]).toMatchObject({ ref: 'رصيد النظام القديم', amount_cents: 5000, balance_cents: 5000 });
    expect(st[0].balance_cents).toBe(3000);
    const sum = await shiftSummary(a.db, sh);
    expect(sum.expected_usd_cents).toBe(8000);          // only the real payment left the drawer
    expect((await a.db.outbox.toArray()).filter(o => o.kind === 'supplier.pay').length).toBe(2);
  });
});
