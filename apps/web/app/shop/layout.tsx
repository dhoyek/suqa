import type { ReactNode } from 'react';
import Link from 'next/link';
import { getTenant } from '@/lib/tenant';
import { redirect } from 'next/navigation';
import { requireUser, getMyShops } from '@/lib/auth';
import { getLocale } from '@/lib/locale';
import { getTenantRole } from '@/lib/admin';
import { supabaseServer } from '@/lib/supabase-server';
import ProfileMenu from '@/components/ProfileMenu';
import { isCourier } from '@/lib/courier';
import { ui } from '@/lib/ui-text';
import { t as tr } from '@suqa/shared';
import ShopNav from './ShopNav';

export default async function ShopLayout({ children }: { children: ReactNode }) {
  const user = await requireUser('/shop');
  const tenant = await getTenant();
  type Prof = { full_name: string | null; phone: string | null };
  const [shops, role, profile] = await Promise.all([
    getMyShops(), getTenantRole(tenant.id),
    supabaseServer().then(sb => sb.from('profiles').select('full_name,phone').eq('id', user.id).maybeSingle()).then(r => (r.data as unknown) as Prof | null),
  ]);
  if (shops.length === 0 && tenant.settings.courier_enabled && await isCourier(tenant.id)) redirect('/courier');
  const L = await getLocale(tenant);

  return (
    <>
      <header className="topbar">
        <div className="container">
          <Link href="/shop" className="brand">{tenant.brand_name}</Link>
          <ShopNav
            shops={shops.map(s => ({ id: s.id, name: tr(s.name, L), slug: s.slug }))}
            labels={{ orders: ui('orders', L), products: ui('products', L), myShop: ui('myShop', L), signOut: ui('signOut', L), pos: ui('pos', L), home: ui('home', L), viewAsCustomer: ui('viewAsCustomer', L) }}
          />
          <ProfileMenu user={{ name: profile?.full_name ?? null, phone: profile?.phone ?? null, email: user.email }} staff={shops.length > 0} admin={!!role} locale={L} showHome
            labels={{ account: ui('account', L), signIn: ui('signIn', L), myShop: ui('myShop', L), pos: ui('pos', L), signOut: ui('signOut', L), language: ui('language', L), purchaseHistory: ui('purchaseHistory', L), guest: ui('guest', L), admin: ui('admin', L), home: ui('home', L) }} />
        </div>
      </header>
      <main className="container">
        {shops.length === 0 ? <div className="card stack"><p className="muted" style={{ margin: 0 }}>{ui('noShop', L)}</p><Link href="/" className="btn primary" style={{ alignSelf: 'start' }}>{ui('backHome', L)}</Link></div> : children}
      </main>
    </>
  );
}
