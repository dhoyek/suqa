import { getLocale } from '@/lib/locale';
import type { ReactNode } from 'react';
import { getTenant } from '@/lib/tenant';
import { getMyShops, getUser } from '@/lib/auth';
import { ui } from '@/lib/ui-text';
import { CartProvider } from '@/components/CartProvider';
import StoreHeader from '@/components/StoreHeader';
import ShareButton from '@/components/ShareButton';
import InstallApp, { InstallLink } from '@/components/InstallApp';
import { supabaseServer } from '@/lib/supabase-server';
import { getTenantRole } from '@/lib/admin';
import YorgoChat from '@/components/YorgoChat';
import { yorgoShopperOn } from '@/lib/yorgo/enabled';

export default async function StoreLayout({ children }: { children: ReactNode }) {
  const [tenant, user] = await Promise.all([getTenant(), getUser()]);
  const L = await getLocale(tenant);
  type Prof = { full_name: string | null; phone: string | null };
  // one round of parallel lookups instead of four in a row (each is a trip to the database)
  const yorgoOn = await yorgoShopperOn(tenant.id).catch(() => false);
  const [myShops, role, profile] = user ? await Promise.all([
    getMyShops(), getTenantRole(tenant.id),
    supabaseServer().then(sb => sb.from('profiles').select('full_name,phone').eq('id', user.id).maybeSingle()).then(r => (r.data as unknown) as Prof | null),
  ]) : [[], null, null] as const;
  const admin = !!role;
  const staff = myShops.length > 0;
  return (
    <CartProvider tenantSlug={tenant.slug} multiShop={!!tenant.settings.multi_shop_cart}>
      <StoreHeader brand={tenant.brand_name} logo={tenant.branding?.logo_url ?? null} user={user ? { name: profile?.full_name ?? null, phone: profile?.phone ?? null, email: user.email } : null} staff={staff} admin={admin} locale={L}
        labels={{ cart: ui('cart', L), account: ui('account', L), signIn: ui('signIn', L), myOrders: ui('myOrders', L), myShop: ui('myShop', L), pos: ui('pos', L), signOut: ui('signOut', L), language: ui('language', L), purchaseHistory: ui('purchaseHistory', L), guest: ui('guest', L), admin: ui('admin', L) }} />
      <main className="container">{children}</main>
      <div className="container" style={{ padding: '20px 16px 0' }}>
        <ShareButton path="/" locale={L === 'ar' ? 'ar' : 'en'} label={L === 'ar' ? `شارك ${tenant.brand_name}` : `Share ${tenant.brand_name}`}
          text={L === 'ar' ? `${tenant.brand_name} — اطلب من متاجر منطقتك` : `${tenant.brand_name} — order from your local shops`} />
      </div>
      <footer className="container muted" style={{ fontSize: 12, padding: '24px 16px', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <a href="/legal/privacy">{L === 'ar' ? 'سياسة الخصوصية' : 'Privacy'}</a>·<a href="/legal/terms">{L === 'ar' ? 'الشروط' : 'Terms'}</a>·<a href="/legal/delete-data">{L === 'ar' ? 'حذف البيانات' : 'Delete my data'}</a>
        <InstallLink label={L === 'ar' ? 'ثبّت التطبيق' : 'Install the app'} />
      </footer>
      <InstallApp brand={tenant.brand_name} locale={L === 'ar' ? 'ar' : 'en'} iconUrl={tenant.branding?.app_icon_url ?? null} />
      {yorgoOn && <YorgoChat locale={L === 'ar' ? 'ar' : 'en'} signedIn={!!user} />}
    </CartProvider>
  );
}
