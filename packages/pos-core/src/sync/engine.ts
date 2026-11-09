import Dexie from 'dexie';
import { META, getMeta, setMeta, type PosDb } from '../db';
import { SyncError, type FeedRow, type OutboxOp, type Snapshot, type Transport } from '../types';

export interface SyncStatus {
  online: boolean; syncing: boolean; pending: number; rejected: number; lastSyncAt: string | null; lastOnlineAt: string | null;
  error: string | null; revoked: boolean; leader: boolean; cursor: number;
}
export type SyncEvent =
  | { type: 'status'; status: SyncStatus }
  | { type: 'applied'; rows: FeedRow[] }                       // feed rows applied (UI refreshes the index)
  | { type: 'order.new'; orderId: string }                      // a new online/other-device order arrived
  | { type: 'op.rejected'; op: OutboxOp; error: string }
  | { type: 'resync' }
  | { type: 'revoked'; outbox: OutboxOp[] };

export interface EngineOptions {
  db: PosDb; transport: Transport; deviceId: string;
  onEvent?: (e: SyncEvent) => void;
  now?: () => number;
  backoff?: (tries: number) => number;                        // ms
  pullInterval?: number;                                      // ms, default 60s
  batch?: number;                                             // ops per push, default 50
  lockName?: string;                                          // Web Locks key; one leader per shop
}

const TABLE_STORE: Record<string, keyof PosDb & string> = {
  products: 'products', product_barcodes: 'barcodes', categories: 'categories', quick_buttons: 'quickButtons', exchange_rates: 'rates',
  shop_members: 'staff', devices: 'devices', orders: 'orders', order_items: 'orderLines', payments: 'payments', stock_moves: 'stockMoves',
  shifts: 'shifts', cash_moves: 'cashMoves', conflict_log: 'conflicts', returns: 'returns', return_lines: 'returnLines', debt_settlements: 'debtSettlements', debt_allocations: 'debtAllocations', shop_customers: 'shopCustomers', suppliers: 'suppliers', purchases: 'purchases', purchase_lines: 'purchaseLines', supplier_payments: 'supplierPayments', shop_drivers: 'drivers',
};
const defaultBackoff = (tries: number) => Math.min(5 * 60_000, 1000 * 2 ** Math.min(tries, 8)) * (0.8 + Math.random() * 0.4);

/**
 * Outbox push + cursor pull. One instance per open POS tab; the Web Lock elects one leader per shop so only one tab talks
 * to the server. Nothing here is awaited by the sale screen.
 */
export class SyncEngine {
  status: SyncStatus = { online: true, syncing: false, pending: 0, rejected: 0, lastSyncAt: null, lastOnlineAt: null, error: null, revoked: false, leader: false, cursor: 0 };
  private db: PosDb; private t: Transport; private deviceId: string; private opt: EngineOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false; private loopPromise: Promise<void> | null = null; private wake: (() => void) | null = null;
  private releaseLock: (() => void) | null = null;

  constructor(opt: EngineOptions) { this.opt = opt; this.db = opt.db; this.t = opt.transport; this.deviceId = opt.deviceId; }

  private emit(e: SyncEvent) { this.opt.onEvent?.(e); }
  private setStatus(patch: Partial<SyncStatus>) { this.status = { ...this.status, ...patch }; this.emit({ type: 'status', status: this.status }); }
  private now() { return this.opt.now ? this.opt.now() : Date.now(); }

  /** First run on a device: full snapshot. Later runs: nothing (the cursor is in meta). */
  async bootstrap(): Promise<boolean> {
    const cursor = await getMeta<number>(this.db, META.cursor);
    if (cursor !== undefined) { this.setStatus({ cursor }); await this.refreshCounts(); return false; }
    const snap = await this.t.snapshot(this.deviceId);
    await this.applySnapshot(snap);
    return true;
  }

  async applySnapshot(s: Snapshot): Promise<void> {
    await this.db.transaction('rw', this.db.tables, async () => {
      await Promise.all([this.db.products.clear(), this.db.barcodes.clear(), this.db.categories.clear(), this.db.quickButtons.clear(), this.db.rates.clear(),
        this.db.staff.clear(), this.db.devices.clear(), this.db.orders.clear(), this.db.orderLines.clear(), this.db.payments.clear(), this.db.shifts.clear(),
        this.db.cashMoves.clear(), this.db.stockMoves.clear(), this.db.debtSettlements.clear(), this.db.debtAllocations.clear(), this.db.shopCustomers.clear(), this.db.suppliers.clear(), this.db.purchases.clear(), this.db.purchaseLines.clear(), this.db.supplierPayments.clear(), this.db.drivers.clear()]);
      await this.db.products.bulkPut(s.products); await this.db.barcodes.bulkPut(s.product_barcodes); await this.db.categories.bulkPut(s.categories);
      await this.db.quickButtons.bulkPut(s.quick_buttons); await this.db.rates.bulkPut(s.exchange_rates); await this.db.staff.bulkPut(s.shop_members);
      await this.db.devices.bulkPut(s.devices); await this.db.orders.bulkPut(s.orders); await this.db.orderLines.bulkPut(s.order_items);
      await this.db.payments.bulkPut(s.payments); await this.db.shifts.bulkPut(s.shifts); await this.db.cashMoves.bulkPut(s.cash_moves); await this.db.stockMoves.bulkPut(s.stock_moves);
      await this.db.debtSettlements.bulkPut(s.debt_settlements ?? []); await this.db.debtAllocations.bulkPut(s.debt_allocations ?? []); await this.db.shopCustomers.bulkPut(s.shop_customers ?? []);
      await this.db.suppliers.bulkPut(s.suppliers ?? []); await this.db.purchases.bulkPut(s.purchases ?? []); await this.db.purchaseLines.bulkPut(s.purchase_lines ?? []); await this.db.supplierPayments.bulkPut(s.supplier_payments ?? []); await this.db.drivers.bulkPut(s.shop_drivers ?? []);
      await setMeta(this.db, META.shop, s.shop); await setMeta(this.db, META.role, s.role);
      await setMeta(this.db, META.devicePrefix, s.device.prefix); await setMeta(this.db, META.deviceName, s.device.name);
      await setMeta(this.db, META.cursor, s.cursor); await setMeta(this.db, META.lastSyncAt, s.server_now); await setMeta(this.db, META.lastOnlineAt, s.server_now);
    });
    this.setStatus({ cursor: s.cursor, lastSyncAt: s.server_now, lastOnlineAt: s.server_now, online: true, error: null });
    this.emit({ type: 'applied', rows: [] });
  }

  /** Pull the feed until caught up. Returns rows applied. */
  async pull(): Promise<number> {
    let applied = 0;
    for (;;) {
      const cursor = (await getMeta<number>(this.db, META.cursor)) ?? 0;
      const res = await this.t.pull(this.deviceId, cursor, 1000);
      if (res.resync) { this.emit({ type: 'resync' }); const snap = await this.t.snapshot(this.deviceId); await this.applySnapshot(snap); return applied; }
      if (res.rows.length) { await this.applyRows(res.rows, res.cursor); applied += res.rows.length; }
      else await setMeta(this.db, META.cursor, res.cursor);
      await setMeta(this.db, META.lastSyncAt, res.server_now); await setMeta(this.db, META.lastOnlineAt, res.server_now);
      if (res.role) await setMeta(this.db, META.role, res.role);
      this.setStatus({ cursor: res.cursor, lastSyncAt: res.server_now, lastOnlineAt: res.server_now, online: true, error: null });
      if (res.rows.length < 1000) return applied;
    }
  }

  private async applyRows(rows: FeedRow[], cursor: number): Promise<void> {
    const newOrders: string[] = [];
    await this.db.transaction('rw', this.db.tables, async () => {
      for (const r of rows) {
        const store = TABLE_STORE[r.tbl];
        if (r.tbl === 'shops') { if (r.op === 'upsert') await setMeta(this.db, META.shop, r.row); continue; }
        if (!store) continue;
        const table = this.db.table(store);
        if (r.op === 'delete') {
          if (r.tbl === 'product_barcodes') await table.delete([r.row.product_id as string, r.row.barcode as string]);
          else if (r.tbl === 'shop_members') await table.delete(r.row.user_id as string);
          else await table.delete(r.row.id as string);
          continue;
        }
        const key = r.tbl === 'product_barcodes' ? [r.row.product_id as string, r.row.barcode as string] : r.tbl === 'shop_members' ? (r.row.user_id as string) : (r.row.id as string);
        const existing = (await table.get(key as never)) as Record<string, unknown> | undefined;
        if (r.tbl === 'orders' && !existing && r.origin_device !== this.deviceId) newOrders.push(r.row.id as string);
        // merge over the local copy: feed rows are full server rows, but the snapshot adds joined fields (e.g. staff full_name) we keep
        await table.put(existing ? { ...existing, ...r.row } : r.row);
      }
      await setMeta(this.db, META.cursor, cursor);
    });
    this.emit({ type: 'applied', rows });
    for (const id of newOrders) this.emit({ type: 'order.new', orderId: id });
  }

  /** Drain the outbox in order. Network errors stop the drain (retry later with backoff); rejections are recorded and skipped. */
  async push(): Promise<number> {
    let sent = 0;
    for (;;) {
      const due = await this.db.outbox.where('state').equals('pending').sortBy('seq');
      const ready = due.filter(o => o.next_try_at <= this.now());
      if (!ready.length || (due.length && due[0].next_try_at > this.now())) break;   // head blocked by backoff → wait
      const batch = ready.slice(0, this.opt.batch ?? 50);
      let res;
      try {
        res = await this.t.push(this.deviceId, batch.map(o => ({ op_id: o.op_id, kind: o.kind, payload: o.payload, schema_version: o.schema_version })), Math.max(0, due.length - batch.length));
      } catch (e) {
        if (e instanceof SyncError && e.code === 'device_revoked') { await this.handleRevoked(); return sent; }
        const tries = batch[0].tries + 1;
        await this.db.outbox.update(batch[0].seq!, { tries, next_try_at: this.now() + (this.opt.backoff ?? defaultBackoff)(tries), last_error: (e as Error).message });
        this.setStatus({ online: !(e instanceof SyncError && e.code === 'network'), error: (e as Error).message });
        await this.refreshCounts();
        return sent;
      }
      await this.db.transaction('rw', [this.db.outbox, this.db.orders], async () => {
        for (const r of res.results) {
          const op = batch.find(o => o.op_id === r.op_id); if (!op) continue;
          if (r.status === 'ok') {
            if (op.kind === 'sale.commit' && r.number) await this.db.orders.update(op.payload.id as string, { number: r.number as string });
            await this.db.outbox.delete(op.seq!);
          } else {
            await this.db.outbox.update(op.seq!, { state: 'rejected', last_error: r.error ?? 'rejected' });
            this.emit({ type: 'op.rejected', op, error: r.error ?? 'rejected' });
          }
        }
      });
      sent += batch.length;
      await setMeta(this.db, META.lastOnlineAt, res.server_now);
      this.setStatus({ online: true, error: null, lastOnlineAt: res.server_now });
      await this.refreshCounts();
    }
    return sent;
  }

  /** One sync round: push then pull. Safe to call often; concurrent calls coalesce. */
  async sync(): Promise<void> {
    if (this.status.syncing) { this.wake?.(); return; }
    this.setStatus({ syncing: true });
    try {
      await this.push();
      await this.pull();
    } catch (e) {
      if (e instanceof SyncError && e.code === 'device_revoked') await this.handleRevoked();
      else this.setStatus({ online: !(e instanceof SyncError && e.code === 'network'), error: (e as Error).message });
    } finally { this.setStatus({ syncing: false }); }
  }

  /** Called by the Realtime subscription or the UI ("Sync now"). */
  poke(): void { this.wake?.(); if (!this.running) void this.sync(); }

  /** Background loop: leader election (Web Locks) → periodic sync + wake on poke/online. */
  start(): void {
    if (this.running) return; this.running = true;
    const locks = (globalThis.navigator as Navigator | undefined)?.locks;
    const run = async () => {
      this.setStatus({ leader: true });
      while (this.running) {
        await this.sync();
        await new Promise<void>(r => { this.wake = r; this.timer = setTimeout(r, this.opt.pullInterval ?? 60_000); });
        if (this.timer) clearTimeout(this.timer); this.timer = null; this.wake = null;
      }
      this.setStatus({ leader: false });
    };
    if (locks) {
      this.loopPromise = locks.request(this.opt.lockName ?? `suqa-pos-sync-${this.deviceId}`, async () => { await run(); }).then(() => undefined, () => undefined);
    } else {
      this.loopPromise = run();
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline);
      document.addEventListener('visibilitychange', this.onVisible);
    }
  }
  private onOnline = () => this.poke();
  private onVisible = () => { if (document.visibilityState === 'visible') this.poke(); };

  async stop(): Promise<void> {
    this.running = false; this.wake?.(); if (this.timer) clearTimeout(this.timer);
    if (typeof window !== 'undefined') { window.removeEventListener('online', this.onOnline); document.removeEventListener('visibilitychange', this.onVisible); }
    this.releaseLock?.(); await this.loopPromise?.catch(() => undefined);
  }

  async refreshCounts(): Promise<void> {
    const pending = await this.db.outbox.where('state').equals('pending').count();
    const rejected = await this.db.outbox.where('state').equals('rejected').count();
    this.setStatus({ pending, rejected });
  }

  /** Revoked: stop, hand the unsynced outbox to the app (export), wipe local data. */
  private async handleRevoked(): Promise<void> {
    this.running = false;
    const outbox = await this.db.outbox.toArray();
    this.setStatus({ revoked: true, error: 'device_revoked' });
    this.emit({ type: 'revoked', outbox });
    await this.db.delete();
    try { await Dexie.delete(this.db.name); } catch { /* already gone */ }
  }
}
