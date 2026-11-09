import { cookies } from 'next/headers';
import type { Tenant } from '@suqa/shared';

export const LANG_COOKIE = 'suqa-lang';
export type Locale = 'ar' | 'en';

/** Storefront language: the visitor's choice (cookie, set from the profile menu) or the tenant default. */
export async function getLocale(tenant: Pick<Tenant, 'default_locale'>): Promise<Locale> {
  try {
    const c = (await cookies()).get(LANG_COOKIE)?.value;
    if (c === 'ar' || c === 'en') return c;
  } catch { /* outside a request scope */ }
  return tenant.default_locale === 'en' ? 'en' : 'ar';
}
