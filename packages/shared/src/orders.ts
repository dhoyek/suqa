import type { SuqaClient } from './supabase';
import type { Basket, CartLine, Order, OrderStatus } from './types';

/** The only way to create an order: server-side RPC computes prices, zone and fee. */
export async function placeOrder(sb: SuqaClient, shopId: string, addressId: string, items: CartLine[], notes?: string): Promise<Order> {
  const { data, error } = await sb.rpc('place_order', { p_shop: shopId, p_address_id: addressId, p_items: items, p_notes: notes ?? null });
  if (error) throw error;
  return data as Order;
}

/** Several shops in one checkout: the server splits it into one order per shop. */
export async function placeBasket(sb: SuqaClient, addressId: string, shops: { shop_id: string; items: CartLine[]; notes?: string }[], notes?: string): Promise<Basket> {
  const { data, error } = await sb.rpc('place_basket', { p_address_id: addressId, p_shops: shops, p_notes: notes ?? null });
  if (error) throw error;
  return data as Basket;
}

export async function setOrderStatus(sb: SuqaClient, orderId: string, status: OrderStatus, extra?: { reject_reason?: string; shop_notes?: string; eta_minutes?: number }) {
  const { error } = await sb.from('orders').update({ status, ...extra }).eq('id', orderId);
  if (error) throw error;
}

export const NEXT_STATUS: Partial<Record<OrderStatus, OrderStatus[]>> = {
  pending: ['accepted', 'rejected'], accepted: ['preparing'], preparing: ['ready'],
  ready: ['out_for_delivery', 'delivered'], out_for_delivery: ['delivered'],
};
