'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function AdminNav({ tabs, signOut }: { tabs: { href: string; label: string }[]; signOut: string }) {
  const path = usePathname();
  return (
    <nav className="tabs" style={{ flexWrap: 'wrap' }}>
      {tabs.map(t => <Link key={t.href} href={t.href} className={`tab ${(t.href === '/admin' ? path === '/admin' : path.startsWith(t.href)) ? 'active' : ''}`}>{t.label}</Link>)}
      <form action="/auth/signout" method="post"><button className="btn ghost muted" type="submit">{signOut}</button></form>
    </nav>
  );
}
