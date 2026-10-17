// Hand-written domain types. Replace/augment with generated database.types.ts (npm run db:types).
export type Locale = 'ar' | 'en' | 'fr';
export type LocalizedText = Partial<Record<Locale, string>>;
export type DisplayCurrency = 'usd' | 'lbp' | 'both';

export type OrderStatus =
  | 'pending' | 'accepted' | 'preparing' | 'ready'
  | 'out_for_delivery' | 'delivered' | 'rejected' | 'cancelled';

export interface Tenant {
  id: string; slug: string; name: string; brand_name: string;
  status: 'draft' | 'live' | 'suspended';
  default_locale: Locale; locales: Locale[];
  display_currency: DisplayCurrency; fx_lbp_rate: number; commission_rate: number;
  timezone: string; country_code: string;
  branding: { logo_url?: string | null; colors?: { primary?: string; accent?: string }; app_icon_url?: string | null };
  settings: { support_phone?: string | null; whatsapp_number?: string | null; min_order_usd?: number;
    multi_shop_cart?: boolean; delivery_mode?: 'per_shop' | 'courier'; courier_fee_usd?: number | null };
}

export interface Shop {
  id: string; tenant_id: string; slug: string; name: LocalizedText; description: LocalizedText;
  status: 'pending' | 'active' | 'paused' | 'disabled';
  phone: string | null; whatsapp: string | null; address_text: string | null;
  logo_url: string | null; cover_url: string | null;
  opening_hours: Record<string, [string, string][]>; is_open_override: boolean | null;
  min_order_usd: number; prep_minutes: number; commission_rate: number | null; category_id: string | null; sort_order: number;
}

export interface Product {
  id: string; tenant_id: string; shop_id: string; name: LocalizedText; description: LocalizedText;
  price_usd: number; unit: string | null; image_url: string | null;
  is_available: boolean; is_active: boolean; section: string | null; sort_order: number;
}

export interface Category { id: string; tenant_id: string; slug: string; name: LocalizedText; icon: string | null; sort_order: number; parent_id: string | null }

export interface Address {
  id: string; tenant_id: string; user_id: string; label: string | null; line1: string; line2: string | null;
  notes: string | null; phone: string | null; is_default: boolean;
}

export interface Order {
  id: string; tenant_id: string; shop_id: string; customer_id: string; number: string;
  basket_id: string | null; basket_seq: string | null;
  status: OrderStatus; payment_method: 'cod' | 'card'; zone_id: string | null; address: Address;
  customer_name: string; customer_phone: string; customer_notes: string | null;
  subtotal_usd: number; delivery_fee_usd: number; total_usd: number; fx_lbp_rate: number;
  commission_rate: number; commission_usd: number; shop_notes: string | null; reject_reason: string | null;
  eta_minutes: number | null; placed_at: string; accepted_at: string | null; delivered_at: string | null;
}

export interface OrderItem {
  id: string; order_id: string; product_id: string | null; name: LocalizedText; unit: string | null;
  unit_price_usd: number; quantity: number; line_total_usd: number; notes: string | null;
}

export interface CartLine { product_id: string; quantity: number; notes?: string }

export interface Basket {
  id: string; tenant_id: string; customer_id: string; number: string; delivery_mode: 'per_shop' | 'courier';
  address: Record<string, unknown>; customer_name: string; customer_phone: string; customer_notes: string | null;
  subtotal_usd: number; delivery_fee_usd: number; total_usd: number; fx_lbp_rate: number; shop_count: number; placed_at: string;
}
