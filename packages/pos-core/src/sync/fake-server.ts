import { v7 as uuidv7 } from 'uuid';
import { num, SyncError, type Device, type FeedRow, type Order, type OrderLine, type OutboxOp, type Payment, type Product, type PullResult, type PushResult, type Snapshot, type StockMove, type Transport, type Barcode, type Category, type Shop, type Staff, type Rate } from '../types';

/**
 * In-memory server with the same rules as 21_pos.sql: idempotent ops (pos_ops), tenant order numbering on sync, append-only
 * stock ledger with on_hand/reserved sums, online-order reserve → deduct at ready, field-level LWW with a conflict log,
 * feed with global seq, snapshot, revoke. Used by the engine tests and the benchmark; the SQL smoke test covers the real thing.
 */
export class FakeServer {
  seq = 0; feed: FeedRow[] = []; ops = new Map<string, Record<string, unknown>>();
  devices = new Map<string, Device & { revoked_at: string | null }>();
  products = new Map<string, Product>(); barcodes: Barcode[] = []; categories: Category[] = []; rates: Rate[] = []; staff: Staff[] = [];
  orders = new Map<string, Order>(); lines = new Map<string, OrderLine>(); payments = new Map<string, Payment>(); moves = new Map<string, StockMove>();
  conflicts: Array<{ tbl: string; row_id: string; field: string; old_value: unknown; new_value: unknown }> = [];
  counter = 0; shop: Shop; role: 'owner' | 'cashier' | 'stock' = 'owner';
  constructor(shop?: Partial<Shop>) {
    this.shop = { id: 'shop-1', tenant_id: 'tenant-1', slug: 'test', name: { en: 'Test shop' }, pos_enabled: true, offline_days: 30, max_discount_pct: 10, allow_negative_stock: true,
      lbp_rounding_step: 5000, deduct_stock_at: 'ready', hide_online_when_zero: false, printer: {}, ...shop };
  }
  private log(tbl: string, row: Record<string, unknown>, origin: string | null, op: 'upsert' | 'delete' = 'upsert', row_id?: string) {
    this.feed.push({ seq: ++this.seq, tbl, row_id: row_id ?? String(row.id), op, row: JSON.parse(JSON.stringify(row)), origin_device: origin });
  }
  addProduct(p: Partial<Product> & { id: string }, barcodes: string[] = []): Product {
    const row: Product = { tenant_id: this.shop.tenant_id, shop_id: this.shop.id, name: { en: p.id }, price_usd: 1, price_currency: 'usd', price_lbp: 0, unit_kind: 'piece', decimal_qty: false,
      vat: false, track_stock: true, min_stock: 0, visible_online: true, is_available: true, is_active: true, on_hand: 0, reserved: 0, needs_review: false, updated_at: new Date().toISOString(), ...p };
    this.products.set(row.id, row); this.log('products', row as unknown as Record<string, unknown>, null);
    for (const b of barcodes) { const bc = { product_id: row.id, shop_id: this.shop.id, barcode: b }; this.barcodes.push(bc); this.log('product_barcodes', bc, null, 'upsert', `${row.id}:${b}`); }
    return row;
  }
  private move(m: Omit<StockMove, 'at'> & { at?: string }, origin: string | null) {
    if (this.moves.has(m.id)) return;
    const row: StockMove = { at: new Date().toISOString(), ...m };
    this.moves.set(row.id, row);
    const p = this.products.get(row.product_id)!;
    if (row.kind === 'reserve' || row.kind === 'release') p.reserved = Math.max(0, num(p.reserved) + num(row.qty));
    else { p.on_hand = num(p.on_hand) + num(row.qty); if (num(p.on_hand) < 0) p.needs_review = true; }
    p.updated_at = new Date().toISOString();
    this.log('stock_moves', row as unknown as Record<string, unknown>, origin);
    this.log('products', p as unknown as Record<string, unknown>, origin);
  }
  nextNumber(): string { return `TST-${String(++this.counter).padStart(6, '0')}`; }

  // ---- "customer" side: an online order placed through the store ----
  placeOnlineOrder(items: Array<{ product_id: string; quantity: number }>, id = uuidv7()): Order {
    const o: Order = { id, tenant_id: this.shop.tenant_id, shop_id: this.shop.id, number: this.nextNumber(), status: 'pending', channel: 'online', parked: false,
      customer_name: 'Online Customer', customer_phone: '+96170000001', address: {}, fulfillment: 'delivery', notify_customer: true, rate_lbp_per_usd: 89500,
      subtotal_cents: 0, discount_cents: 0, total_cents: 0, total_lbp: 0, paid_usd_cents: 0, paid_lbp: 0, change_usd_cents: 0, change_lbp: 0, placed_at: new Date().toISOString() };
    this.orders.set(o.id, o); this.log('orders', o as unknown as Record<string, unknown>, null);
    for (const it of items) {
      const p = this.products.get(it.product_id)!;
      const l: OrderLine = { id: uuidv7(), order_id: o.id, product_id: p.id, name: p.name, quantity: it.quantity, price_currency: 'usd', unit_price_cents: Math.round(num(p.price_usd) * 100), unit_price_lbp: 0, discount_cents: 0, line_total_cents: Math.round(num(p.price_usd) * 100 * it.quantity), voided: false };
      this.lines.set(l.id, l); this.log('order_items', l as unknown as Record<string, unknown>, null);
      if (p.track_stock) this.move({ id: uuidv7(), shop_id: this.shop.id, product_id: p.id, qty: it.quantity, kind: 'reserve', ref_order_id: o.id }, null);
      o.total_cents += l.line_total_cents;
    }
    return o;
  }
  setStatus(orderId: string, status: Order['status'], origin: string | null = null) {
    const o = this.orders.get(orderId)!; if (o.status === status) return;
    o.status = status; o.updated_at = new Date().toISOString();
    if (o.channel === 'online') {
      const at = this.shop.deduct_stock_at;
      if (status === at || (status === 'delivered' && at === 'ready')) {
        for (const l of this.lines.values()) if (l.order_id === o.id && l.product_id && this.products.get(l.product_id)?.track_stock) {
          if ([...this.moves.values()].some(m => m.ref_order_id === o.id && m.product_id === l.product_id && m.kind === 'sale')) continue;
          this.move({ id: uuidv7(), shop_id: this.shop.id, product_id: l.product_id, qty: -num(l.quantity), kind: 'sale', ref_order_id: o.id }, origin);
          this.move({ id: uuidv7(), shop_id: this.shop.id, product_id: l.product_id, qty: -num(l.quantity), kind: 'release', ref_order_id: o.id }, origin);
        }
      } else if (status === 'rejected' || status === 'cancelled') {
        for (const m of [...this.moves.values()]) if (m.ref_order_id === o.id && m.kind === 'reserve' && ![...this.moves.values()].some(r => r.ref_order_id === o.id && r.product_id === m.product_id && r.kind === 'release'))
          this.move({ id: uuidv7(), shop_id: this.shop.id, product_id: m.product_id, qty: -num(m.qty), kind: 'release', ref_order_id: o.id }, origin);
      }
    }
    this.log('orders', o as unknown as Record<string, unknown>, origin);
  }
  revoke(deviceId: string) { const d = this.devices.get(deviceId)!; d.revoked_at = new Date().toISOString(); this.log('devices', d as unknown as Record<string, unknown>, null); }

  // ---- transport ----
  transport(): Transport { return new FakeTransport(this); }

  register(d: { id: string; shop_id: string; name: string }): Device {
    const ex = this.devices.get(d.id); if (ex) { if (ex.revoked_at) throw new SyncError('device_revoked'); return ex; }
    const prefix = String.fromCharCode(65 + this.devices.size);
    const row = { id: d.id, shop_id: this.shop.id, name: d.name, prefix, last_sync_at: null, pending_count: 0, revoked_at: null };
    this.devices.set(d.id, row); this.log('devices', row, null); return row;
  }
  private check(deviceId: string) { const d = this.devices.get(deviceId); if (!d) throw new SyncError('server', 'device_not_found'); if (d.revoked_at) throw new SyncError('device_revoked'); return d; }
  snapshot(deviceId: string): Snapshot {
    const d = this.check(deviceId);
    const strip = (p: Product) => (this.role === 'owner' ? p : (({ cost_cents, ...rest }) => rest as Product)(p));
    return JSON.parse(JSON.stringify({ cursor: this.seq, server_now: new Date().toISOString(), role: this.role, device: { id: d.id, prefix: d.prefix, name: d.name }, shop: this.shop,
      categories: this.categories, products: [...this.products.values()].map(strip), product_barcodes: this.barcodes, quick_buttons: [], exchange_rates: this.rates, shop_members: this.staff,
      devices: [...this.devices.values()], orders: [...this.orders.values()], order_items: [...this.lines.values()], payments: [...this.payments.values()], shifts: [], cash_moves: [], stock_moves: [...this.moves.values()] }));
  }
  pull(deviceId: string, cursor: number, limit = 1000): PullResult {
    const d = this.check(deviceId);
    const rows = this.feed.filter(r => r.seq > cursor).slice(0, limit).map(r => (this.role !== 'owner' && (r.tbl === 'products' || r.tbl === 'order_items') ? { ...r, row: (({ cost_cents, ...rest }) => rest)(r.row) } : r));
    d.last_sync_at = new Date().toISOString();
    return JSON.parse(JSON.stringify({ rows, cursor: rows.length ? rows[rows.length - 1].seq : cursor, count: rows.length, server_now: new Date().toISOString(), role: this.role, device: { id: d.id, prefix: d.prefix, name: d.name } }));
  }
  push(deviceId: string, ops: Array<Pick<OutboxOp, 'op_id' | 'kind' | 'payload' | 'schema_version'>>, pending: number): PushResult {
    const d = this.check(deviceId); d.pending_count = pending;
    const results: PushResult['results'] = [];
    for (const op of ops) {
      const prev = this.ops.get(op.op_id);
      if (prev) { results.push({ ...(prev as PushResult['results'][number]), op_id: op.op_id, replayed: true }); continue; }
      let res: Record<string, unknown>;
      try { res = { ...this.apply(d, op), status: 'ok' }; }
      catch (e) { res = { status: 'rejected', error: (e as Error).message }; }
      this.ops.set(op.op_id, res); results.push({ ...res, op_id: op.op_id } as PushResult['results'][number]);
    }
    return JSON.parse(JSON.stringify({ results, server_now: new Date().toISOString() }));
  }
  private apply(d: Device, op: Pick<OutboxOp, 'kind' | 'payload'>): Record<string, unknown> {
    const p = op.payload as Record<string, any>;
    switch (op.kind) {
      case 'sale.commit': {
        let o = this.orders.get(p.id);
        if (!o) {
          o = { id: p.id, tenant_id: this.shop.tenant_id, shop_id: this.shop.id, number: this.nextNumber(), local_number: p.local_number, status: p.status ?? 'delivered', channel: p.channel ?? 'walkin', device_id: d.id,
            staff_user_id: p.staff_user_id ?? null, shift_id: p.shift_id ?? null, parked: false, customer_name: p.customer_name ?? '', customer_phone: p.customer_phone ?? '', address: p.address ?? {}, fulfillment: p.fulfillment ?? 'pickup',
            notify_customer: !!p.notify_customer, rate_lbp_per_usd: p.rate_lbp_per_usd, subtotal_cents: p.subtotal_cents, discount_cents: p.discount_cents ?? 0, total_cents: p.total_cents, total_lbp: p.total_lbp,
            paid_usd_cents: p.paid_usd_cents ?? 0, paid_lbp: p.paid_lbp ?? 0, change_usd_cents: p.change_usd_cents ?? 0, change_lbp: p.change_lbp ?? 0, placed_at: p.placed_at, delivered_at: p.placed_at, closed_at: p.placed_at };
          this.orders.set(o.id, o); this.log('orders', o as unknown as Record<string, unknown>, d.id);
        }
        for (const l of p.lines ?? []) if (!this.lines.has(l.id)) { const row: OrderLine = { ...l, order_id: o.id, quantity: l.qty, voided: false }; this.lines.set(l.id, row); this.log('order_items', row as unknown as Record<string, unknown>, d.id); }
        for (const pay of p.payments ?? []) if (!this.payments.has(pay.id)) { const row: Payment = { ...pay, order_id: o.id }; this.payments.set(pay.id, row); this.log('payments', row as unknown as Record<string, unknown>, d.id); }
        for (const m of p.stock_moves ?? []) this.move({ id: m.id, shop_id: this.shop.id, product_id: m.product_id, qty: m.qty, kind: m.kind ?? 'sale', ref_order_id: o.id, device_id: d.id, at: m.at }, d.id);
        return { number: o.number, id: o.id };
      }
      case 'order.status': { if (!this.orders.has(p.id)) throw new Error('order_not_found'); this.setStatus(p.id, p.status, d.id); return { status: p.status }; }
      case 'stock.move': { if (!this.products.has(p.product_id)) throw new Error('product_not_found'); this.move({ id: p.id, shop_id: this.shop.id, product_id: p.product_id, qty: p.qty, kind: p.kind, device_id: d.id, note: p.note, unit_cost_cents: p.unit_cost_cents }, d.id); return { ok: true }; }
      case 'product.patch': {
        const prod = this.products.get(p.id); if (!prod) throw new Error('product_not_found');
        let conflicts = 0;
        for (const [k, v] of Object.entries(p.fields as Record<string, unknown>)) {
          if (p.base_updated_at && prod.updated_at > p.base_updated_at && (prod as any)[k] !== v) { this.conflicts.push({ tbl: 'products', row_id: prod.id, field: k, old_value: (prod as any)[k], new_value: v }); conflicts++; }
          (prod as any)[k] = v;
        }
        prod.updated_at = new Date().toISOString(); this.log('products', prod as unknown as Record<string, unknown>, d.id);
        return { conflicts };
      }
      case 'rate.set': { if (this.role === 'cashier' && !p.approved_by) throw new Error('owner_approval_required'); const r: Rate = { id: p.id, shop_id: this.shop.id, lbp_per_usd: p.lbp_per_usd, effective_at: p.effective_at ?? new Date().toISOString() }; this.rates.push(r); this.log('exchange_rates', r as unknown as Record<string, unknown>, d.id); return { ok: true }; }
      case 'shift.open': case 'shift.close': case 'cash.move': return { ok: true };
      default: throw new Error('unknown_op');
    }
  }
}

class FakeTransport implements Transport {
  /** Set to a function to simulate failures: return 'network' to throw before reaching the server, 'timeout' to apply then throw. */
  fault: ((kind: 'register' | 'snapshot' | 'pull' | 'push') => 'network' | 'timeout' | null) | null = null;
  constructor(private s: FakeServer) {}
  private gate(kind: 'register' | 'snapshot' | 'pull' | 'push') { const f = this.fault?.(kind); if (f === 'network') throw new SyncError('network', 'offline'); return f; }
  async register(d: { id: string; shop_id: string; name: string }) { this.gate('register'); return this.s.register(d); }
  async snapshot(id: string) { this.gate('snapshot'); return this.s.snapshot(id); }
  async pull(id: string, cursor: number, limit?: number) { this.gate('pull'); return this.s.pull(id, cursor, limit); }
  async push(id: string, ops: Array<Pick<OutboxOp, 'op_id' | 'kind' | 'payload' | 'schema_version'>>, pending: number) {
    const f = this.gate('push'); const r = this.s.push(id, ops, pending);
    if (f === 'timeout') throw new SyncError('network', 'timeout');
    return r;
  }
}
export type { FakeTransport };
