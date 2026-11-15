import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { makeDevice } from './helpers';
import { FakeServer } from '../sync/fake-server';
import { availableDrivers, upsertDriver, waDigits } from '../drivers';
import { assignDriver, setOrderStatus } from '../orders';
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
  it('a driver is lined up while the order is still in the shop: status stays, a changed driver starts clean', async () => {
    const server = new FakeServer(); const p = server.addProduct({ id: 'p1', price_usd: 2, on_hand: 9 });
    const a = await makeDevice(server, 'A');
    const d1 = await upsertDriver(a.db, server.shop.id, { name: 'Abou Ali', phone: '03 123 456' });
    const d2 = await upsertDriver(a.db, server.shop.id, { name: 'Jad', phone: '70 999 888' });
    let dr = newDraft('phone'); dr = { ...dr, customer_phone: '70333444', customer_name: 'C', fulfillment: 'delivery' }; dr = addToDraft(dr, p, 1);
    const { order } = await commitSale(a.db, { draft: dr, rate: RATE, lbpStep: 5000, changeIn: 'usd', shift_id: null, payments: [], status: 'accepted' });
    const ready = await setOrderStatus(a.db, order, 'ready');
    const o1 = await assignDriver(a.db, { ...ready, driver_ack_at: '2026-01-01T00:00:00Z' }, d1);
    expect(o1.status).toBe('ready'); expect(o1.driver_id).toBe(d1.id); expect(o1.courier_name).toBe('Abou Ali'); expect(o1.driver_ack_at).toBeNull();
    const op = (await a.db.outbox.toArray()).filter(x => x.kind === 'order.status').pop()!;
    expect(op.payload).toMatchObject({ id: order.id, status: 'ready', driver_id: d1.id });
    const same = await assignDriver(a.db, { ...o1, driver_ack_at: '2026-01-01T00:05:00Z' }, d1);
    expect(same.driver_ack_at).toBe('2026-01-01T00:05:00Z');                       // same driver: his confirmation stays
    const o2 = await assignDriver(a.db, same, d2); expect(o2.driver_id).toBe(d2.id); expect(o2.driver_ack_at).toBeNull();
    const none = await assignDriver(a.db, o2, null); expect(none.driver_id).toBeNull(); expect(none.courier_name).toBeNull();
  });
});
