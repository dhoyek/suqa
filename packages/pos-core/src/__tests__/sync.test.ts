import { afterEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { FakeServer } from '../sync/fake-server';
import { makeDevice, sell, wipeAll, RATE } from './helpers';
import { num } from '../types';
import { META, PosDb, getMeta, setMeta } from '../db';
import { enqueue } from '../sale';

afterEach(wipeAll);

describe('sync engine — the five scenarios from the brief', () => {
  it('1. two devices sell the same item offline, then sync: stock and numbers converge', async () => {
    const server = new FakeServer();
    const labneh = server.addProduct({ id: 'p-labneh', name: { en: 'Labneh', ar: 'لبنة' }, price_usd: 3.5, on_hand: 20 }, ['6291234567890']);
    const a = await makeDevice(server, 'Counter PC');
    const b = await makeDevice(server, 'Phone');
    expect([a.prefix, b.prefix]).toEqual(['A', 'B']);

    // both offline
    a.transport.fault = () => 'network'; b.transport.fault = () => 'network';
    const sa = await sell(a.db, labneh, 3);
    const sb = await sell(b.db, labneh, 4);
    expect(sa.local_number).toBe('A-000001'); expect(sb.local_number).toBe('B-000001');
    expect(num((await a.db.products.get('p-labneh'))!.on_hand)).toBe(17);     // each device only knows its own sale
    expect(num((await b.db.products.get('p-labneh'))!.on_hand)).toBe(16);
    await a.engine.sync(); await b.engine.sync();
    expect(a.engine.status.online).toBe(false); expect(a.engine.status.pending).toBe(1);

    // back online
    a.transport.fault = null; b.transport.fault = null;
    await a.engine.sync(); await b.engine.sync(); await a.engine.sync();        // a pulls b's sale on the second round
    expect(num(server.products.get('p-labneh')!.on_hand)).toBe(13);
    expect(num((await a.db.products.get('p-labneh'))!.on_hand)).toBe(13);
    expect(num((await b.db.products.get('p-labneh'))!.on_hand)).toBe(13);
    expect([...server.moves.values()].filter(m => m.kind === 'sale')).toHaveLength(2);
    const nums = [...server.orders.values()].map(o => o.number).sort();
    expect(nums).toEqual(['TST-000001', 'TST-000002']);
    expect((await a.db.orders.get(sa.order.id))!.number).toMatch(/^TST-/);       // server number written back
    expect(await a.db.orders.count()).toBe(2);                                   // sees B's order too
    expect(a.engine.status.pending).toBe(0); expect(b.engine.status.pending).toBe(0);
  });

  it('2. a push retried after a timeout never duplicates the sale', async () => {
    const server = new FakeServer();
    const p = server.addProduct({ id: 'p1', price_usd: 2, on_hand: 10 });
    const a = await makeDevice(server, 'A');
    const s = await sell(a.db, p, 1);
    let calls = 0;
    a.transport.fault = kind => (kind === 'push' && calls++ === 0 ? 'timeout' : null);   // server applies, client never hears back
    await a.engine.sync();
    expect(a.engine.status.pending).toBe(1); expect(server.orders.size).toBe(1);
    await a.engine.sync();                                                            // retry → replayed result
    expect(a.engine.status.pending).toBe(0);
    expect(server.orders.size).toBe(1); expect(server.payments.size).toBe(1);
    expect([...server.moves.values()].filter(m => m.kind === 'sale')).toHaveLength(1);
    expect(num(server.products.get('p1')!.on_hand)).toBe(9);
    expect((await a.db.orders.get(s.order.id))!.number).toBe('TST-000001');
  });

  it('3. an online order placed while the device is offline shows up on reconnect, with the reservation', async () => {
    const server = new FakeServer();
    server.addProduct({ id: 'p1', price_usd: 2, on_hand: 10 });
    const a = await makeDevice(server, 'A');
    a.transport.fault = () => 'network';
    const o = server.placeOnlineOrder([{ product_id: 'p1', quantity: 2 }]);
    await a.engine.sync();
    expect(await a.db.orders.get(o.id)).toBeUndefined();
    a.transport.fault = null;
    await a.engine.sync();
    const local = await a.db.orders.get(o.id);
    expect(local?.channel).toBe('online'); expect(local?.status).toBe('pending');
    const prod = (await a.db.products.get('p1'))!;
    expect(num(prod.on_hand)).toBe(10); expect(num(prod.reserved)).toBe(2);           // available = 8
    expect(a.events.filter(e => e.type === 'order.new')).toHaveLength(1);
    // shop marks it ready from the POS → stock deducted, reservation released
    await enqueue(a.db, 'order.status', { id: o.id, status: 'accepted' });
    await enqueue(a.db, 'order.status', { id: o.id, status: 'ready' });
    await a.engine.sync();
    const after = (await a.db.products.get('p1'))!;
    expect(num(after.on_hand)).toBe(8); expect(num(after.reserved)).toBe(0);
    expect(a.events.filter(e => e.type === 'order.new')).toHaveLength(1);              // status updates are not "new"
  });

  it('4. an app update (local schema migration) keeps unsynced sales and they push afterwards', async () => {
    const server = new FakeServer();
    const p = server.addProduct({ id: 'p1', price_usd: 1, on_hand: 5 });
    const transport = server.transport() as import('../sync/fake-server').FakeTransport;
    const id = 'dev-old-app'; const dev = await transport.register({ id, shop_id: server.shop.id, name: 'Old app' });
    const name = `suqa-pos-test-migrate`;

    // the OLD app: schema v1 only (same stores, no sku index), three sales made offline
    const v1 = new Dexie(name);
    v1.version(1).stores({ meta: 'key', products: 'id, category_id, updated_at', barcodes: '[product_id+barcode], product_id, barcode', categories: 'id, parent_id', quickButtons: 'id, sort_order', rates: 'id, effective_at', staff: 'user_id', devices: 'id', orders: 'id, status, channel, placed_at, local_number, number, shift_id, parked', orderLines: 'id, order_id', payments: 'id, order_id', stockMoves: 'id, product_id, at, ref_order_id', shifts: 'id, device_id, opened_at', cashMoves: 'id, shift_id', customers: 'phone, last_seen', outbox: '++seq, op_id, state, next_try_at', conflicts: 'id, seen, at' });
    await v1.open();
    const old = v1 as unknown as PosDb;
    await old.products.put(p); await setMeta(old, META.deviceId, id); await setMeta(old, META.devicePrefix, dev.prefix); await setMeta(old, META.shop, server.shop); await setMeta(old, META.cursor, server.seq);
    await sell(old, p, 1); await sell(old, p, 1); await sell(old, p, 1);
    expect(await old.outbox.count()).toBe(3); expect(v1.verno).toBe(1);
    v1.close();

    // the NEW app opens the same database: Dexie upgrades 1 → 2
    const db2 = new PosDb(name); await db2.open();
    expect(db2.verno).toBe(3);
    expect(await db2.outbox.count()).toBe(3);                                         // nothing lost
    expect(await db2.orders.count()).toBe(3);
    const { SyncEngine } = await import('../sync/engine');
    const engine2 = new SyncEngine({ db: db2, transport, deviceId: id, backoff: () => 0 });
    await engine2.sync();
    expect(engine2.status.pending).toBe(0); expect(server.orders.size).toBe(3);
    expect(num(server.products.get('p1')!.on_hand)).toBe(2);
    db2.close();
  });

  it('5. a revoked device stops syncing, exports its outbox and wipes local data', async () => {
    const server = new FakeServer();
    const p = server.addProduct({ id: 'p1', price_usd: 1, on_hand: 5 });
    const a = await makeDevice(server, 'A');
    a.transport.fault = () => 'network';
    await sell(a.db, p, 1);
    server.revoke(a.id);
    a.transport.fault = null;
    await a.engine.sync();
    expect(a.engine.status.revoked).toBe(true);
    const ev = a.events.find(e => e.type === 'revoked');
    expect(ev && ev.type === 'revoked' && ev.outbox).toHaveLength(1);                 // the unsynced sale is handed to the app
    expect((await Dexie.getDatabaseNames()).includes(a.db.name)).toBe(false);          // local data gone
    expect(server.orders.size).toBe(0);                                                // and the server never accepted it
    // a new registration gets a new prefix
    const b = await makeDevice(server, 'A again');
    expect(b.prefix).toBe('B');
  });
});

describe('conflicts, numbering, resync', () => {
  it('field-level LWW: server wins and the overwritten value is logged', async () => {
    const server = new FakeServer();
    server.addProduct({ id: 'p1', price_usd: 1, on_hand: 0 });
    const a = await makeDevice(server, 'A');
    const base = (await a.db.products.get('p1'))!.updated_at;
    server.products.get('p1')!.price_usd = 1.5; server.products.get('p1')!.updated_at = new Date(Date.now() + 1000).toISOString();   // owner edited on the web meanwhile
    await enqueue(a.db, 'product.patch', { id: 'p1', fields: { price_usd: 1.25 }, base_updated_at: base });
    await a.engine.sync();
    expect(server.products.get('p1')!.price_usd).toBe(1.25);                            // later write wins…
    expect(server.conflicts).toEqual([{ tbl: 'products', row_id: 'p1', field: 'price_usd', old_value: 1.5, new_value: 1.25 }]);   // …and the loser is kept
  });

  it('local numbering survives a reload and prefixes differ per device', async () => {
    const server = new FakeServer();
    const p = server.addProduct({ id: 'p1', price_usd: 1 });
    const a = await makeDevice(server, 'A');
    await sell(a.db, p); await sell(a.db, p);
    a.db.close();
    const db2 = new PosDb(a.db.name); await db2.open();
    expect(await getMeta<number>(db2, META.localSeq)).toBe(2);
    const s3 = await sell(db2, p);
    expect(s3.local_number).toBe('A-000003');
    db2.close();
  });

  it('rejected ops do not block the queue and are kept for review', async () => {
    const server = new FakeServer();
    const p = server.addProduct({ id: 'p1', price_usd: 1 });
    const a = await makeDevice(server, 'A');
    await enqueue(a.db, 'order.status', { id: 'nope', status: 'ready' });               // will be rejected
    await sell(a.db, p);
    await a.engine.sync();
    expect(a.engine.status.rejected).toBe(1); expect(a.engine.status.pending).toBe(0);
    expect(server.orders.size).toBe(1);
    expect(a.events.filter(e => e.type === 'op.rejected')).toHaveLength(1);
  });

  it('a device far behind the feed retention does a full resync', async () => {
    const server = new FakeServer();
    server.addProduct({ id: 'p1', price_usd: 1 });
    const a = await makeDevice(server, 'A');
    server.addProduct({ id: 'p2', price_usd: 2 });
    // simulate pruning: feed rows older than the device's cursor are gone AND the server says resync
    const t = a.transport; const origPull = t.pull.bind(t);
    t.pull = async (id, cursor, limit) => (cursor > 0 ? { resync: true, cursor: 0, rows: [], server_now: new Date().toISOString() } : origPull(id, cursor, limit));
    await a.engine.sync();
    expect(a.events.some(e => e.type === 'resync')).toBe(true);
    expect(await a.db.products.count()).toBe(2);
    expect(RATE).toBe(89500);
  });
});
