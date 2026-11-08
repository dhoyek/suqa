import type { ReactNode } from 'react';
import Link from 'next/link';
import { getTenant } from '@/lib/tenant';
import { redirect } from 'next/navigation';
import { requireUser, getMyShops } from '@/lib/auth';
import { isCourier } from '@/lib/courier';
import { ui } from '@/lib/ui-text';
import { t as tr } from '@suqa/shared';
import ShopNav from './ShopNav';

export default async function ShopLayout({ children }: { children: ReactNode }) {
  await requireUser('/shop');
  const tenant = await getTenant();
  const shops = await getMyShops();
  if (shops.length === 0 && tenant.settings.courier_enabled && await isCourier(tenant.id)) redirect('/courier');
  const L = tenant.default_locale;

  return (
    <>
      <header className="topbar">
        <div className="container">
          <Link href="/shop" className="brand">{tenant.brand_name}</Link>
          <ShopNav
            shops={shops.map(s => ({ id: s.id, name: tr(s.name, L), slug: s.slug }))}
            labels={{ orders: ui('orders', L), products: ui('products', L), myShop: ui('myShop', L), signOut: ui('signOut', L), pos: ui('pos', L), home: ui('home', L), viewAsCustomer: ui('viewAsCustomer', L) }}
          />
        </div>
      </header>
      <main className="container">
        {shops.length === 0 ? <div className="card stack"><p className="muted" style={{ margin: 0 }}>{ui('noShop', L)}</p><Link href="/" className="btn primary" style={{ alignSelf: 'start' }}>{ui('backHome', L)}</Link></div> : children}
      </main>
    </>
  );
}
