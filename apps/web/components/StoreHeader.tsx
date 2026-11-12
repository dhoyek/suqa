'use client';
import Link from 'next/link';
import { useCart } from './CartProvider';
import ProfileMenu, { type HeaderUser, type ProfileLabels } from './ProfileMenu';

export type { HeaderUser };
type Labels = ProfileLabels & { cart: string; myOrders: string };

export default function StoreHeader({ brand, labels, user, staff = false, admin = false, locale }: { brand: string; labels: Labels; user: HeaderUser; staff?: boolean; pos?: boolean; admin?: boolean; locale: 'ar' | 'en' }) {
  const { count } = useCart();
  return (
    <header className="topbar">
      <div className="container">
        <Link href="/" className="brand">{brand}</Link>
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
