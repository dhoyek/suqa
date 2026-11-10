import type { ReactNode } from 'react';
import Link from 'next/link';
import { getTenant } from '@/lib/tenant';
import { requireUser } from '@/lib/auth';
import { getTenantRole } from '@/lib/admin';
import { getMyShops } from '@/lib/auth';
import { getLocale } from '@/lib/locale';
import { ui } from '@/lib/ui-text';
import AdminNav from './AdminNav';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireUser('/admin');
  const tenant = await getTenant();
  const role = await getTenantRole(tenant.id);
  const L = await getLocale(tenant);
  const myShops = await getMyShops();
  const pos = role === 'admin' || myShops.some(s => (s as unknown as { pos_enabled?: boolean }).pos_enabled);
  const tabs = [
    { href: '/admin', label: ui('dashboard', L) }, { href: '/admin/shops', label: ui('shops', L) }, { href: '/admin/orders', label: ui('orders', L) },
    { href: '/admin/zones', label: ui('zones', L) }, { href: '/admin/members', label: ui('members', L) }, { href: '/admin/accounts', label: ui('accounts', L) }, { href: '/admin/settings', label: ui('settings', L) },
  ];
  return (
    <>
      <header className="topbar">
        <div className="container" style={{ flexWrap: 'wrap' }}>
          <Link href="/admin" className="brand">{tenant.brand_name} <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>· {ui('admin', L)}</span></Link>
          <AdminNav tabs={tabs} signOut={ui('signOut', L)} />
        </div>
        <div className="container module-links">
          <span className="muted" style={{ fontSize: 12 }}>{ui('goTo', L)}</span>
          <Link href="/" className="chip">🏠 {ui('home', L)}</Link>
          <Link href="/shop/settings" className="chip">🏪 {ui('myShop', L)}</Link>
          {pos && <a href="/pos" className="chip">🖥️ {ui('pos', L)}</a>}
          <Link href="/orders" className="chip">🧾 {ui('purchaseHistory', L)}</Link>
          <Link href="/courier" className="chip">🛵 {ui('courierApp', L)}</Link>
        </div>
      </header>
      <main className="container">
        {role ? children : (
          <div className="card stack">
            <p className="muted" style={{ margin: 0 }}>{ui('notAllowed', L)}</p>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Link href="/" className="btn">🏠 {ui('home', L)}</Link>
              <Link href="/account" className="btn">👤 {ui('myAccount', L)}</Link>
              <form action="/auth/signout" method="post"><button className="btn ghost" type="submit">⎋ {ui('signOut', L)}</button></form>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
