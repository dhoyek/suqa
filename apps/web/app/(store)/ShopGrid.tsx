'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { t as tr, type Locale, type LocalizedText } from '@suqa/shared';
import { supabaseBrowser } from '@/lib/supabase-browser';
import FavoriteButton from '@/components/FavoriteButton';

type Cat = { id: string; name: LocalizedText };
type ShopCard = { id: string; slug: string; name: LocalizedText; description: LocalizedText; category_id: string | null; min_order_usd: number; open: boolean; logo_url: string | null };

// Category chips filter in the browser: the home page is fetched once and every tap is instant.
// The selected category is mirrored into ?c= so links/refresh keep it, without a server round-trip.
// Signed-in users also get a ★ Favourites chip (their starred shops, loaded client-side so the page stays cacheable).
export default function ShopGrid({ cats, shops, initial, locale: L, tenantId, labels }: {
  cats: Cat[]; shops: ShopCard[]; initial: string | null; locale: Locale; tenantId: string;
  labels: { all: string; minOrder: string; empty: string; favorites: string; noFavorites: string; addFavorite: string; removeFavorite: string };
}) {
  const [c, setC] = useState<string | null>(initial);
  const [favs, setFavs] = useState<Set<string> | null>(null);     // null = not signed in / not loaded
  useEffect(() => {
    const url = c ? `/?c=${c}` : '/';
    if (window.location.pathname + window.location.search !== url) window.history.replaceState(null, '', url);
  }, [c]);
  useEffect(() => {
    const sb = supabaseBrowser();
    sb.auth.getSession().then(async ({ data }) => {
      if (!data.session) return;
      const { data: rows } = await sb.from('favorites').select('shop_id').eq('user_id', data.session.user.id);
      setFavs(new Set((rows ?? []).map(r => r.shop_id as string)));
    });
  }, []);
  const list = useMemo(() => c === 'fav' ? shops.filter(s => favs?.has(s.id)) : c ? shops.filter(s => s.category_id === c) : shops, [c, shops, favs]);
  const toggleFav = (id: string, on: boolean) => setFavs(prev => { const n = new Set(prev ?? []); on ? n.add(id) : n.delete(id); return n; });
  return (
    <>
      <nav className="row chips" style={{ marginBottom: 14 }}>
        <button type="button" className={`chip ${!c ? 'active' : ''}`} onClick={() => setC(null)}>{labels.all}</button>
        {favs && <button type="button" className={`chip ${c === 'fav' ? 'active' : ''}`} onClick={() => setC('fav')}>★ {labels.favorites}{favs.size ? ` (${favs.size})` : ''}</button>}
        {cats.map(cat => <button type="button" key={cat.id} className={`chip ${c === cat.id ? 'active' : ''}`} onClick={() => setC(cat.id)}>{tr(cat.name, L)}</button>)}
      </nav>
      <section className="grid">
        {list.map(s => (
          <Link key={s.id} href={`/s/${s.slug}`} className="card shop-card" prefetch>
            <div className="row" style={{ gap: 10, alignItems: 'center' }}>
              {s.logo_url && <img className="shop-logo" src={s.logo_url} alt="" loading="lazy" />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row spread" style={{ alignItems: 'center' }}>
                  <strong>{tr(s.name, L)}</strong>
                  <span className="row" style={{ gap: 6, alignItems: 'center' }}>
                    <span className={`dot ${s.open ? 'on' : ''}`} />
                    <FavoriteButton shopId={s.id} tenantId={tenantId} initial={favs?.has(s.id)} labels={{ add: labels.addFavorite, remove: labels.removeFavorite }} onChange={on => toggleFav(s.id, on)} />
                  </span>
                </div>
                <div className="muted" style={{ fontSize: 14 }}>{tr(s.description, L)}</div>
              </div>
            </div>
            {s.min_order_usd > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{labels.minOrder}: ${s.min_order_usd.toFixed(2)}</div>}
          </Link>
        ))}
        {!list.length && <p className="muted">{c === 'fav' ? labels.noFavorites : labels.empty}</p>}
      </section>
    </>
  );
}
