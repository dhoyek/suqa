import { cache } from 'react';
import { redirect } from 'next/navigation';
import { supabaseServer } from './supabase-server';
import type { Shop } from '@suqa/shared';

export type SessionUser = { id: string; email: string | null };

/** Signed-in user from the session cookie, verified locally (JWT claims) — no round-trip to Supabase Auth. */
export const getUser = cache(async (): Promise<SessionUser | null> => {
  const sb = await supabaseServer();
  const { data } = await sb.auth.getClaims();
  const c = data?.claims as { sub?: string; email?: string } | undefined;
  return c?.sub ? { id: c.sub, email: c.email ?? null } : null;
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
  const mine = ((data as any[]) ?? []).filter(r => r.shop).map(r => ({ ...(r.shop as Shop), role: r.role as 'owner' | 'staff' }));
  // association admins can open every shop's dashboard (as owner); RLS already lets them read/write tenant data
  const user = await getUser();
  if (user) {
    const { data: tm } = await sb.from('tenant_members').select('tenant_id, role').eq('user_id', user.id).eq('role', 'admin');
    for (const t of (tm as { tenant_id: string }[]) ?? []) {
      const { data: all } = await sb.from('shops').select('*').eq('tenant_id', t.tenant_id);
      for (const s of (all as Shop[]) ?? []) if (!mine.some(m => m.id === s.id)) mine.push({ ...s, role: 'owner' });
    }
  }
  return mine.sort((a, b) => a.sort_order - b.sort_order);
});
