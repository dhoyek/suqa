import type { SuqaClient } from './supabase';
import type { Tenant } from './types';

/** Web: resolve tenant by hostname (suqa.tenant_domains). Falls back to a dev slug for localhost. */
export async function resolveTenantByHost(sb: SuqaClient, hostname: string, devSlug?: string): Promise<Tenant | null> {
  const host = hostname.split(':')[0].toLowerCase();
  const { data } = await sb.from('tenant_domains').select('tenant:tenants(*)').eq('hostname', host).maybeSingle();
  const t = (data as any)?.tenant as Tenant | undefined;
  if (t) return t;
  if (devSlug && (host === 'localhost' || host.endsWith('.local'))) return resolveTenantBySlug(sb, devSlug);
  return null;
}

/** Mobile: tenant slug is fixed at build time. */
export async function resolveTenantBySlug(sb: SuqaClient, slug: string): Promise<Tenant | null> {
  const { data } = await sb.from('tenants').select('*').eq('slug', slug).maybeSingle();
  return (data as Tenant | null) ?? null;
}

/** CSS variables from tenant branding — the whole "brand is config" idea in 6 lines. */
export function brandCssVars(t: Tenant): Record<string, string> {
  return {
    '--brand-primary': t.branding.colors?.primary ?? '#0E7490',
    '--brand-accent': t.branding.colors?.accent ?? '#F59E0B',
  };
}
