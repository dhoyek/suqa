import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTenant } from '@/lib/tenant';
import { requireUser } from '@/lib/auth';
import { isCourier } from '@/lib/courier';
import { getTenantRole } from '@/lib/admin';
import { getLocale } from '@/lib/locale';
import { ui } from '@/lib/ui-text';

// Driver app. Exists only when the association turned couriers on (settings.courier_enabled).
export default async function CourierLayout({ children }: { children: ReactNode }) {
  const tenant = await getTenant();
  if (!tenant.settings.courier_enabled) notFound();
  await requireUser('/courier');
  const courier = await isCourier(tenant.id);
  const admin = (await getTenantRole(tenant.id)) === 'admin';       // admins can open every module (read + act, logged like any member)
  const ok = courier || admin;
  const L = await getLocale(tenant);
  return (
    <>
      <header className="topbar">
        <div className="container">
          <Link href="/courier" className="brand">{tenant.brand_name} <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>· {ui('courierApp', L)}</span></Link>
          <nav className="row" style={{ gap: 6, alignItems: 'center' }}>
            <Link href="/" className="btn ghost muted">🏠 {ui('home', L)}</Link>
            {admin && <Link href="/admin" className="btn ghost muted">🛠️ {ui('admin', L)}</Link>}
            <form action="/auth/signout" method="post"><button className="btn ghost muted" type="submit">{ui('signOut', L)}</button></form>
          </nav>
        </div>
      </header>
      <main className="container">
        {admin && !courier && <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>🛠️ {ui('adminViewing', L)}</p>}
        {ok ? children : (
          <div className="card stack">
            <p className="muted" style={{ margin: 0 }}>{ui('notCourier', L)}</p>
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
