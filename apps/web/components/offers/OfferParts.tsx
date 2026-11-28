'use client';
// An offer's card, its details and its buy buttons — the same on a shop's page and on the all-shops Offers page.
import { useEffect, type ReactNode } from 'react';
import { formatMoney, t as tr, type DisplayCurrency, type Locale, type LocalizedText } from '@suqa/shared';
import { allowsDecimal } from '@/lib/item-match';
import { offerKey, useCart, type ShopRef } from '@/components/CartProvider';
import { useConfirm } from '@/components/ConfirmProvider';
import type { OfferVM } from '@/lib/offer-view';

type Fmt = { fx: number; displayCurrency: DisplayCurrency; L: Locale };
const both = (f: Fmt, cents: number, lbp?: number | null) => formatMoney(cents / 100, f.fx, f.displayCurrency, f.L, lbp);
const main = (f: Fmt, cents: number, lbp?: number | null) => formatMoney(cents / 100, f.fx, f.displayCurrency === 'lbp' ? 'lbp' : 'usd', f.L, lbp);
const other = (f: Fmt, cents: number, lbp?: number | null) => (f.displayCurrency === 'both' ? formatMoney(cents / 100, f.fx, 'lbp', f.L, lbp) : '');

/** add, or − n +. A bundle is one line in the basket; a price offer adds its item at the offer price. */
export function OfferBuy({ vm, shop, L, labels }: { vm: OfferVM; shop: ShopRef; L: Locale; labels: { add: string; replaceCart: string } }) {
  const { add, setQty, qtyOf } = useCart(); const ask = useConfirm(); const ar = L === 'ar';
  if (!vm.ok) return <span className="badge cancelled">{ar ? 'غير متوفر الآن' : 'Not available now'}</span>;
  const p = vm.product; const dec = !!p && allowsDecimal(p as { decimal_qty?: boolean; unit?: string | null; unit_kind?: string | null }); const step = dec ? 0.5 : 1;
  const key = vm.kind === 'bundle' ? offerKey(vm.id) : p!.id; const n = qtyOf(shop.id, key); const max = vm.kind === 'bundle' ? vm.offer.max_per_order ?? 99 : 999;
  const line = vm.kind === 'bundle'
    ? { product_id: key, name: vm.title, unit: null, price_usd: vm.charged / 100, bundle: { items: vm.lines.map(l => ({ name: l.name, qty: l.qty })), normal_usd: vm.normal / 100, max: vm.offer.max_per_order ?? null } }
    : { product_id: key, name: p!.name as LocalizedText, unit: p!.unit ?? null, ...(dec ? { dec: true } : {}), price_usd: vm.charged / 100, ...(vm.lbp ? { lbp: vm.lbp } : {}), days: p!.available_days ?? null };
  return n === 0
    ? <button className="btn primary offer-add" onClick={() => add(shop, line, () => ask(labels.replaceCart))}>+ {labels.add}</button>
    : <div className="stepper">
        <button className="btn" onClick={() => setQty(shop.id, key, Math.round((n - step) * 100) / 100)} aria-label="−">−</button>
        <span className="qty">{n}</span>
        <button className="btn" disabled={n >= max} onClick={() => setQty(shop.id, key, Math.round((n + step) * 100) / 100)} aria-label="+">+</button>
      </div>;
}

export function OfferCard({ vm, fmt, shopName, onOpen, children }: { vm: OfferVM; fmt: Fmt; shopName?: string; onOpen: () => void; children: ReactNode }) {
  const { L } = fmt; const ar = L === 'ar';
  return (
    <article className={`offer-card ${vm.ok ? '' : 'off'}`}>
      <div className={`offer-pics n${vm.pics.length}`} role="button" tabIndex={0} aria-label={ar ? 'تفاصيل العرض' : 'Offer details'} onClick={onOpen} onKeyDown={e => { if (e.key === 'Enter') onOpen(); }} style={{ cursor: 'zoom-in' }}>
        {vm.pics.length ? vm.pics.map((u, i) => <img key={i} src={u} alt="" loading="lazy" />) : <span>{vm.kind === 'bundle' ? '🎁' : '🏷️'}</span>}
        {vm.ok && vm.pct > 0 && <span className="offer-save">−{vm.pct}%</span>}{vm.hot && <span className="offer-hot">🔥</span>}
      </div>
      <div className="offer-body">
        <strong className="offer-name" onClick={onOpen} style={{ cursor: 'pointer' }}>{tr(vm.title, L)}</strong>
        {shopName && <div className="offer-shop">🏪 {shopName}</div>}
        {vm.kind === 'bundle' && <div className="offer-items" onClick={onOpen} style={{ cursor: 'pointer' }}>{vm.lines.map(l => `${l.qty}× ${tr(l.name, L)}`).join(' + ')}</div>}
        <div className="offer-prices"><strong>{main(fmt, vm.charged, vm.lbp)}</strong><s>{main(fmt, vm.normal, vm.normalLbp)}</s></div>
        {other(fmt, vm.charged, vm.lbp) && <div className="offer-other">{other(fmt, vm.charged, vm.lbp)}</div>}
        <div className="offer-buy">{children}</div>
      </div>
    </article>);
}

export function OfferDetail({ vm, fmt, shopName, onClose, children }: { vm: OfferVM; fmt: Fmt; shopName?: string; onClose: () => void; children: ReactNode }) {
  const { L } = fmt; const ar = L === 'ar'; const o = vm.offer; const desc = tr(vm.description, L);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);
  const big = o.image_url || (vm.kind === 'discount' ? vm.pics[0] : null);
  return (
    <div className="dlg-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dlg card item-detail offer-detail" role="dialog" aria-label={tr(vm.title, L)}>
        <div className="row spread" style={{ alignItems: 'center', gap: 8 }}><strong style={{ fontSize: 18, minWidth: 0 }}>{vm.hot ? '🔥 ' : vm.kind === 'bundle' ? '🎁 ' : '🏷️ '}{tr(vm.title, L)}</strong><button type="button" className="btn ghost" onClick={onClose} aria-label="✕">✕</button></div>
        {shopName && <div className="muted" style={{ fontSize: 14 }}>🏪 {shopName}</div>}
        {big && <img className="item-detail-img" src={big} alt={tr(vm.title, L)} />}
        {desc && <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{desc}</p>}
        {vm.kind === 'bundle' && <>
          <div className="col-title" style={{ margin: 0 }}>{ar ? 'ماذا في العرض' : 'What is inside'}</div>
          <div className="offer-detail-items">
            {vm.lines.map(l => (
              <div className="offer-detail-item" key={l.id}>
                {l.image ? <img src={l.image} alt="" loading="lazy" /> : <span className="thumb ph" aria-hidden>{tr(l.name, L).trim().charAt(0)}</span>}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}><span className="qty">{l.qty}×</span> {tr(l.name, L)}{l.unit ? <span className="muted" style={{ fontWeight: 400 }}> · {l.unit}</span> : null}</div>
                  <div className="muted" style={{ fontSize: 13 }}>{ar ? 'السعر العادي' : 'Normal price'} {both(fmt, l.normal, l.normalLbp)}{l.qty > 1 ? ` × ${l.qty}` : ''}</div>
                </div>
              </div>))}
          </div></>}
        {vm.kind === 'discount' && tr(vm.lines[0].name, L) !== tr(vm.title, L) && <div style={{ fontWeight: 600 }}>{tr(vm.lines[0].name, L)}{vm.lines[0].unit ? <span className="muted" style={{ fontWeight: 400 }}> · {vm.lines[0].unit}</span> : null}</div>}
        <div className="offer-detail-sum">
          <div className="row spread"><span className="muted">{ar ? 'السعر العادي' : 'Normal price'}</span><s className="muted">{both(fmt, vm.normal, vm.normalLbp)}</s></div>
          <div className="row spread"><strong>{ar ? 'سعر العرض' : 'Offer price'}</strong><strong style={{ fontSize: 19, color: '#c81e4a' }}>{both(fmt, vm.charged, vm.lbp)}</strong></div>
          {vm.ok && vm.saving > 0 && <div className="row spread" style={{ color: '#15803d', fontWeight: 600 }}><span>{ar ? 'توفّر' : 'You save'}</span><span>{both(fmt, vm.saving, vm.lbp && vm.normalLbp ? vm.normalLbp - vm.lbp : null)} (−{vm.pct}%)</span></div>}
        </div>
        {(o.ends_at || o.max_per_order) && <div className="muted" style={{ fontSize: 13 }}>{o.ends_at ? `${ar ? 'العرض حتى' : 'Until'} ${new Date(o.ends_at).toLocaleDateString(ar ? 'ar-LB' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}` : ''}{o.ends_at && o.max_per_order ? ' · ' : ''}{o.max_per_order ? `${ar ? 'حدّ أقصى' : 'At most'} ${o.max_per_order} ${ar ? 'بالطلب الواحد' : 'per order'}` : ''}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>{children}</div>
      </div>
    </div>);
}
