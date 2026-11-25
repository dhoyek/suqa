import type { SuqaClient } from './supabase';
import type { Tenant } from './types';

/** What every visitor may read of an association (schema 114): everything but its commission. Name the columns —
 *  the public key is refused a `select('*')` on tenants. */
export const TENANT_PUBLIC_COLS = 'id,slug,name,brand_name,status,default_locale,locales,display_currency,fx_lbp_rate,timezone,country_code,center,branding,settings,created_at,updated_at';
/** What every visitor may read of a shop (schema 114): its public card. The till's settings, its margins, its commission and
 *  what it pays its drivers are the shop's own business — the public key is refused them, and a `select('*')` on shops. */
export const SHOP_PUBLIC_COLS = 'id,tenant_id,slug,name,description,status,phone,whatsapp,address_text,location,logo_url,cover_url,opening_hours,is_open_override,min_order_usd,prep_minutes,sort_order,created_at,updated_at,category_id,pickup_enabled,pos_enabled,hide_online_when_zero,default_delivery_fee_usd,known_as,known_as_en,section_names';

/** Web: resolve tenant by hostname (suqa.tenant_domains).
 *  If devSlug is set (NEXT_PUBLIC_SUQA_DEV_TENANT — dev/staging sites only, never production),
 *  any hostname not found in tenant_domains resolves to that tenant. */
export async function resolveTenantByHost(sb: SuqaClient, hostname: string, devSlug?: string): Promise<Tenant | null> {
  const host = hostname.split(':')[0].toLowerCase();
  const { data } = await sb.from('tenant_domains').select(`tenant:tenants(${TENANT_PUBLIC_COLS})`).eq('hostname', host).maybeSingle();
  const t = (data as any)?.tenant as Tenant | undefined;
  if (t) return t;
  if (devSlug) return resolveTenantBySlug(sb, devSlug);
  return null;
}

/** Mobile: tenant slug is fixed at build time. */
export async function resolveTenantBySlug(sb: SuqaClient, slug: string): Promise<Tenant | null> {
  const { data } = await sb.from('tenants').select(TENANT_PUBLIC_COLS).eq('slug', slug).maybeSingle();
  return (data as Tenant | null) ?? null;
}

/** CSS variables from tenant branding — the whole "brand is config" idea in 6 lines. */
export function brandCssVars(t: Tenant): Record<string, string> {
  return {
    '--brand-primary': t.branding.colors?.primary ?? '#0E7490',
    '--brand-accent': t.branding.colors?.accent ?? '#F59E0B',
  };
}
