// Benchmark from the brief: seed 10,000 items, check scan and search timings, and a 5-line sale commit.
// Runs under `npm test` (fake-indexeddb is slower than a real browser; budgets here are generous and the numbers are printed).
import { afterAll, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { META, PosDb, setMeta } from '../src/db';
import { CatalogIndex } from '../src/catalog';
import { commitSale, newDraft, addToDraft } from '../src/sale';
import type { Barcode, Product } from '../src/types';

const N = 10_000;
const AR = ['لبنة', 'خبز', 'جبنة', 'زيت', 'أرز', 'سكر', 'شاي', 'قهوة', 'حليب', 'بيض', 'طحين', 'ملح', 'عصير', 'ماء', 'كولا'];
const EN = ['Labneh', 'Bread', 'Cheese', 'Oil', 'Rice', 'Sugar', 'Tea', 'Coffee', 'Milk', 'Eggs', 'Flour', 'Salt', 'Juice', 'Water', 'Cola'];
const BRAND = ['Baladi', 'Puck', 'Almarai', 'Nestle', 'Lipton', 'Najjar', 'Sohat', 'Taanayel', 'Mimosa', 'Kiri'];

function seed(): { products: Product[]; barcodes: Barcode[] } {
  const products: Product[] = []; const barcodes: Barcode[] = [];
  for (let i = 0; i < N; i++) {
    const id = `p${i}`; const k = i % AR.length; const b = BRAND[i % BRAND.length];
    products.push({ id, tenant_id: 't', shop_id: 's', name: { ar: `${AR[k]} ${b} ${i}`, en: `${EN[k]} ${b} ${i}` }, price_usd: (i % 50) / 4 + 0.25, price_currency: 'usd', price_lbp: 0,
      unit_kind: 'piece', decimal_qty: false, vat: false, track_stock: true, min_stock: 0, visible_online: true, is_available: true, is_active: true, on_hand: 100, reserved: 0, needs_review: false, updated_at: '', sku: `SKU${i}` });
    barcodes.push({ product_id: id, shop_id: 's', barcode: String(6290000000000 + i) });
    if (i % 3 === 0) barcodes.push({ product_id: id, shop_id: 's', barcode: String(7290000000000 + i) });
  }
  return { products, barcodes };
}
const p95 = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length * 0.95)];

describe('benchmark: 10,000 items', () => {
  const db = new PosDb('suqa-pos-bench');
  afterAll(async () => { db.close(); await Dexie.delete('suqa-pos-bench'); });

  it('cold load + index build, scan p95 < 1 ms, search p95 < 50 ms, 5-line sale < 150 ms', async () => {
    const { products, barcodes } = seed();
    await db.open();
    await db.products.bulkPut(products); await db.barcodes.bulkPut(barcodes);
    await setMeta(db, META.devicePrefix, 'A'); await setMeta(db, META.deviceId, 'dev'); await setMeta(db, META.shop, { id: 's', tenant_id: 't' });

    let t0 = performance.now();
    const [ps, bs] = await Promise.all([db.products.toArray(), db.barcodes.toArray()]);
    const idx = new CatalogIndex(); idx.load(ps, bs, [], []);
    idx.search('x');                                                      // forces the normalised index build
    const load = performance.now() - t0;

    const scans: number[] = [];
    for (let i = 0; i < 2000; i++) { const code = String(6290000000000 + ((i * 7919) % N)); t0 = performance.now(); const p = idx.scan(code); scans.push(performance.now() - t0); expect(p).not.toBeNull(); }
    const searches: number[] = [];
    for (const q of ['لبن', 'labneh', 'puck 12', 'كولا نج', 'sku99', 'bread baladi', 'ماء', 'ab', 'coffee lip', '٤٥']) { for (let i = 0; i < 20; i++) { t0 = performance.now(); idx.search(q); searches.push(performance.now() - t0); } }

    let d = newDraft('walkin');
    for (const code of ['6290000000001', '6290000000002', '6290000000003', '6290000000004', '6290000000001']) d = addToDraft(d, idx.scan(code)!);
    t0 = performance.now();
    const r = await commitSale(db, { draft: d, rate: 89500, lbpStep: 5000, changeIn: 'usd', payments: [{ tender: 'cash_usd', amount: 100000, currency: 'usd' }] });
    const commit = performance.now() - t0;

    console.log(`[bench] load+index ${load.toFixed(0)} ms | scan p95 ${p95(scans).toFixed(3)} ms | search p95 ${p95(searches).toFixed(2)} ms | 5-line commit ${commit.toFixed(0)} ms (${r.local_number})`);
    expect(idx.size).toBe(N);
    expect(p95(scans)).toBeLessThan(1);
    expect(p95(searches)).toBeLessThan(50);
    expect(commit).toBeLessThan(150);
    expect(load).toBeLessThan(3000);
  }, 60_000);
});
