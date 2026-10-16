import { cache } from 'react';
import { redirect } from 'next/navigation';
import { supabaseServer } from './supabase-server';
import type { Shop } from '@suqa/shared';

export const getUser = cache(async () => {
  const sb = await supabaseServer();
  const { data } = await sb.auth.getUser();
  return data.user ?? null;
});

/** Redirects to /login (with return path) when not signed in. */
export async function requireUser(next: string) {
  const user = await getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(next)}`);
  return user;
}

/** Shops the signed-in user is a member of (RLS already restricts shop_members to own rows). */
export const getMyShops = cache(async (): Promise<(Shop & { role: 'owner' | 'staff' })[]> => {
  const sb = await supabaseServer();
  const { data } = await sb.from('shop_members').select('role, shop:shops(*)');
  return ((data as any[]) ?? [])
    .filter(r => r.shop)
    .map(r => ({ ...(r.shop as Shop), role: r.role }))
    .sort((a, b) => a.sort_order - b.sort_order);
});
