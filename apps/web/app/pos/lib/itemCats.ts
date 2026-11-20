'use client';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CatalogIndex, Localized } from '@suqa/pos-core';

/**
 * The association's shared item categories (87_item_categories) in the till, in THIS shop's own order when it chose one
 * (89_shop_section_order): read from this device first (so the names, the chips and the picker work offline), then refreshed from
 * the server when there is a connection.
 */
export type ItemCat = { key: string; name: Localized; sort_order: number };
const LS = (tenant: string) => `suqa-item-cats-${tenant}`;
const LSO = (shop: string) => `suqa-section-order-${shop}`;

/** the shared list in a shop's order: the sections it listed first, as listed; the rest after them, in the shared order */
export function inShopOrder<T extends { key: string; sort_order: number }>(cats: T[], keys: string[]): T[] {
  if (!keys.length) return cats;
  const at = new Map(keys.map((k, i) => [k, i]));
  return [...cats].sort((a, b) => (at.get(a.key) ?? 1e6 + a.sort_order) - (at.get(b.key) ?? 1e6 + b.sort_order)).map((c, i) => ({ ...c, sort_order: i }));
}
export function cachedSectionOrder(shopId: string): string[] {
  try { const v = JSON.parse(localStorage.getItem(LSO(shopId)) ?? '[]'); return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : []; } catch { return []; }
}
function rawCats(tenantId: string): ItemCat[] { try { return JSON.parse(localStorage.getItem(LS(tenantId)) ?? '[]') as ItemCat[]; } catch { return []; } }
export function cachedItemCats(tenantId: string, shopId: string): ItemCat[] { return inShopOrder(rawCats(tenantId), cachedSectionOrder(shopId)); }

export async function refreshItemCats(sb: SupabaseClient, tenantId: string, index: CatalogIndex, shopId: string): Promise<boolean> {
  const [{ data, error }, ord] = await Promise.all([
    sb.from('item_categories').select('key,name,sort_order').eq('tenant_id', tenantId).order('sort_order').order('key'),
    sb.from('shop_section_order').select('keys').eq('shop_id', shopId).maybeSingle(),          // (not installed yet = an error = keep what this device has)
  ]);
  if (error || !data) return false;
  const keys = ord.error ? cachedSectionOrder(shopId) : (((ord.data as { keys?: string[] } | null)?.keys) ?? []);
  try { localStorage.setItem(LS(tenantId), JSON.stringify(data)); localStorage.setItem(LSO(shopId), JSON.stringify(keys)); } catch { /* storage full: the list still serves this session */ }
  index.setShared(inShopOrder(data as ItemCat[], keys));
  return true;
}
/** A shop adds a category that is missing; it joins the shared list (the server returns the existing one for the same name). */
export async function addItemCat(sb: SupabaseClient, shopId: string, tenantId: string, index: CatalogIndex, en: string, ar: string): Promise<string> {
  const { data, error } = await sb.rpc('item_category_add', { p_shop: shopId, p_en: en.trim() || null, p_ar: ar.trim() || null });
  if (error) throw new Error(error.message);
  await refreshItemCats(sb, tenantId, index, shopId);
  return (data as { key: string }).key;
}
/** The shop saves the order of its sections (an empty list = back to the association's order); the chips follow at once. */
export async function saveSectionOrder(sb: SupabaseClient, shopId: string, tenantId: string, index: CatalogIndex, keys: string[]): Promise<void> {
  const { error } = await sb.rpc('shop_section_order_set', { p_shop: shopId, p_keys: keys });
  if (error) throw new Error(error.message);
  await refreshItemCats(sb, tenantId, index, shopId);
}
