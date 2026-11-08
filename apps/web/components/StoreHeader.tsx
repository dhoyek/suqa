'use client';
import Link from 'next/link';
import { useCart } from './CartProvider';

export default function StoreHeader({ brand, labels, signedIn, staff = false, pos = false }: { brand: string; labels: { cart: string; account: string; signIn: string; myOrders: string; myShop?: string; pos?: string }; signedIn: boolean; staff?: boolean; pos?: boolean }) {
  const { count } = useCart();
  return (
    <header className="topbar">
      <div className="container">
        <Link href="/" className="brand">{brand}</Link>
        <nav className="tabs">
          {signedIn && pos && <a href="/pos" className="tab">🧾 {labels.pos}</a>}
          {signedIn && staff && <Link href="/shop" className="tab">{labels.myShop}</Link>}
          {signedIn ? <Link href="/orders" className="tab">{labels.myOrders}</Link> : <Link href="/login?next=/orders" className="tab">{labels.signIn}</Link>}
          <Link href="/cart" className="tab cart-tab" aria-label={labels.cart}>
            🧺 {count > 0 && <span className="count">{count}</span>}
          </Link>
        </nav>
      </div>
    </header>
  );
}
