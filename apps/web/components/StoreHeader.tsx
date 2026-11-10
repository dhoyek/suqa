'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useCart } from './CartProvider';

export type HeaderUser = { name: string | null; phone: string | null; email: string | null } | null;
type Labels = { cart: string; account: string; signIn: string; myOrders: string; myShop?: string; pos?: string; signOut: string; language: string; purchaseHistory: string; guest: string; admin: string };

export default function StoreHeader({ brand, labels, user, staff = false, pos = false, admin = false, locale }: { brand: string; labels: Labels; user: HeaderUser; staff?: boolean; pos?: boolean; admin?: boolean; locale: 'ar' | 'en' }) {
  const { count } = useCart();
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
  const initial = (user?.name || user?.phone || user?.email || '?').trim().charAt(0).toUpperCase();
  return (
    <header className="topbar">
      <div className="container">
        <Link href="/" className="brand">{brand}</Link>
        <nav className="tabs">
          {user && staff && <a href="/pos" className="tab">🧾 {labels.pos}</a>}
          <Link href="/cart" className="tab cart-tab" aria-label={labels.cart}>
            🧺 {count > 0 && <span className="count">{count}</span>}
          </Link>
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
                {user && <Link href="/account" className="item" onClick={() => setOpen(false)}>👤 {labels.account}</Link>}
                {user && <Link href="/orders" className="item" onClick={() => setOpen(false)}>🧾 {labels.purchaseHistory}</Link>}
                {user && staff && <Link href="/shop/settings" className="item" onClick={() => setOpen(false)}>🏪 {labels.myShop}</Link>}
                {user && staff && <a href="/pos" className="item">🖥️ {labels.pos}</a>}
                {user && admin && <Link href="/admin" className="item" onClick={() => setOpen(false)}>🛠️ {labels.admin}</Link>}
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
                  : <Link href={`/login?next=${encodeURIComponent(path)}`} className="item strong" onClick={() => setOpen(false)}>→ {labels.signIn}</Link>}
              </div>
            )}
          </div>
        </nav>
      </div>
    </header>
  );
}
