'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { t as tr, type Locale, type LocalizedText } from '@suqa/shared';
import { supabaseBrowser } from '@/lib/supabase-browser';
import FilterIcon from '@/components/FilterIcon';
import DoorIcon from '@/components/DoorIcon';
import FavoriteButton from '@/components/FavoriteButton';
import ShareButton from '@/components/ShareButton';

type Cat = { id: string; name: LocalizedText };
type ShopCard = { id: string; slug: string; name: LocalizedText; /** what people call it, e.g. the owner's name */ known_as?: string | null; known_as_en?: string | null; description: LocalizedText; category_id: string | null; min_order_usd: number; open: boolean; reopen?: string | null; logo_url: string | null };

// Filters run in the browser: the home page is fetched once and every tap is instant.
// Chips: ★ Favourites (signed-in users; loaded client-side so the page stays cacheable), Open, Closed, then the category
// filter — the same sheet as inside a shop: type to narrow the list, tick several. Chosen categories are mirrored into ?c=.
export default function ShopGrid({ cats, shops, initial, locale: L, tenantId, brand, labels }: {
  cats: Cat[]; shops: ShopCard[]; initial: string | null; locale: Locale; tenantId: string; brand: string;
  labels: { all: string; minOrder: string; empty: string; favorites: string; noFavorites: string; addFavorite: string; removeFavorite: string; categories: string; clearFilter: string; typeToFilter: string; ok: string };
}) {
  const [sel, setSel] = useState<Set<string>>(() => new Set((initial ?? '').split(',').filter(id => cats.some(x => x.id === id))));
  const [fav, setFav] = useState(false);
  const [st, setSt] = useState<'open' | 'closed' | null>(null);
  const [sheet, setSheet] = useState(false); const [catQ, setCatQ] = useState('');
  const toggleCat = (id: string) => setSel(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const reset = () => { setSel(new Set()); setFav(false); setSt(null); };
  const c = [...sel].join(',');
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
  const [q, setQ] = useState('');
  // search by shop name (both languages), what people call it, or its description; Arabic letter variants are folded
  const fold = (t: string) => t.toLowerCase().replace(/[\u064B-\u0652\u0640]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
  const list = useMemo(() => {
    const base = shops.filter(s => (!fav || favs?.has(s.id)) && (!st || s.open === (st === 'open')) && (!sel.size || (s.category_id != null && sel.has(s.category_id))));
    const n = fold(q.trim()); if (!n) return base;
    return base.filter(s => fold([s.name.ar, s.name.en, s.known_as, s.known_as_en, s.description?.ar, s.description?.en].filter(Boolean).join(' ')).includes(n));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c, fav, st, shops, favs, q]);
  const toggleFav = (id: string, on: boolean) => setFavs(prev => { const n = new Set(prev ?? []); on ? n.add(id) : n.delete(id); return n; });
  return (
    <>
      {/* the filter button keeps its place at the end of the first line; the chips beside it slide sideways if the screen is narrow */}
      <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: sel.size ? 8 : 14 }}>
      <nav className="row chips-scroll" style={{ flex: 1, minWidth: 0 }}>
        <button type="button" className={`chip ${!fav && !st && !sel.size ? 'active' : ''}`} onClick={reset}>{labels.all}</button>
        {favs && <button type="button" className={`chip ${fav ? 'active' : ''}`} aria-pressed={fav} onClick={() => setFav(v => !v)}>★ {labels.favorites}{favs.size ? ` (${favs.size})` : ''}</button>}
        {/* icons keep the row on one line on a phone; the words stay for screen readers and as a tooltip */}
        <button type="button" className={`chip ${st === 'open' ? 'active' : ''}`} aria-pressed={st === 'open'} title={L === 'ar' ? 'مفتوح الآن' : 'Open now'} aria-label={L === 'ar' ? 'مفتوح الآن' : 'Open now'} onClick={() => setSt(v => v === 'open' ? null : 'open')}><DoorIcon open /></button>
        <button type="button" className={`chip ${st === 'closed' ? 'active' : ''}`} aria-pressed={st === 'closed'} title={L === 'ar' ? 'مغلق الآن' : 'Closed now'} aria-label={L === 'ar' ? 'مغلق الآن' : 'Closed now'} onClick={() => setSt(v => v === 'closed' ? null : 'closed')}><DoorIcon open={false} /></button>
      </nav>
        {cats.length > 1 && <button type="button" className={`btn ${sel.size ? 'primary' : ''}`} style={{ flex: 'none' }} onClick={() => setSheet(true)} aria-label={labels.categories}><FilterIcon />{sel.size ? ` ${sel.size}` : ''}</button>}
      </div>
      {sel.size > 0 && (
        <nav className="row chips" style={{ marginBottom: 14 }}>
          {cats.filter(x => sel.has(x.id)).map(x => <button type="button" key={x.id} className="chip active" onClick={() => toggleCat(x.id)}>{tr(x.name, L)} ✕</button>)}
          <button type="button" className="chip" onClick={() => setSel(new Set())}>{labels.clearFilter}</button>
        </nav>
      )}
      {sheet && (
        <div className="dlg-backdrop" onClick={e => { if (e.target === e.currentTarget) setSheet(false); }}>
          <div className="dlg card" role="dialog" aria-label={labels.categories}>
            <div className="row spread" style={{ alignItems: 'center' }}><strong>{labels.categories}{sel.size ? ` (${sel.size})` : ''}</strong><button type="button" className="btn ghost" onClick={() => setSheet(false)} aria-label="✕">✕</button></div>
            <input className="input" placeholder={labels.typeToFilter} value={catQ} onChange={e => setCatQ(e.target.value)} />
            <div className="cat-list">
              {cats.filter(x => !catQ.trim() || fold(`${x.name.ar ?? ''} ${x.name.en ?? ''}`).includes(fold(catQ.trim()))).map(x => <label key={x.id} className={`cat-row ${sel.has(x.id) ? 'active' : ''}`}><input type="checkbox" checked={sel.has(x.id)} onChange={() => toggleCat(x.id)} /> <span>{tr(x.name, L)}</span></label>)}
            </div>
            <div className="row spread"><button type="button" className="btn" onClick={() => setSel(new Set())}>✕ {labels.clearFilter}</button><button type="button" className="btn primary" onClick={() => setSheet(false)}>{labels.ok}</button></div>
          </div>
        </div>
      )}
      {shops.length > 4 && <input className="input" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder={L === 'ar' ? '🔍 ابحث عن متجر أو صاحبه…' : '🔍 Search a shop or its owner…'} style={{ marginBottom: 12 }} />}
      <section className="grid">
        {list.map(s => (
          <Link key={s.id} href={`/s/${s.slug}`} className={`card shop-card ${s.open ? 'is-open' : 'is-closed'}`} prefetch>
            <div className="row" style={{ gap: 10, alignItems: 'center' }}>
              {s.logo_url ? <img className="shop-logo" src={s.logo_url} alt="" loading="lazy" /> : <span className="shop-logo ph" aria-hidden>{(tr(s.name, L) || '•').trim().charAt(0)}</span>}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row spread" style={{ alignItems: 'center' }}>
                  <strong>{tr(s.name, L)}</strong>
                  <span className="row" style={{ gap: 6, alignItems: 'center' }}>
                    <span className={`open-pill ${s.open ? 'on' : ''}`}>{s.open ? (L === 'ar' ? 'مفتوح' : 'Open') : (L === 'ar' ? 'مغلق' : 'Closed')}</span>
                    <ShareButton path={`/s/${s.slug}`} locale={L === 'ar' ? 'ar' : 'en'} iconOnly className="btn ghost share-mini" label={L === 'ar' ? 'مشاركة المتجر' : 'Share this shop'}
                      text={L === 'ar' ? `اطلب من ${tr(s.name, L)} عبر ${brand}` : `Order from ${tr(s.name, L)} on ${brand}`} />
                    <FavoriteButton shopId={s.id} tenantId={tenantId} initial={favs?.has(s.id)} labels={{ add: labels.addFavorite, remove: labels.removeFavorite }} onChange={on => toggleFav(s.id, on)} />
                  </span>
                </div>
                {(L === 'en' ? s.known_as_en || s.known_as : s.known_as || s.known_as_en) && <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--brand-primary)' }}>{L === 'en' ? s.known_as_en || s.known_as : s.known_as || s.known_as_en}</div>}
                <div className="muted" style={{ fontSize: 14 }}>{tr(s.description, L)}</div>
              </div>
            </div>
            {!s.open && <div className="closed-note">{s.reopen ? `${L === 'ar' ? 'يفتح' : 'Opens'} ${s.reopen} · ` : ''}{L === 'ar' ? 'يمكنك الطلب لوقت لاحق' : 'you can order for later'}</div>}
            {s.min_order_usd > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{labels.minOrder}: ${s.min_order_usd.toFixed(2)}</div>}
          </Link>
        ))}
        {!list.length && <p className="muted">{fav && !st && !sel.size ? labels.noFavorites : labels.empty}</p>}
      </section>
    </>
  );
}
