'use client';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CatalogIndex, Localized } from '@suqa/pos-core';

/**
 * The association's shared item categories (87_item_categories) in the till: read from this device first (so the names and the
 * picker work offline), then refreshed from the server when there is a connection.
 */
export type ItemCat = { key: string; name: Localized; sort_order: number };
const LS = (tenant: string) => `suqa-item-cats-${tenant}`;

export function cachedItemCats(tenantId: string): ItemCat[] {
  try { return JSON.parse(localStorage.getItem(LS(tenantId)) ?? '[]') as ItemCat[]; } catch { return []; }
}
export async function refreshItemCats(sb: SupabaseClient, tenantId: string, index: CatalogIndex): Promise<boolean> {
  const { data, error } = await sb.from('item_categories').select('key,name,sort_order').eq('tenant_id', tenantId).order('sort_order').order('key');
  if (error || !data) return false;
  try { localStorage.setItem(LS(tenantId), JSON.stringify(data)); } catch { /* storage full: the list still serves this session */ }
  index.setShared(data as ItemCat[]);
  return true;
}
/** A shop adds a category that is missing; it joins the shared list (the server returns the existing one for the same name). */
export async function addItemCat(sb: SupabaseClient, shopId: string, tenantId: string, index: CatalogIndex, en: string, ar: string): Promise<string> {
  const { data, error } = await sb.rpc('item_category_add', { p_shop: shopId, p_en: en.trim() || null, p_ar: ar.trim() || null });
  if (error) throw new Error(error.message);
  await refreshItemCats(sb, tenantId, index);
  return (data as { key: string }).key;
}
