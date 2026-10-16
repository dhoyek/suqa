import { cache } from 'react';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { resolveTenantByHost, type Tenant } from '@suqa/shared';
import { supabaseServer } from './supabase-server';

/** Current tenant for this request. Cached per request. 404 if the host is unknown. */
export const getTenant = cache(async (): Promise<Tenant> => {
  const h = await headers();
  const host = h.get('x-suqa-host') ?? h.get('host') ?? '';
  const sb = await supabaseServer();
  const t = await resolveTenantByHost(sb, host, process.env.NEXT_PUBLIC_SUQA_DEV_TENANT);
  if (!t) notFound();
  return t;
});
