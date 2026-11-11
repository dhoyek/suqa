import { v7 as uuidv7 } from 'uuid';
import { CURRENT_SCHEMA_VERSION, META, type PosDb } from './db';
import { num, type Channel, type Currency, type Localized, type Order, type OrderLine, type Payment, type Product, type StockMove } from './types';
import { settle, totals, type Settlement, type Totals } from './money';

export const newId = (): string => uuidv7();

export interface DraftLine {
  id: string; product_id: string | null; name: Localized; unit?: string | null; quantity: number;
  price_currency: Currency; unit_price_cents: number; unit_price_lbp: number; discount_cents: number; cost_cents?: number | null;
  track_stock: boolean; notes?: string | null; voided?: boolean; decimal_qty?: boolean; approved_by?: string | null; void_reason?: string | null;
}
export interface Draft {
  id: string; channel: Channel; lines: DraftLine[]; discount_cents: number; discount_reason?: string | null;
  customer_name?: string; customer_phone?: string; notes?: string | null; fulfillment?: 'delivery' | 'pickup'; address?: Record<string, unknown>; needed_at?: string | null;
  approved_by?: string | null; started_at: string;
  discount_pct?: number | null;        // customer discount % — applied on the subtotal at pay time when larger than discount_cents
}

export const newDraft = (channel: Channel = 'walkin'): Draft => ({ id: newId(), channel, lines: [], discount_cents: 0, started_at: new Date().toISOString() });

export function lineFromProduct(p: Product, quantity = 1): DraftLine {
  return {
    id: newId(), product_id: p.id, name: p.name, unit: p.unit, quantity,
    price_currency: p.price_currency ?? 'usd',
    unit_price_cents: Math.round(num(p.price_usd) * 100), unit_price_lbp: num(p.price_lbp),
    discount_cents: 0, cost_cents: p.cost_cents ?? null, track_stock: !!p.track_stock, decimal_qty: !!p.decimal_qty,
  };
}

/** Add a product: same product (and no line discount/notes) → qty +1 (or +quantity). */
export function addToDraft(d: Draft, p: Product, quantity = 1): Draft {
  const i = d.lines.findIndex(l => l.product_id === p.id && !l.voided && !l.discount_cents && !l.notes && l.unit_price_cents === Math.round(num(p.price_usd) * 100) && l.unit_price_lbp === num(p.price_lbp));
  if (i >= 0) { const lines = d.lines.slice(); lines[i] = { ...lines[i], quantity: round3(lines[i].quantity + quantity) }; return { ...d, lines }; }
  return { ...d, lines: [...d.lines, lineFromProduct(p, quantity)] };
}
export const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export function effectiveDiscount(d: Draft, rate: number): number {
  if (!d.discount_pct) return d.discount_cents;
  const sub = totals(d.lines, 0, rate, 1).subtotal_cents; return Math.max(d.discount_cents, Math.round((sub * Number(d.discount_pct)) / 100));
}
export function draftTotals(d: Draft, rate: number, lbpStep: number): Totals { return totals(d.lines, effectiveDiscount(d, rate), rate, lbpStep); }

export interface CommitInput {
  draft: Draft; payments: Array<Omit<Payment, 'id' | 'order_id' | 'at'> & { id?: string }>; rate: number; lbpStep: number; changeIn: Currency;
  staff_user_id?: string | null; shift_id?: string | null; status?: Order['status']; now?: Date; delivery_fee_cents?: number;
}
export interface CommitResult { order: Order; lines: OrderLine[]; payments: Payment[]; settlement: Settlement; totals: Totals; local_number: string }

/**
 * Commit a sale: ONE IndexedDB transaction over orders, lines, payments, stock moves, product on_hand, outbox and the local
 * counter. Only after it resolves may the UI show "paid"/print. The outbox op is self-contained (the server needs nothing else).
 */
export async function commitSale(db: PosDb, input: CommitInput): Promise<CommitResult> {
  const { draft, rate, lbpStep, changeIn } = input;
  const now = (input.now ?? new Date()).toISOString();
  const live = draft.lines.filter(l => !l.voided);
  if (!live.length) throw new Error('empty_sale');
  const t = totals(draft.lines, effectiveDiscount(draft, rate), rate, lbpStep);
  const pays: Payment[] = input.payments.map(p => ({ ...p, id: p.id ?? newId(), order_id: draft.id, at: now }));
  const s = settle(t.total_cents, pays, rate, lbpStep, changeIn);
  if (s.remaining_cents > 0 && (draft.channel === 'walkin' || pays.length)) throw new Error('not_fully_paid');

  return db.transaction('rw', [db.meta, db.orders, db.orderLines, db.payments, db.stockMoves, db.products, db.outbox, db.customers], async () => {
    const prefix = ((await db.meta.get(META.devicePrefix))?.value as string) ?? '?';
    const deviceId = (await db.meta.get(META.deviceId))?.value as string | undefined;
    const shop = (await db.meta.get(META.shop))?.value as { id: string; tenant_id: string } | undefined;
    const seq = (((await db.meta.get(META.localSeq))?.value as number) ?? 0) + 1;
    await db.meta.put({ key: META.localSeq, value: seq });
    const local_number = `${prefix}-${String(seq).padStart(6, '0')}`;
    const status = input.status ?? (draft.channel === 'walkin' ? 'delivered' : 'accepted');

    const order: Order = {
      id: draft.id, tenant_id: shop?.tenant_id ?? '', shop_id: shop?.id ?? '', number: null, local_number,
      status, channel: draft.channel, device_id: deviceId ?? null, staff_user_id: input.staff_user_id ?? null, shift_id: input.shift_id ?? null, parked: false,
      customer_id: null, customer_name: draft.customer_name ?? '', customer_phone: draft.customer_phone ?? '', customer_notes: draft.notes ?? null,
      address: draft.address ?? {}, fulfillment: draft.fulfillment ?? 'pickup', notify_customer: draft.channel !== 'walkin', needed_at: draft.needed_at ?? null,
      rate_lbp_per_usd: rate, subtotal_cents: t.subtotal_cents, discount_cents: t.discount_cents, discount_reason: draft.discount_reason ?? (draft.discount_pct && t.discount_cents ? `${draft.discount_pct}%` : null),
      total_cents: t.total_cents + (input.delivery_fee_cents ?? 0), total_lbp: t.total_lbp + Math.round(((input.delivery_fee_cents ?? 0) * rate) / 100), total_usd: (t.total_cents + (input.delivery_fee_cents ?? 0)) / 100, delivery_fee_usd: (input.delivery_fee_cents ?? 0) / 100,
      paid_usd_cents: s.paid_usd_cents, paid_lbp: s.paid_lbp, change_usd_cents: s.change_usd_cents, change_lbp: s.change_lbp,
      placed_at: now, delivered_at: status === 'delivered' ? now : null, closed_at: status === 'delivered' ? now : null, updated_at: now,
    };
    const lines: OrderLine[] = draft.lines.map(l => ({
      id: l.id, order_id: draft.id, product_id: l.product_id, name: l.name, unit: l.unit ?? null, quantity: l.quantity,
      price_currency: l.price_currency, unit_price_cents: l.unit_price_cents, unit_price_lbp: l.unit_price_lbp, discount_cents: l.discount_cents,
      line_total_cents: l.voided ? 0 : lineCents(l, rate), cost_cents: l.cost_cents ?? null, notes: l.notes ?? null, voided: !!l.voided, void_reason: l.void_reason ?? null,
    }));
    const moves: StockMove[] = [];
    for (const l of live) {
      if (!l.product_id || !l.track_stock) continue;
      moves.push({ id: newId(), shop_id: order.shop_id, product_id: l.product_id, qty: -l.quantity, kind: 'sale', ref_order_id: draft.id, device_id: deviceId ?? null, user_id: input.staff_user_id ?? null, at: now });
      const p = await db.products.get(l.product_id);
      if (p) await db.products.put({ ...p, on_hand: round3(num(p.on_hand) - l.quantity) });    // optimistic; the feed echo is authoritative
    }

    await db.orders.put(order);
    await db.orderLines.bulkPut(lines);
    await db.payments.bulkPut(pays);
    if (moves.length) await db.stockMoves.bulkPut(moves);
    if (order.customer_phone) await db.customers.put({ phone: order.customer_phone, name: order.customer_name || undefined, last_address: draft.address, last_seen: now });

    await db.outbox.add({
      op_id: newId(), kind: 'sale.commit', schema_version: CURRENT_SCHEMA_VERSION, created_at: now, state: 'pending', tries: 0, next_try_at: 0,
      payload: {
        id: order.id, local_number, channel: order.channel, status, staff_user_id: order.staff_user_id, shift_id: order.shift_id,
        customer_name: order.customer_name, customer_phone: order.customer_phone, notes: order.customer_notes, address: order.address, fulfillment: order.fulfillment, needed_at: order.needed_at ?? null,
        notify_customer: order.notify_customer, rate_lbp_per_usd: rate, subtotal_cents: t.subtotal_cents, discount_cents: t.discount_cents, discount_reason: order.discount_reason,
        total_cents: t.total_cents + (input.delivery_fee_cents ?? 0), total_lbp: t.total_lbp + Math.round(((input.delivery_fee_cents ?? 0) * rate) / 100), delivery_fee_cents: input.delivery_fee_cents ?? 0, paid_usd_cents: s.paid_usd_cents, paid_lbp: s.paid_lbp, change_usd_cents: s.change_usd_cents, change_lbp: s.change_lbp,
        placed_at: now, approved_by: draft.approved_by ?? null,
        voided: draft.lines.filter(l => l.voided).map(l => ({ id: l.id, product_id: l.product_id, name: l.name, qty: l.quantity, reason: l.void_reason ?? null })),
        lines: lines.filter(l => !l.voided).map(l => ({ id: l.id, product_id: l.product_id, name: l.name, unit: l.unit, qty: l.quantity, price_currency: l.price_currency,
          unit_price_cents: l.unit_price_cents, unit_price_lbp: l.unit_price_lbp, discount_cents: l.discount_cents, line_total_cents: l.line_total_cents, cost_cents: l.cost_cents, notes: l.notes, approved_by: draft.lines.find(d => d.id === l.id)?.approved_by ?? null })),
        payments: pays.map(p => ({ id: p.id, tender: p.tender, amount: p.amount, currency: p.currency, reference: p.reference ?? null, unpaid_name: p.unpaid_name ?? null, unpaid_phone: p.unpaid_phone ?? null, note: p.note ?? null, at: p.at })),
        stock_moves: moves.map(m => ({ id: m.id, product_id: m.product_id, qty: m.qty, kind: m.kind, at: m.at })),
      },
    });
    return { order, lines, payments: pays, settlement: s, totals: t, local_number };
  });
}

function lineCents(l: DraftLine, rate: number): number {
  const gross = l.price_currency === 'usd' ? Math.round(l.unit_price_cents * l.quantity) : Math.round((Math.round(l.unit_price_lbp * l.quantity) * 100) / rate);
  return Math.max(0, gross - l.discount_cents);
}

/** Generic enqueue for the other op kinds (stock.move, shift.open/close, cash.move, rate.set, order.status, product.patch). */
export async function enqueue(db: PosDb, kind: import('./types').OpKind, payload: Record<string, unknown>): Promise<string> {
  const op_id = newId();
  await db.outbox.add({ op_id, kind, payload, schema_version: CURRENT_SCHEMA_VERSION, created_at: new Date().toISOString(), state: 'pending', tries: 0, next_try_at: 0 });
  return op_id;
}

// ---- drafts (park / resume / crash recovery) ----
export async function saveDraft(db: PosDb, draft: Draft, parked = false, label?: string): Promise<void> {
  await db.drafts.put({ id: draft.id, parked: parked ? 1 : 0, updated_at: new Date().toISOString(), label, draft });
  if (!parked) await db.meta.put({ key: META.currentDraft, value: draft.id });
}
export async function loadCurrentDraft(db: PosDb): Promise<Draft | null> {
  const id = (await db.meta.get(META.currentDraft))?.value as string | undefined;
  if (!id) return null;
  const row = await db.drafts.get(id);
  if (!row || row.parked) return null;
  // the order id is the draft id: a draft that already became an order was sold / saved — drop it, never show it again
  if (await db.orders.get(id)) { await dropDraft(db, id); return null; }
  return row.draft as Draft;
}
export async function listParked(db: PosDb): Promise<Array<{ id: string; label?: string; updated_at: string; draft: Draft }>> {
  const rows = await db.drafts.where('parked').equals(1).reverse().sortBy('updated_at');
  return rows.map(r => ({ id: r.id, label: r.label, updated_at: r.updated_at, draft: r.draft as Draft }));
}
export async function dropDraft(db: PosDb, id: string): Promise<void> {
  await db.drafts.delete(id);
  const cur = (await db.meta.get(META.currentDraft))?.value;
  if (cur === id) await db.meta.delete(META.currentDraft);
}
/** Cancel an unpaid sale with a reason: nothing is sold; the server only audits it. */
export async function cancelDraft(db: PosDb, draft: Draft, reason: string, staffUserId?: string | null): Promise<void> {
  await dropDraft(db, draft.id);
  if (draft.lines.length) await enqueue(db, 'sale.cancel', { id: draft.id, reason, staff_user_id: staffUserId ?? null, lines: draft.lines.length, at: new Date().toISOString() });
}
