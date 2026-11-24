'use client';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

export default function AdminNav({ tabs, signOut }: { tabs: { href: string; label: string }[]; signOut: string }) {
  const path = usePathname();
  // one swiped line on a phone: bring the current tab into view
  const nav = useRef<HTMLElement>(null);
  useEffect(() => { const el = nav.current?.querySelector('.tab.active') as HTMLElement | null; const box = nav.current; if (el && box && box.scrollWidth > box.clientWidth) box.scrollTo({ left: el.offsetLeft - (box.clientWidth - el.offsetWidth) / 2 }); }, [path]);
  return (
    <nav className="tabs" ref={nav}>
      {tabs.map(t => <Link key={t.href} href={t.href} className={`tab ${(t.href === '/admin' ? path === '/admin' : path.startsWith(t.href)) ? 'active' : ''}`}>{t.label}</Link>)}
      <form action="/auth/signout" method="post"><button className="btn ghost muted" type="submit">{signOut}</button></form>
    </nav>
  );
}
