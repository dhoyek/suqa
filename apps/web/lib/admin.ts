import { cache } from 'react';
import { supabaseServer } from './supabase-server';
import { getUser } from './auth';

/** Tenant membership of the signed-in user (platform admins count as admins everywhere). */
export const getTenantRole = cache(async (tenantId: string): Promise<'admin' | 'ops' | null> => {
  const user = await getUser();
  if (!user) return null;
  const sb = await supabaseServer();
  const [{ data: pa }, { data: tm }] = await Promise.all([
    sb.from('platform_admins').select('user_id').eq('user_id', user.id).maybeSingle(),
    sb.from('tenant_members').select('role').eq('tenant_id', tenantId).eq('user_id', user.id).maybeSingle(),
  ]);
  if (pa) return 'admin';
  return (tm as any)?.role ?? null;
});

export const SHOP_STATUSES = ['pending', 'active', 'paused', 'disabled'] as const;
