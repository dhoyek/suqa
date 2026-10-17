'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { t as tr, type Locale, type LocalizedText } from '@suqa/shared';

type Cat = { id: string; name: LocalizedText };
type ShopCard = { id: string; slug: string; name: LocalizedText; description: LocalizedText; category_id: string | null; min_order_usd: number; open: boolean; logo_url: string | null };

// Category chips filter in the browser: the home page is fetched once and every tap is instant.
// The selected category is mirrored into ?c= so links/refresh keep it, without a server round-trip.
export default function ShopGrid({ cats, shops, initial, locale: L, labels }: {
  cats: Cat[]; shops: ShopCard[]; initial: string | null; locale: Locale;
  labels: { all: string; minOrder: string; empty: string };
}) {
  const [c, setC] = useState<string | null>(initial);
  useEffect(() => {
    const url = c ? `/?c=${c}` : '/';
    if (window.location.pathname + window.location.search !== url) window.history.replaceState(null, '', url);
  }, [c]);
  const list = c ? shops.filter(s => s.category_id === c) : shops;
  return (
    <>
      <nav className="row chips" style={{ marginBottom: 14 }}>
        <button type="button" className={`chip ${!c ? 'active' : ''}`} onClick={() => setC(null)}>{labels.all}</button>
        {cats.map(cat => <button type="button" key={cat.id} className={`chip ${c === cat.id ? 'active' : ''}`} onClick={() => setC(cat.id)}>{tr(cat.name, L)}</button>)}
      </nav>
      <section className="grid">
        {list.map(s => (
          <Link key={s.id} href={`/s/${s.slug}`} className="card shop-card" prefetch>
            <div className="row" style={{ gap: 10, alignItems: 'center' }}>
              {s.logo_url && <img className="shop-logo" src={s.logo_url} alt="" loading="lazy" />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row spread"><strong>{tr(s.name, L)}</strong><span className={`dot ${s.open ? 'on' : ''}`} /></div>
                <div className="muted" style={{ fontSize: 14 }}>{tr(s.description, L)}</div>
              </div>
            </div>
            {s.min_order_usd > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{labels.minOrder}: ${s.min_order_usd.toFixed(2)}</div>}
          </Link>
        ))}
        {!list.length && <p className="muted">{labels.empty}</p>}
      </section>
    </>
  );
}
