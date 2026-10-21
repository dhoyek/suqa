import { describe, it, expect, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { shopNewOrder, customerStatus, courierReady, type OrderEvent } from '../server/wa-messages';

const base: OrderEvent = {
  event: 'order.created', old_status: null,
  order: { id: 'o1', number: 'BAT-000012-A', status: 'pending', basket_id: 'b1', customer_name: 'Dany', customer_phone: '+961 70 483 148',
    address: { area: 'Batroun', street: 'Main st', building: 'Bldg 3' }, subtotal_usd: 12.5, delivery_fee_usd: 2, total_usd: 14.5, fx_lbp_rate: 89500, eta_minutes: 25 },
  items: [{ name: { ar: 'زعتر', en: 'Zaatar' }, unit: 'kg', quantity: 0.5, line_total_usd: 5 }, { name: { ar: 'خبز', en: 'Bread' }, quantity: 2, line_total_usd: 7.5 }],
  shop: { id: 's1', slug: 'abou-elie', name: { ar: 'أبو إيلي', en: 'Abou Elie' }, whatsapp: '+96170111222' },
  tenant: { id: 't1', slug: 'batroun', brand_name: 'Batroun Basket', default_locale: 'ar', display_currency: 'both', courier_enabled: true, delivery_mode: 'courier' },
  couriers: ['+96170333444'],
};

describe('wa-messages', () => {
  it('shop message lists items, totals, customer and portal link', () => {
    const m = shopNewOrder(base, 'https://x.test');
    expect(m).toContain('BAT-000012-A'); expect(m).toContain('0.5 kg زعتر'); expect(m).toContain('2× خبز');
    expect(m).toContain('$14.50'); expect(m).toContain('Dany — +961 70 483 148'); expect(m).toContain('https://x.test/shop');
  });
  it('customer messages exist for the notified statuses only', () => {
    for (const s of ['accepted', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'rejected'])
      expect(customerStatus({ ...base, order: { ...base.order, status: s } }, 'https://x.test')).toContain('https://x.test/orders/b/b1');
    expect(customerStatus({ ...base, order: { ...base.order, status: 'cancelled' } }, 'https://x.test')).toBeNull();
    expect(customerStatus({ ...base, order: { ...base.order, status: 'pending' } }, 'https://x.test')).toBeNull();
  });
  it('accepted includes ETA, rejected includes reason, English tenant gets English', () => {
    expect(customerStatus({ ...base, order: { ...base.order, status: 'accepted' } }, 'https://x.test')).toContain('25 دقيقة');
    expect(customerStatus({ ...base, order: { ...base.order, status: 'rejected', reject_reason: 'out of stock' } }, 'https://x.test')).toContain('out of stock');
    const en = { ...base, tenant: { ...base.tenant!, default_locale: 'en' as const } };
    expect(customerStatus({ ...en, order: { ...en.order, status: 'ready' } }, 'https://x.test')).toMatch(/^📦 Your order/);
  });
  it('courier message names the shop and area', () => {
    expect(courierReady(base, 'https://x.test')).toContain('أبو إيلي → Batroun');
  });
});
