'use client';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

export default function ShopNav({ shops, labels }: { shops: { id: string; name: string }[]; labels: { orders: string; products: string; myShop: string; signOut: string } }) {
  const path = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const current = params.get('shop') ?? shops[0]?.id;
  const q = current && shops.length > 1 ? `?shop=${current}` : '';

  return (
    <>
      {shops.length > 1 && (
        <select className="input" style={{ width: 'auto', minHeight: 36, padding: '6px 10px' }} value={current}
          onChange={e => router.push(`${path}?shop=${e.target.value}`)} aria-label="shop">
          {shops.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}
      <nav className="tabs">
        <Link href={`/shop${q}`} className={`tab ${path === '/shop' ? 'active' : ''}`}>{labels.orders}</Link>
        <Link href={`/shop/products${q}`} className={`tab ${path.startsWith('/shop/products') ? 'active' : ''}`}>{labels.products}</Link>
        <Link href={`/shop/settings${q}`} className={`tab ${path.startsWith('/shop/settings') ? 'active' : ''}`}>{labels.myShop}</Link>
        <form action="/auth/signout" method="post"><button className="btn ghost muted" type="submit">{labels.signOut}</button></form>
      </nav>
    </>
  );
}
