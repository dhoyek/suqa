import { cache } from 'react';
import { supabaseServer } from './supabase-server';
import { getUser } from './auth';

/** Is the signed-in user an active courier of this tenant? */
export const isCourier = cache(async (tenantId: string): Promise<boolean> => {
  const user = await getUser();
  if (!user) return false;
  const sb = await supabaseServer();
  const { data } = await sb.from('couriers').select('user_id').eq('tenant_id', tenantId).eq('user_id', user.id).eq('is_active', true).maybeSingle();
  return !!data;
});
