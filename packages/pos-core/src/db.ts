import Dexie, { type Table } from 'dexie';
import type { Barcode, CashMove, Category, Conflict, CustomerSeen, Device, Order, OrderLine, OutboxOp, Payment, Product, QuickButton, Rate, Shift, Staff, StockMove } from './types';

// One IndexedDB database per shop: suqa-pos-<shopId>. A user with two shops never mixes their data.
//
// Migration rule (PLAN §1.9): the `outbox` store's shape never changes — ops are opaque JSON tagged with
// schema_version — so an app update with unsynced sales never loses them. Add a new Dexie version for
// every store/index change; never edit an existing version block.

export interface Meta { key: string; value: unknown }

export class PosDb extends Dexie {
  meta!: Table<Meta, string>;
  products!: Table<Product, string>;
  barcodes!: Table<Barcode, [string, string]>;
  categories!: Table<Category, string>;
  quickButtons!: Table<QuickButton, string>;
  rates!: Table<Rate, string>;
  staff!: Table<Staff, string>;
  devices!: Table<Device, string>;
  orders!: Table<Order, string>;
  orderLines!: Table<OrderLine, string>;
  payments!: Table<Payment, string>;
  stockMoves!: Table<StockMove, string>;
  shifts!: Table<Shift, string>;
  cashMoves!: Table<CashMove, string>;
  customers!: Table<CustomerSeen, string>;
  outbox!: Table<OutboxOp, number>;
  conflicts!: Table<Conflict, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      meta: 'key',
      products: 'id, category_id, updated_at',
      barcodes: '[product_id+barcode], product_id, barcode',
      categories: 'id, parent_id',
      quickButtons: 'id, sort_order',
      rates: 'id, effective_at',
      staff: 'user_id',
      devices: 'id',
      orders: 'id, status, channel, placed_at, local_number, number, shift_id, parked',
      orderLines: 'id, order_id',
      payments: 'id, order_id',
      stockMoves: 'id, product_id, at, ref_order_id',
      shifts: 'id, device_id, opened_at',
      cashMoves: 'id, shift_id',
      customers: 'phone, last_seen',
      outbox: '++seq, op_id, state, next_try_at',
      conflicts: 'id, seen, at',
    });
    // v2: sku index for the catalog editor. Pure index change; outbox untouched. (Also the migration the tests exercise.)
    this.version(2).stores({
      products: 'id, category_id, updated_at, sku',
    });
  }
}

export const CURRENT_SCHEMA_VERSION = 1;   // bump when an op payload shape changes; pos_push accepts every past version
export const posDbName = (shopId: string) => `suqa-pos-${shopId}`;
export const openPosDb = (shopId: string) => new PosDb(posDbName(shopId));

// meta helpers
export async function getMeta<T>(db: PosDb, key: string): Promise<T | undefined> {
  const r = await db.meta.get(key); return r?.value as T | undefined;
}
export async function setMeta(db: PosDb, key: string, value: unknown): Promise<void> { await db.meta.put({ key, value }); }

export const META = {
  deviceId: 'device_id', devicePrefix: 'device_prefix', deviceName: 'device_name', cursor: 'cursor', localSeq: 'local_seq',
  shop: 'shop', role: 'role', lastOnlineAt: 'last_online_at', lastSyncAt: 'last_sync_at', userId: 'user_id', revoked: 'revoked',
} as const;
