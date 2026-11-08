import { afterEach, describe, expect, it } from 'vitest';
import { FakeServer } from '../sync/fake-server';
import { makeDevice, wipeAll, RATE } from './helpers';
import { addToDraft, commitSale, newDraft } from '../sale';
import { addressBook, sameAddress, coordsFrom, customerHasHistory, deleteCustomer, fmtPhone, lastOrderOf, mergeCustomers, normPhone, openOrdersOf, searchCustomers, upsertCustomer } from '../customers';

afterEach(wipeAll);

describe('shop customers', () => {
  it('normalises Lebanese numbers and parses map links', () => {
    expect(['+961 70 483 148', '0096170483148', '070483148', '70483148'].map(normPhone)).toEqual(['70483148', '70483148', '70483148', '70483148']);
    expect(fmtPhone('70483148')).toBe('+961 70 483 148');
    expect(coordsFrom('https://maps.google.com/?q=34.123456,35.654321')).toEqual({ lat: 34.123456, lng: 35.654321 });
    expect(coordsFrom('https://www.google.com/maps/@34.1,35.6,17z')).toEqual({ lat: 34.1, lng: 35.6 });
    expect(coordsFrom('https://maps.app.goo.gl/abc')).toBeNull();
  });
  it('search by name or number, upsert keeps the record, repeat last order, open-order warning', async () => {
    const server = new FakeServer(); const p = server.addProduct({ id: 'p1', price_usd: 2, on_hand: 9 });
    const a = await makeDevice(server, 'A');
    await upsertCustomer(a.db, server.shop.id, { phone: '+961 3 555 666', name: 'Dany Hoyek', address: { line1: 'Hay el Horiye', lat: 34.12, lng: 35.65 } });
    await upsertCustomer(a.db, server.shop.id, { phone: '71000000', name: 'Mariame Yazbek' });
    expect((await searchCustomers(a.db, 'dan')).map(c => c.name)).toEqual(['Dany Hoyek']);
    expect((await searchCustomers(a.db, '03 55')).map(c => c.name)).toEqual(['Dany Hoyek']);
    expect((await searchCustomers(a.db, 'yaz')).map(c => c.name)).toEqual(['Mariame Yazbek']);
    const again = await upsertCustomer(a.db, server.shop.id, { phone: '03555666', name: '' });
    expect(again.name).toBe('Dany Hoyek'); expect(again.address.line1).toBe('Hay el Horiye'); expect(await a.db.shopCustomers.count()).toBe(2);
    let d = addToDraft(newDraft('whatsapp'), p, 3); d = { ...d, customer_phone: '3555666', customer_name: 'Dany Hoyek', fulfillment: 'delivery' };
    await commitSale(a.db, { draft: d, rate: RATE, lbpStep: 5000, changeIn: 'usd', shift_id: null, payments: [], status: 'accepted' });
    expect((await openOrdersOf(a.db, '+96103555666'))).toHaveLength(1);
    const last = await lastOrderOf(a.db, '03555666'); expect(last?.lines.map(l => [l.product_id, Number(l.quantity)])).toEqual([['p1', 3]]);
    await a.engine.sync(); expect(a.engine.status.rejected).toBe(0);
  });
  it('merge moves orders to the kept number, inactive hidden from search, delete refused with history', async () => {
    const server = new FakeServer(); const p = server.addProduct({ id: 'p1', price_usd: 2, on_hand: 9 });
    const a = await makeDevice(server, 'A');
    const keep = await upsertCustomer(a.db, server.shop.id, { phone: '70111222', name: 'Keep' });
    const drop = await upsertCustomer(a.db, server.shop.id, { phone: '70333444', name: '', address: { line1: 'Batroun' } });
    let d = newDraft('whatsapp'); d = { ...d, customer_phone: '70333444', customer_name: 'Drop' }; d = addToDraft(d, p, 1);
    await commitSale(a.db, { draft: d, rate: RATE, lbpStep: 5000, changeIn: 'usd', shift_id: null, payments: [], status: 'accepted' });
    expect(await customerHasHistory(a.db, drop)).toBe(true);
    await expect(deleteCustomer(a.db, drop)).rejects.toThrow('has_history');
    await mergeCustomers(a.db, keep, drop);
    expect(await a.db.shopCustomers.get(drop.id)).toBeUndefined();
    const k = (await a.db.shopCustomers.get(keep.id))!; expect(k.orders_count).toBe(1); expect(k.address.line1).toBe('Batroun');
    expect((await a.db.orders.toArray()).every(o => normPhone(o.customer_phone) === '70111222')).toBe(true);
    expect((await a.db.outbox.toArray()).map(o => o.kind)).toContain('customer.merge');
    await upsertCustomer(a.db, server.shop.id, { phone: '70111222', name: 'Keep', active: false });
    expect((await searchCustomers(a.db, 'keep')).length).toBe(0);
    const fresh = await upsertCustomer(a.db, server.shop.id, { phone: '70999888', name: 'Fresh' });
    await deleteCustomer(a.db, fresh); expect(await a.db.shopCustomers.get(fresh.id)).toBeUndefined();
  });
  it('address book: saved entries most recent first, legacy single address as fallback, fuzzy equality', () => {
    const c = { id: 'c', shop_id: 's', phone: '70', phone_key: '70', name: 'x', orders_count: 0, address: { line1: 'Old' },
      addresses: [{ id: 'a', line1: 'Home', last_used_at: '2026-01-01' }, { id: 'b', line1: 'Work', lat: 34.1, lng: 35.6, last_used_at: '2026-02-01' }] };
    expect(addressBook(c).map(a => a.id)).toEqual(['b', 'a']);
    expect(addressBook({ ...c, addresses: [] }).map(a => a.line1)).toEqual(['Old']);
    expect(sameAddress({ line1: ' home ' }, { line1: 'Home' })).toBe(true);
    expect(sameAddress({ lat: 34.1, lng: 35.6 }, { lat: 34.10005, lng: 35.60005, line1: 'anything' })).toBe(true);
    expect(sameAddress({ line1: 'Home' }, { line1: 'Work' })).toBe(false);
  });
});
