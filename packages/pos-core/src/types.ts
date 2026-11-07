// Local rows mirror the server rows (snake_case, same names) so the change feed applies without mapping.
// Money is integer: USD in cents, LBP in whole pounds, rate = LBP per 1 USD.

export type Localized = { ar?: string; en?: string };
export type Currency = 'usd' | 'lbp';
export type Channel = 'online' | 'walkin' | 'whatsapp' | 'phone';
export type OrderStatus = 'pending' | 'accepted' | 'preparing' | 'ready' | 'out_for_delivery' | 'delivered' | 'rejected' | 'cancelled';
export type Tender = 'cash_usd' | 'cash_lbp' | 'card' | 'wallet' | 'unpaid';
export type StockKind = 'sale' | 'return' | 'receive' | 'adjust' | 'count' | 'damaged' | 'reserve' | 'release';
export type Role = 'owner' | 'cashier' | 'stock';

export interface Product {
  id: string; tenant_id: string; shop_id: string;
  name: Localized; description?: Localized;
  price_usd: number | string;            // legacy decimal column (string from Postgres numeric)
  price_currency: Currency; price_lbp: number; cost_cents?: number | null;
  sku?: string | null; unit?: string | null; unit_kind: string; decimal_qty: boolean; vat: boolean;
  track_stock: boolean; min_stock: number | string; visible_online: boolean; is_available: boolean; is_active: boolean;
  on_hand: number | string; reserved: number | string; needs_review: boolean;
  category_id?: string | null; section?: string | null; image_url?: string | null; sort_order?: number;
  updated_at: string;
}
export interface Barcode { product_id: string; shop_id: string; barcode: string }
export interface Category { id: string; tenant_id: string; name: Localized; parent_id?: string | null; sort_order: number; icon?: string | null }
export interface QuickButton { id: string; shop_id: string; product_id: string | null; label?: string | null; color?: string | null; sort_order: number }
export interface Rate { id: string; shop_id: string; lbp_per_usd: number; effective_at: string }
export interface Staff { user_id: string; shop_id: string; role: 'owner' | 'staff' | 'cashier' | 'stock'; display_name?: string | null; full_name?: string | null; pin_hash?: string | null; pin_salt?: string | null; active: boolean }
export interface Device { id: string; shop_id: string; name: string; prefix: string; last_sync_at?: string | null; pending_count?: number; revoked_at?: string | null }
export interface Shop {
  id: string; tenant_id: string; slug: string; name: Localized; pos_enabled: boolean; offline_days: number; max_discount_pct: number | string;
  allow_negative_stock: boolean; lbp_rounding_step: number; deduct_stock_at: 'ready' | 'delivered'; hide_online_when_zero: boolean;
  receipt_footer?: string | null; printer: Record<string, unknown>; whatsapp?: string | null; phone?: string | null; pickup_enabled?: boolean;
}

export interface Order {
  id: string; tenant_id: string; shop_id: string; number?: string | null; local_number?: string | null;
  status: OrderStatus; channel: Channel; device_id?: string | null; staff_user_id?: string | null; shift_id?: string | null; parked: boolean;
  customer_id?: string | null; customer_name: string; customer_phone: string; customer_notes?: string | null; address: Record<string, unknown>;
  fulfillment: 'delivery' | 'pickup'; notify_customer: boolean;
  rate_lbp_per_usd: number; subtotal_cents: number; discount_cents: number; discount_reason?: string | null; total_cents: number; total_lbp: number;
  delivery_fee_usd?: number | string; total_usd?: number | string; courier_fee_cents?: number; courier_name?: string | null;
  paid_usd_cents: number; paid_lbp: number; change_usd_cents: number; change_lbp: number;
  reject_reason?: string | null; cancel_reason?: string | null; shop_notes?: string | null; eta_minutes?: number | null;
  placed_at: string; accepted_at?: string | null; delivered_at?: string | null; closed_at?: string | null; updated_at?: string;
}
export interface OrderLine {
  id: string; order_id: string; product_id: string | null; name: Localized; unit?: string | null; quantity: number | string;
  price_currency: Currency; unit_price_cents: number; unit_price_lbp: number; discount_cents: number; line_total_cents: number;
  cost_cents?: number | null; notes?: string | null; voided: boolean; void_reason?: string | null;
}
export interface Payment { id: string; order_id: string; tender: Tender; amount: number; currency: Currency; reference?: string | null; unpaid_name?: string | null; unpaid_phone?: string | null; note?: string | null; at: string }
export interface StockMove { id: string; shop_id: string; product_id: string; qty: number | string; kind: StockKind; ref_order_id?: string | null; ref_id?: string | null; unit_cost_cents?: number | null; note?: string | null; device_id?: string | null; user_id?: string | null; at: string }
export interface Shift { id: string; shop_id: string; device_id: string; opened_by?: string | null; opened_at: string; float_usd_cents: number; float_lbp: number; closed_by?: string | null; closed_at?: string | null; counted_usd_cents?: number | null; counted_lbp?: number | null; expected_usd_cents?: number | null; expected_lbp?: number | null; diff_usd_cents?: number | null; diff_lbp?: number | null; note?: string | null }
export interface CashMove { id: string; shift_id: string; kind: 'in' | 'out'; amount: number; currency: Currency; reason?: string | null; user_id?: string | null; at: string }
export interface Conflict { id: string; tbl: string; row_id: string; field: string; old_value: unknown; new_value: unknown; by_device?: string | null; at: string; seen: boolean }
export interface CustomerSeen { phone: string; name?: string; last_address?: Record<string, unknown>; last_seen: string }

// ---- sync -------------------------------------------------------------------------------------------
export type OpKind = 'sale.commit' | 'sale.cancel' | 'order.status' | 'order.edit' | 'order.pay' | 'return.commit' | 'stock.move' | 'product.patch' | 'shift.open' | 'shift.close' | 'cash.move' | 'rate.set';
export interface OutboxOp {
  seq?: number;                       // Dexie auto-increment (push order)
  op_id: string;                      // uuid v7
  kind: OpKind;
  payload: Record<string, unknown>;
  schema_version: number;
  created_at: string;
  state: 'pending' | 'rejected';
  tries: number;
  next_try_at: number;                // epoch ms
  last_error?: string;
}
export interface FeedRow { seq: number; tbl: string; row_id: string; op: 'upsert' | 'delete'; row: Record<string, unknown>; origin_device?: string | null }
export interface PullResult { rows: FeedRow[]; cursor: number; count?: number; resync?: boolean; server_now: string; role?: Role; device?: Pick<Device, 'id' | 'prefix' | 'name'> }
export interface PushResult { results: Array<{ op_id: string; status: 'ok' | 'rejected'; replayed?: boolean; number?: string; error?: string; code?: string; detail?: string; [k: string]: unknown }>; server_now: string }
export interface Snapshot {
  cursor: number; server_now: string; role: Role; device: Pick<Device, 'id' | 'prefix' | 'name'>; shop: Shop;
  categories: Category[]; products: Product[]; product_barcodes: Barcode[]; quick_buttons: QuickButton[]; exchange_rates: Rate[];
  shop_members: Staff[]; devices: Device[]; orders: Order[]; order_items: OrderLine[]; payments: Payment[]; shifts: Shift[]; cash_moves: CashMove[]; stock_moves: StockMove[];
}

export class SyncError extends Error {
  constructor(public code: 'network' | 'auth' | 'device_revoked' | 'not_a_member' | 'pos_disabled' | 'server', message?: string) { super(message ?? code); this.name = 'SyncError'; }
}

export interface Transport {
  register(device: { id: string; shop_id: string; name: string; user_agent?: string; app_version?: string }): Promise<Device>;
  snapshot(deviceId: string): Promise<Snapshot>;
  pull(deviceId: string, cursor: number, limit?: number): Promise<PullResult>;
  push(deviceId: string, ops: Array<Pick<OutboxOp, 'op_id' | 'kind' | 'payload' | 'schema_version'>>, pending: number): Promise<PushResult>;
}

export const num = (v: number | string | null | undefined): number => (v == null ? 0 : typeof v === 'number' ? v : Number(v));
