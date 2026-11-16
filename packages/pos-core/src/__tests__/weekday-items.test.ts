import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { availableOn, patchProduct } from '../catalog-edit';
import { FakeServer } from '../sync/fake-server';
import { makeDevice } from './helpers';

describe('items sold on some weekdays only', () => {
  it('availableOn: no days = every day; else only the listed weekdays', () => {
    const sat = new Date(2026, 10, 14), mon = new Date(2026, 10, 16);   // local dates: a Saturday and a Monday
    expect(sat.getDay()).toBe(6); expect(mon.getDay()).toBe(1);
    expect(availableOn({}, mon)).toBe(true); expect(availableOn({ available_days: null }, mon)).toBe(true); expect(availableOn({ available_days: [] }, mon)).toBe(true);
    expect(availableOn({ available_days: [0, 6] }, sat)).toBe(true); expect(availableOn({ available_days: [0, 6] }, mon)).toBe(false);
  });

  it('the editor patch keeps an array locally and sends an array literal; unchanged days send nothing', async () => {
    const server = new FakeServer(); const p0 = server.addProduct({ id: 'p1', price_usd: 2, on_hand: 0 });
    const a = await makeDevice(server, 'A');
    const p = (await a.db.products.get(p0.id))!;
    const p1 = await patchProduct(a.db, p, { fields: { available_days: [0, 6] } });
    expect(p1.available_days).toEqual([0, 6]);
    const op = (await a.db.outbox.toArray()).filter(x => x.kind === 'product.patch').pop()!;
    expect((op.payload as { fields: Record<string, unknown> }).fields.available_days).toBe('{0,6}');
    const n = await a.db.outbox.count();
    await patchProduct(a.db, p1, { fields: { available_days: [0, 6] } });
    expect(await a.db.outbox.count()).toBe(n);
    await patchProduct(a.db, p1, { fields: { available_days: null } });
    const op2 = (await a.db.outbox.toArray()).filter(x => x.kind === 'product.patch').pop()!;
    expect((op2.payload as { fields: Record<string, unknown> }).fields.available_days).toBeNull();
  });
});
