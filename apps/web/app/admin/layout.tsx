import type { ReactNode } from 'react';
import Link from 'next/link';
import { getTenant } from '@/lib/tenant';
import { requireUser } from '@/lib/auth';
import { getTenantRole } from '@/lib/admin';
import { ui } from '@/lib/ui-text';
import AdminNav from './AdminNav';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireUser('/admin');
  const tenant = await getTenant();
  const role = await getTenantRole(tenant.id);
  const L = tenant.default_locale;
  const tabs = [
    { href: '/admin', label: ui('dashboard', L) }, { href: '/admin/shops', label: ui('shops', L) }, { href: '/admin/orders', label: ui('orders', L) },
    { href: '/admin/zones', label: ui('zones', L) }, { href: '/admin/members', label: ui('members', L) }, { href: '/admin/settings', label: ui('settings', L) },
  ];
  return (
    <>
      <header className="topbar">
        <div className="container" style={{ flexWrap: 'wrap' }}>
          <Link href="/admin" className="brand">{tenant.brand_name} <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>· {ui('admin', L)}</span></Link>
          <AdminNav tabs={tabs} signOut={ui('signOut', L)} />
        </div>
      </header>
      <main className="container">
        {role ? children : <div className="card muted">{ui('notAllowed', L)}</div>}
      </main>
    </>
  );
}
