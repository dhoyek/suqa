'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtBoth, num, text, type CatalogIndex, type Product, type Rate } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import { useScanner } from '../lib/useScanner';

/**
 * M1 preview of the sale screen: proves the offline catalog, the in-memory search and HID scanning. M2 turns this into the
 * cart + pay flow. (Everything shown comes from IndexedDB; the network is never touched here.)
 */
export default function CatalogPreview({ boot, locale, index, tick }: { boot: Booted; locale: L; index: CatalogIndex; tick: number }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const [last, setLast] = useState<{ p: Product | null; code: string } | null>(null);
  const [rate, setRate] = useState<number>(89500);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    boot.db.rates.orderBy('effective_at').reverse().first().then((r: Rate | undefined) => { if (r) setRate(r.lbp_per_usd); });
  }, [boot, tick]);

  // HID scanners type fast and end with Enter; the hook catches that anywhere on the page.
  useScanner(code => { const p = index.scan(code); setLast({ p, code }); if (p) setQ(''); });

  const results = useMemo(() => (q.trim() ? index.search(q, 60, cat) : index.byCategory(cat, 60)), [q, cat, index, tick]);
  const cats = useMemo(() => [...index.categories.values()].sort((a, b) => a.sort_order - b.sort_order), [index, tick]);

  return (
    <div className="pos-sell">
      <div className="pos-pane">
        <input ref={inputRef} className="input big" placeholder={pt('searchItems', locale)} value={q} onChange={e => setQ(e.target.value)} autoFocus
          onKeyDown={e => { if (e.key === 'Enter' && q.trim()) { const p = index.scan(q.trim()); if (p) { setLast({ p, code: q.trim() }); setQ(''); } } }} />
        <div className="chips">
          <button className={`chip ${cat === null ? 'active' : ''}`} onClick={() => setCat(null)}>{pt('items', locale)} · {index.size}</button>
          {cats.map(c => <button key={c.id} className={`chip ${cat === c.id ? 'active' : ''}`} onClick={() => setCat(c.id)}>{text(c.name, locale)}</button>)}
        </div>
        <div className="grid-items">
          {results.map(p => (
            <button key={p.id} className="item-tile" onClick={() => setLast({ p, code: index.barcodes(p.id)[0] ?? '' })}>
              <div className="item-name">{text(p.name, locale)}</div>
              <div className="item-price">{fmtBoth(Math.round(num(p.price_usd) * 100), rate, locale)}</div>
              {p.track_stock && <div className={`muted ${num(p.on_hand) - num(p.reserved) <= num(p.min_stock) ? 'bad' : ''}`} style={{ fontSize: 12 }}>{pt('onHand', locale)}: {num(p.on_hand) - num(p.reserved)}</div>}
            </button>
          ))}
          {!results.length && <p className="muted">{pt('noResults', locale)}</p>}
        </div>
      </div>
      <aside className="pos-pane cart">
        <div className="muted" style={{ fontSize: 13 }}>{pt('rate', locale)}: {rate.toLocaleString('en-US')} LBP / $1</div>
        {last && (
          <div className="card" style={{ marginTop: 12 }}>
            <div className="muted" style={{ fontSize: 12 }}>{pt('scanned', locale)}: {last.code}</div>
            {last.p ? <>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{text(last.p.name, locale)}</div>
              <div>{fmtBoth(Math.round(num(last.p.price_usd) * 100), rate, locale)}</div>
            </> : <div className="bad">{pt('unknownBarcode', locale)}</div>}
          </div>
        )}
        <p className="muted" style={{ marginTop: 'auto', fontSize: 12 }}>{pt('comingSoon', locale)} — M2: {pt('sell', locale)}</p>
      </aside>
    </div>
  );
}
