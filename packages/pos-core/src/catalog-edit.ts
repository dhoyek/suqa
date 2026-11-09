import { META, type PosDb } from './db';
import { enqueue, newId } from './sale';
import { normBarcode } from './catalog';
import type { Product } from './types';

// Catalog edits from the POS: optimistic local write + a 'product.patch' op (field patch, server-wins LWW with conflict log).
// Allowed fields mirror suqa._pos_product_patch's allow-list.
export const PATCHABLE = ['name', 'description', 'price_usd', 'price_currency', 'price_lbp', 'cost_cents', 'sku', 'unit', 'unit_kind', 'decimal_qty', 'vat', 'track_stock', 'min_stock', 'supplier_id', 'margin_pct', 'next_expiry',
  'visible_online', 'is_available', 'is_active', 'section', 'sort_order', 'image_url'] as const;
export type Patchable = (typeof PATCHABLE)[number];

export type BarcodeInput = string | { barcode: string; pack_qty?: number | null; pack_price_usd?: number | null; pack_price_lbp?: number | null };
export interface ProductEdit { fields: Partial<Pick<Product, Patchable>>; barcodes_add?: BarcodeInput[]; barcodes_remove?: string[]; approved_by?: string | null }
const bcRow = (b: BarcodeInput) => (typeof b === 'string' ? { barcode: normBarcode(b), pack_qty: 1, pack_price_usd: null, pack_price_lbp: null } : { barcode: normBarcode(b.barcode), pack_qty: b.pack_qty ?? 1, pack_price_usd: b.pack_price_usd ?? null, pack_price_lbp: b.pack_price_lbp ?? null });

/** Edit an existing product. Returns the updated local row. */
export async function patchProduct(db: PosDb, product: Product, edit: ProductEdit): Promise<Product> {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(edit.fields)) if (PATCHABLE.includes(k as Patchable) && (product as unknown as Record<string, unknown>)[k] !== v) fields[k] = v;
  const add = (edit.barcodes_add ?? []).map(bcRow).filter(b => b.barcode);
  const remove = (edit.barcodes_remove ?? []).map(normBarcode).filter(Boolean);
  if (!Object.keys(fields).length && !add.length && !remove.length) return product;
  const updated: Product = { ...product, ...(fields as Partial<Product>), updated_at: new Date().toISOString() };
  await db.transaction('rw', [db.products, db.barcodes, db.outbox], async () => {
    await db.products.put(updated);
    for (const b of add) await db.barcodes.put({ product_id: product.id, shop_id: product.shop_id, ...b });
    for (const b of remove) await db.barcodes.delete([product.id, b]);
    await enqueue(db, 'product.patch', { id: product.id, fields, base_updated_at: product.updated_at, barcodes_add: add, barcodes_remove: remove, approved_by: edit.approved_by ?? null });
  });
  return updated;
}

/** Create a product offline. The server inserts it on sync (new_id) and the feed echoes the canonical row. */
export async function createProduct(db: PosDb, fields: Partial<Pick<Product, Patchable>> & { name: Product['name'] }, barcodes: BarcodeInput[] = [], approvedBy?: string | null): Promise<Product> {
  const shop = (await db.meta.get(META.shop))?.value as { id: string; tenant_id: string };
  const id = newId();
  const row: Product = {
    id, tenant_id: shop.tenant_id, shop_id: shop.id, name: fields.name, description: fields.description ?? {},
    price_usd: fields.price_usd ?? 0, price_currency: fields.price_currency ?? 'usd', price_lbp: fields.price_lbp ?? 0, cost_cents: fields.cost_cents ?? null,
    sku: fields.sku ?? null, unit: fields.unit ?? null, unit_kind: fields.unit_kind ?? 'piece', decimal_qty: !!fields.decimal_qty, vat: !!fields.vat,
    track_stock: !!fields.track_stock, min_stock: fields.min_stock ?? 0, visible_online: fields.visible_online ?? true, is_available: fields.is_available ?? true, is_active: fields.is_active ?? true,
    on_hand: 0, reserved: 0, needs_review: false, category_id: null, section: fields.section ?? null, image_url: fields.image_url ?? null, sort_order: fields.sort_order ?? 0,
    updated_at: new Date().toISOString(),
  };
  const bcs = barcodes.map(bcRow).filter(b => b.barcode);
  const f: Record<string, unknown> = {};
  for (const k of PATCHABLE) if ((fields as Record<string, unknown>)[k] !== undefined) f[k] = (fields as Record<string, unknown>)[k];
  await db.transaction('rw', [db.products, db.barcodes, db.outbox], async () => {
    await db.products.put(row);
    for (const b of bcs) await db.barcodes.put({ product_id: id, shop_id: shop.id, ...b });
    await enqueue(db, 'product.patch', { new_id: id, fields: f, barcodes_add: bcs, approved_by: approvedBy ?? null });
  });
  return row;
}

/** Find which product (if any) owns a barcode locally. */
export async function barcodeOwner(db: PosDb, barcode: string): Promise<string | null> {
  const r = await db.barcodes.where('barcode').equals(normBarcode(barcode)).first();
  return r?.product_id ?? null;
}

// ---- stock ----
export type StockMoveKind = 'receive' | 'adjust' | 'count' | 'damaged' | 'return';
/** Record a stock movement offline: ledger row + optimistic on_hand + 'stock.move' op. `count` takes the counted quantity and writes the delta. */
export async function recordStockMove(db: PosDb, product: Product, input: { kind: StockMoveKind; qty: number; unit_cost_cents?: number | null; note?: string; user_id: string; approved_by?: string | null }): Promise<number> {
  const current = Number(product.on_hand) || 0;
  const delta = input.kind === 'count' ? input.qty - current : input.kind === 'damaged' ? -Math.abs(input.qty) : input.qty;
  if (!delta && input.kind !== 'count') return 0;
  const deviceId = (await db.meta.get(META.deviceId))?.value as string | undefined;
  const id = newId(); const at = new Date().toISOString();
  await db.transaction('rw', [db.products, db.stockMoves, db.outbox], async () => {
    await db.stockMoves.put({ id, shop_id: product.shop_id, product_id: product.id, qty: delta, kind: input.kind, unit_cost_cents: input.unit_cost_cents ?? null, note: input.note ?? null, device_id: deviceId ?? null, user_id: input.user_id, at });
    await db.products.put({ ...product, on_hand: Math.round((current + delta) * 1000) / 1000, needs_review: current + delta < 0 ? true : product.needs_review, ...(input.unit_cost_cents != null ? { cost_cents: input.unit_cost_cents } : {}) });
    await enqueue(db, 'stock.move', { id, product_id: product.id, qty: delta, kind: input.kind, unit_cost_cents: input.unit_cost_cents ?? null, note: input.note ?? null, at, approved_by: input.approved_by ?? null });
  });
  return delta;
}
