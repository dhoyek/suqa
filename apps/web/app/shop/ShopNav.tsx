'use client';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

export default function ShopNav({ shops, labels }: { shops: { id: string; name: string; slug: string }[]; labels: { orders: string; products: string; myShop: string; signOut: string; pos?: string; home: string; viewAsCustomer: string } }) {
  const path = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const current = params.get('shop') ?? shops[0]?.id;
  const q = current && shops.length > 1 ? `?shop=${current}` : '';
  const slug = shops.find(s => s.id === current)?.slug ?? shops[0]?.slug;

  return (
    <>
      {shops.length > 1 && (
        <select className="input" style={{ width: 'auto', minHeight: 36, padding: '6px 10px' }} value={current}
          onChange={e => router.push(`${path}?shop=${e.target.value}`)} aria-label="shop">
          {shops.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}
      <nav className="tabs">
        <a href="/pos#orders" className="tab pos-tab">🧾 {labels.pos} · {labels.orders}</a>
        <a href="/pos#items" className="tab">🏷 {labels.products}</a>
        <Link href={`/shop/settings${q}`} className={`tab ${path.startsWith('/shop/settings') ? 'active' : ''}`}>⚙ {labels.myShop}</Link>
        {slug && <Link href={`/s/${slug}`} className="tab" title={labels.viewAsCustomer}>👁 {labels.viewAsCustomer}</Link>}
      </nav>
    </>
  );
}
