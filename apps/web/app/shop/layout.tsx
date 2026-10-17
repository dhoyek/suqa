import type { ReactNode } from 'react';
import Link from 'next/link';
import { getTenant } from '@/lib/tenant';
import { requireUser, getMyShops } from '@/lib/auth';
import { ui } from '@/lib/ui-text';
import { t as tr } from '@suqa/shared';
import ShopNav from './ShopNav';

export default async function ShopLayout({ children }: { children: ReactNode }) {
  await requireUser('/shop');
  const tenant = await getTenant();
  const shops = await getMyShops();
  const L = tenant.default_locale;

  return (
    <>
      <header className="topbar">
        <div className="container">
          <Link href="/shop" className="brand">{tenant.brand_name}</Link>
          <ShopNav
            shops={shops.map(s => ({ id: s.id, name: tr(s.name, L) }))}
            labels={{ orders: ui('orders', L), products: ui('products', L), myShop: ui('myShop', L), signOut: ui('signOut', L) }}
          />
        </div>
      </header>
      <main className="container">
        {shops.length === 0 ? <div className="card muted">{ui('noShop', L)}</div> : children}
      </main>
    </>
  );
}
