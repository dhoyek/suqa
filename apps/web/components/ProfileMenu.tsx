'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';

export type HeaderUser = { name: string | null; phone: string | null; email: string | null } | null;
export type ProfileLabels = { account: string; signIn: string; myShop?: string; pos?: string; signOut: string; language: string; purchaseHistory: string; guest: string; admin: string; home?: string };

/** The avatar + dropdown shown in every header (storefront, shop dashboard): who is signed in and the shortcuts their roles give them. */
export default function ProfileMenu({ user, staff = false, admin = false, locale, labels, showHome = false }: { user: HeaderUser; staff?: boolean; admin?: boolean; locale: 'ar' | 'en'; labels: ProfileLabels; showHome?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const path = usePathname() || '/';
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  useEffect(() => { setOpen(false); }, [path]);
  const initial = (user?.name || user?.phone || user?.email || '?').trim().charAt(0).toUpperCase();
  const on = (p: string) => (path === p || path.startsWith(p + '/') ? ' current' : '');
  return (
    <div className="profile-menu" ref={ref}>
      <button type="button" className={`avatar ${user ? '' : 'guest'}`} aria-label={labels.account} aria-expanded={open} onClick={() => setOpen(o => !o)}>
        {user ? initial : '👤'}
      </button>
      {open && (
        <div className="menu card">
          {user ? (
            <div className="who">
              <strong>{user.name || labels.account}</strong>
              {user.phone && <div className="muted" dir="ltr">+{user.phone.replace(/^\+/, '')}</div>}
              {!user.phone && user.email && <div className="muted" dir="ltr">{user.email}</div>}
            </div>
          ) : <div className="who muted">{labels.guest}</div>}
          {showHome && <Link href="/" className="item">🏠 {labels.home}</Link>}
          {user && <Link href="/account" className={`item${on('/account')}`}>👤 {labels.account}</Link>}
          {user && <Link href="/orders" className={`item${on('/orders')}`}>🧾 {labels.purchaseHistory}</Link>}
          {user && staff && <Link href="/shop/settings" className={`item${on('/shop')}`}>🏪 {labels.myShop}</Link>}
          {user && staff && <a href="/pos" className="item">🖥️ {labels.pos}</a>}
          {user && admin && <Link href="/admin" className={`item${on('/admin')}`}>🛠️ {labels.admin}</Link>}
          <form action="/api/lang" method="post" className="item lang">
            <input type="hidden" name="next" value={path} />
            <span className="muted">{labels.language}</span>
            <span className="seg">
              <button type="submit" name="lang" value="ar" className={locale === 'ar' ? 'on' : ''}>عربي</button>
              <button type="submit" name="lang" value="en" className={locale === 'en' ? 'on' : ''}>EN</button>
            </span>
          </form>
          {user
            ? <form action="/auth/signout" method="post"><button type="submit" className="item danger">⎋ {labels.signOut}</button></form>
            : <Link href={`/login?next=${encodeURIComponent(path)}`} className="item strong">→ {labels.signIn}</Link>}
        </div>
      )}
    </div>
  );
}
