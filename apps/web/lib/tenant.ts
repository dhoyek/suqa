import { cache } from 'react';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { resolveTenantByHost, type Tenant } from '@suqa/shared';
import { supabaseServer } from './supabase-server';

/** Current tenant for this request, or null when the host is unknown. Cached per request. */
export const getTenantOrNull = cache(async (): Promise<Tenant | null> => {
  const h = await headers();
  const host = h.get('x-suqa-host') ?? h.get('x-forwarded-host') ?? h.get('host') ?? '';
  const sb = await supabaseServer();
  return resolveTenantByHost(sb, host, process.env.NEXT_PUBLIC_SUQA_DEV_TENANT || undefined);
});

/** Current tenant for this request. 404 if the host is unknown. */
export const getTenant = cache(async (): Promise<Tenant> => {
  const t = await getTenantOrNull();
  if (!t) notFound();
  return t;
});

/** True on dev/staging deploys (any unknown host falls back to one tenant). Used to noindex. */
export const isDevDeploy = () => !!process.env.NEXT_PUBLIC_SUQA_DEV_TENANT;
