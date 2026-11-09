import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { makeDevice } from './helpers';
import { FakeServer } from '../sync/fake-server';
import { availableDrivers, upsertDriver, waDigits } from '../drivers';
import { setOrderStatus } from '../orders';
import { addToDraft, commitSale, newDraft } from '../sale';

const RATE = 89500;
describe('drivers-lite', () => {
  it('upsert by number, availability filter, assignment travels with the status change', async () => {
    const server = new FakeServer(); const p = server.addProduct({ id: 'p1', price_usd: 2, on_hand: 9 });
    const a = await makeDevice(server, 'A');
    const d1 = await upsertDriver(a.db, server.shop.id, { name: 'Abou Ali', phone: '03 123 456', vehicle: 'moto' });
    await upsertDriver(a.db, server.shop.id, { name: 'Jad', phone: '70 999 888', available: false });
    const again = await upsertDriver(a.db, server.shop.id, { name: 'Abou Ali H.', phone: '+961 3 123 456' });
    expect(again.id).toBe(d1.id); expect((await a.db.drivers.count())).toBe(2);
    expect((await availableDrivers(a.db)).map(d => d.name)).toEqual(['Abou Ali H.']);
    await expect(upsertDriver(a.db, server.shop.id, { name: 'x', phone: '12' })).rejects.toThrow('bad_phone');
    let dr = newDraft('whatsapp'); dr = { ...dr, customer_phone: '70333444', customer_name: 'C', fulfillment: 'delivery' }; dr = addToDraft(dr, p, 1);
    const { order } = await commitSale(a.db, { draft: dr, rate: RATE, lbpStep: 5000, changeIn: 'usd', shift_id: null, payments: [], status: 'accepted' });
    const o = await setOrderStatus(a.db, order, 'out_for_delivery', { driver_id: d1.id, courier_name: 'Abou Ali H.' });
    expect(o.driver_id).toBe(d1.id); expect(o.courier_name).toBe('Abou Ali H.');
    const op = (await a.db.outbox.toArray()).find(x => x.kind === 'order.status' && x.payload.status === 'out_for_delivery')!;
    expect(op.payload.driver_id).toBe(d1.id); expect('courier_name' in op.payload).toBe(false);
    expect(waDigits('03 123 456')).toBe('9613123456'); expect(waDigits('+961 70 483 148')).toBe('96170483148');
  });
});
