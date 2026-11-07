import { afterEach, describe, expect, it } from 'vitest';
import { FakeServer } from '../sync/fake-server';
import { makeDevice, wipeAll, RATE } from './helpers';
import { addToDraft, commitSale, newDraft } from '../sale';
import { cashMove, closeShift, currentShift, openShift, shiftSummary, todaySummary } from '../shift';

afterEach(wipeAll);

describe('shifts & cash', () => {
  it('expected cash = float + cash sales − change + in − out, per currency; close records the diff; Z totals by tender/channel', async () => {
    const server = new FakeServer();
    const p = server.addProduct({ id: 'p1', price_usd: 10, on_hand: 50 });
    const a = await makeDevice(server, 'A');
    expect(await currentShift(a.db)).toBeNull();
    const sh = await openShift(a.db, { float_usd_cents: 5000, float_lbp: 500000, opened_by: 'u1' });
    expect((await currentShift(a.db))?.id).toBe(sh.id);

    // sale 1: $10 paid $20 cash → change $10 (usd)
    let d = addToDraft(newDraft('walkin'), p, 1);
    await commitSale(a.db, { draft: d, rate: RATE, lbpStep: 5000, changeIn: 'usd', shift_id: sh.id, payments: [{ tender: 'cash_usd', amount: 2000, currency: 'usd' }] });
    // sale 2: $20 paid 1,000,000 LBP + $5 card → change in LBP: paid 11.17+5 = 16.17 → short... use 1,500,000 LBP → 16.76+5 = 21.76 → change 1.76$ = 157,520 → rounded down 155,000
    d = addToDraft(newDraft('walkin'), p, 2);
    await commitSale(a.db, { draft: d, rate: RATE, lbpStep: 5000, changeIn: 'lbp', shift_id: sh.id, payments: [{ tender: 'cash_lbp', amount: 1500000, currency: 'lbp' }, { tender: 'card', amount: 500, currency: 'usd' }] });
    await cashMove(a.db, sh, { kind: 'out', amount: 1000, currency: 'usd', reason: 'supplier', user_id: 'u1' });
    await cashMove(a.db, sh, { kind: 'in', amount: 100000, currency: 'lbp', reason: 'owner', user_id: 'u1' });

    const s = await shiftSummary(a.db, sh);
    expect(s.sales_count).toBe(2); expect(s.total_cents).toBe(3000);
    expect(s.expected_usd_cents).toBe(5000 + 2000 - 1000 - 1000);          // float + cash − change − out = 5000
    expect(s.expected_lbp).toBe(500000 + 1500000 - 155000 + 100000);         // 1,945,000
    expect(s.by_tender.card).toEqual({ usd: 500, lbp: 0, count: 1 });
    expect(s.by_channel.walkin).toEqual({ count: 2, cents: 3000 });

    const closed = await closeShift(a.db, sh, { counted_usd_cents: 4800, counted_lbp: 1945000, closed_by: 'u1' });
    expect(closed.diff_usd_cents).toBe(-200); expect(closed.diff_lbp).toBe(0);
    expect(await currentShift(a.db)).toBeNull();

    await a.engine.sync();
    expect(a.engine.status.pending).toBe(0);                                   // shift.open, 2 sales, 2 cash moves, shift.close all accepted
    const t = await todaySummary(a.db);
    expect(t.sales_count).toBe(2); expect(t.items_count).toBe(3); expect(t.by_tender.cash_lbp.lbp).toBe(1500000);
  });
});

describe('catalog edits & stock moves (offline → sync)', () => {
  it('patch, create, barcodes and stock moves apply locally and push', async () => {
    const { patchProduct, createProduct, recordStockMove, barcodeOwner } = await import('../catalog-edit');
    const server = new FakeServer();
    const p = server.addProduct({ id: 'p1', price_usd: 1, on_hand: 5 }, ['111']);
    const a = await makeDevice(server, 'A');
    a.transport.fault = () => 'network';
    const local = (await a.db.products.get('p1'))!;
    const up = await patchProduct(a.db, local, { fields: { price_usd: 1.5, track_stock: true }, barcodes_add: ['222'], barcodes_remove: ['111'] });
    expect(Number(up.price_usd)).toBe(1.5);
    expect(await barcodeOwner(a.db, '222')).toBe('p1'); expect(await barcodeOwner(a.db, '111')).toBeNull();
    const n = await createProduct(a.db, { name: { ar: 'خبز', en: 'Bread' }, price_usd: 0.5, track_stock: true }, ['333']);
    expect(await barcodeOwner(a.db, '333')).toBe(n.id);
    expect(await recordStockMove(a.db, (await a.db.products.get('p1'))!, { kind: 'receive', qty: 10, unit_cost_cents: 80, user_id: 'u' })).toBe(10);
    expect(await recordStockMove(a.db, (await a.db.products.get('p1'))!, { kind: 'count', qty: 12, user_id: 'u' })).toBe(-3);   // 15 → 12
    expect(Number((await a.db.products.get('p1'))!.on_hand)).toBe(12);
    expect(await a.db.outbox.count()).toBe(4);
    a.transport.fault = null; await a.engine.sync();
    expect(a.engine.status.pending).toBe(0); expect(a.engine.status.rejected).toBe(0);
    expect(server.products.get(n.id)?.name).toEqual({ ar: 'خبز', en: 'Bread' }); expect(server.barcodes.some(b => b.barcode === '333' && b.product_id === n.id)).toBe(true);
    expect(Number(server.products.get('p1')!.price_usd)).toBe(1.5); expect(Number(server.products.get('p1')!.on_hand)).toBe(12);
  });
});
