import type { ReactNode } from 'react';
import { getTenant } from '@/lib/tenant';
import { getUser } from '@/lib/auth';
import { ui } from '@/lib/ui-text';
import { CartProvider } from '@/components/CartProvider';
import StoreHeader from '@/components/StoreHeader';

export default async function StoreLayout({ children }: { children: ReactNode }) {
  const tenant = await getTenant();
  const user = await getUser();
  const L = tenant.default_locale;
  return (
    <CartProvider tenantSlug={tenant.slug} multiShop={!!tenant.settings.multi_shop_cart}>
      <StoreHeader brand={tenant.brand_name} signedIn={!!user}
        labels={{ cart: ui('cart', L), account: ui('account', L), signIn: ui('signIn', L), myOrders: ui('myOrders', L) }} />
      <main className="container">{children}</main>
      <footer className="container muted" style={{ fontSize: 12, padding: '24px 16px', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <a href="/legal/privacy">{L === 'ar' ? 'سياسة الخصوصية' : 'Privacy'}</a>·<a href="/legal/terms">{L === 'ar' ? 'الشروط' : 'Terms'}</a>·<a href="/legal/delete-data">{L === 'ar' ? 'حذف البيانات' : 'Delete my data'}</a>
      </footer>
    </CartProvider>
  );
}
