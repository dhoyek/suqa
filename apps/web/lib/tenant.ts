import { cache } from 'react';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { resolveTenantByHost, type Tenant } from '@suqa/shared';
import { supabaseServer } from './supabase-server';

// Hostname → tenant is looked up on every request; keep it in the function instance for a short while
// so a warm server answers without a database round-trip. Admin settings saves show up within TTL.
const TENANT_TTL_MS = 30_000;
const tenantCache = new Map<string, { t: Tenant | null; at: number }>();

/** Current tenant for this request, or null when the host is unknown. Cached per request + 30 s per instance. */
export const getTenantOrNull = cache(async (): Promise<Tenant | null> => {
  const h = await headers();
  const host = (h.get('x-suqa-host') ?? h.get('x-forwarded-host') ?? h.get('host') ?? '').split(':')[0].toLowerCase();
  const hit = tenantCache.get(host);
  if (hit && Date.now() - hit.at < TENANT_TTL_MS) return hit.t;
  const sb = await supabaseServer();
  const t = await resolveTenantByHost(sb, host, process.env.NEXT_PUBLIC_SUQA_DEV_TENANT || undefined);
  tenantCache.set(host, { t, at: Date.now() });
  return t;
});

/** Current tenant for this request. 404 if the host is unknown. */
export const getTenant = cache(async (): Promise<Tenant> => {
  const t = await getTenantOrNull();
  if (!t) notFound();
  return t;
});

/** True on dev/staging deploys (any unknown host falls back to one tenant). Used to noindex. */
export const isDevDeploy = () => !!process.env.NEXT_PUBLIC_SUQA_DEV_TENANT;
