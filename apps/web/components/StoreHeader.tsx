'use client';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useCart } from './CartProvider';
import ProfileMenu, { type HeaderUser, type ProfileLabels } from './ProfileMenu';

export type { HeaderUser };
type Labels = ProfileLabels & { cart: string; myOrders: string };

export default function StoreHeader({ brand, logo = null, labels, user, staff = false, admin = false, locale }: { brand: string; logo?: string | null; labels: Labels; user: HeaderUser; staff?: boolean; pos?: boolean; admin?: boolean; locale: 'ar' | 'en' }) {
  const { count } = useCart();
  // Back button on every page but the home page. Installed as an app there is no browser bar, so this is the only visible way back.
  // It retraces the customer's steps when he came from inside the site (keeps his place in a long list); arriving from a link
  // (WhatsApp, a shared shop) there is nothing to retrace, so it goes to the page's parent.
  const path = usePathname() || '/'; const router = useRouter();
  const steps = useRef(0);
  useEffect(() => { steps.current += 1; }, [path]);
  const parent = path.startsWith('/checkout') ? '/cart' : /^\/orders\/.+/.test(path) ? '/orders' : '/';
  const back = () => { if (steps.current > 1) router.back(); else router.push(parent); };
  const backLabel = locale === 'ar' ? 'رجوع' : 'Back';
  return (
    <header className="topbar">
      <div className="container">
        {path !== '/' && <button type="button" className="back-btn" onClick={back} aria-label={backLabel} title={backLabel}>{locale === 'ar' ? '→' : '←'}</button>}
        <Link href="/" className="brand">{logo && <img className="brand-logo" src={logo} alt="" />}<span>{brand}</span></Link>
        <nav className="tabs">
          {user && staff && <a href="/pos" className="tab">🧾 {labels.pos}</a>}
          {user && <Link href="/orders" className="tab">📦 {labels.myOrders}</Link>}
          <Link href="/cart" className="tab cart-tab" aria-label={labels.cart}>
            🧺 {count > 0 && <span className="count">{count}</span>}
          </Link>
        </nav>
        {/* outside .tabs: on phones the tabs scroll sideways, which would clip the dropdown */}
        <ProfileMenu user={user} staff={staff} admin={admin} locale={locale} labels={labels} />
      </div>
    </header>
  );
}
