import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTenant } from '@/lib/tenant';
import { requireUser } from '@/lib/auth';
import { isCourier } from '@/lib/courier';
import { ui } from '@/lib/ui-text';

// Driver app. Exists only when the association turned couriers on (settings.courier_enabled).
export default async function CourierLayout({ children }: { children: ReactNode }) {
  const tenant = await getTenant();
  if (!tenant.settings.courier_enabled) notFound();
  await requireUser('/courier');
  const ok = await isCourier(tenant.id);
  const L = tenant.default_locale;
  return (
    <>
      <header className="topbar">
        <div className="container">
          <Link href="/courier" className="brand">{tenant.brand_name} <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>· {ui('courierApp', L)}</span></Link>
          <form action="/auth/signout" method="post"><button className="btn ghost muted" type="submit">{ui('signOut', L)}</button></form>
        </div>
      </header>
      <main className="container">{ok ? children : <div className="card muted">{ui('notCourier', L)}</div>}</main>
    </>
  );
}
