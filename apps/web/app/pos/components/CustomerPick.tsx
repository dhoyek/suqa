'use client';
import { useEffect, useRef, useState } from 'react';
import { fmtPhone, normPhone, searchCustomers, type ShopCustomer } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';

/**
 * Customer picker as a menu that drops under the button that opened it (render it inside a position:relative wrapper next to
 * that button). One search box — type a number or a name and the list filters; ↑ ↓ + Enter pick; when nobody matches (or from the
 * "new customer" row) a number and a name add a new one on the spot.
 */
export default function CustomerPick({ boot, locale, onPick, onClose }: { boot: Booted; locale: L; onPick: (c: { name: string; phone: string }) => void; onClose: () => void }) {
  const [q, setQ] = useState(''); const [matches, setMatches] = useState<ShopCustomer[]>([]); const [hi, setHi] = useState(0);
  const [adding, setAdding] = useState(false); const [phone, setPhone] = useState(''); const [name, setName] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { let on = true; searchCustomers(boot.db, q, 12).then(m => { if (on) { setMatches(m); setHi(0); } }); return () => { on = false; }; }, [boot, q]);
  useEffect(() => {
    const out = (e: MouseEvent | TouchEvent) => { const host = ref.current?.parentElement ?? ref.current; if (host && !host.contains(e.target as Node)) onClose(); };   // the anchor includes the button, so it can toggle
    // Esc closes this menu only (the dialog underneath skips Esc while a [data-esc-layer] is open)
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    const t = setTimeout(() => { document.addEventListener('mousedown', out); document.addEventListener('touchstart', out); }, 0);
    window.addEventListener('keydown', key, true);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', out); document.removeEventListener('touchstart', out); window.removeEventListener('keydown', key, true); };
  }, [onClose]);
  const startAdd = () => { const digits = normPhone(q); const isNum = digits.length >= 3 && /^[\d\s+()-]+$/.test(q.trim()); setPhone(isNum ? q.trim() : ''); setName(isNum ? '' : q.trim()); setAdding(true); };
  const exists = matches.find(m => m.phone_key === normPhone(phone));
  const canAdd = normPhone(phone).length >= 7;
  const add = () => { if (!canAdd) return; onPick(exists ? { name: exists.name || name.trim(), phone: exists.phone } : { name: name.trim(), phone: phone.trim() }); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, matches.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const c = matches[hi]; if (c) onPick({ name: c.name || '', phone: c.phone }); else if (q.trim()) startAdd(); }
  };
  return (
    <div className="cust-pop" ref={ref} data-esc-layer role="dialog" aria-label={pt('pickCustomer', locale)}>
      {!adding ? <>
        <input className="input" autoFocus type="search" placeholder={`🔍 ${pt('searchCustomer', locale)}`} value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey} />
        <div className="cust-pop-list">
          {!q.trim() && matches.length > 0 && <small className="muted cust-pop-hint">{pt('recentCustomers', locale)}</small>}
          {matches.map((c, i) => <button key={c.id} type="button" className={i === hi ? 'hi' : ''} onMouseEnter={() => setHi(i)} onClick={() => onPick({ name: c.name || '', phone: c.phone })}>
            <span className="cust-pop-av">{(c.name || '#').trim().charAt(0).toUpperCase()}</span>
            <span className="cust-pop-who"><strong>{c.name || '—'}</strong><span dir="ltr" className="muted">{fmtPhone(c.phone)}</span></span>
            {c.address?.line1 && <small className="muted">📍 {c.address.line1}</small>}
          </button>)}
          {!matches.length && <p className="muted cust-pop-hint">{pt('noResults', locale)}</p>}
        </div>
        <button type="button" className="cust-pop-new" onClick={startAdd}>＋ {pt('newCustomer', locale)}{q.trim() ? ` “${q.trim()}”` : ''}</button>
      </> : <div className="stack" style={{ gap: 8 }}>
        <strong>＋ {pt('newCustomer', locale)}</strong>
        <input className="input" inputMode="tel" dir="ltr" autoFocus={!phone} placeholder={pt('customerPhone', locale)} value={phone} onChange={e => setPhone(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add(); }} />
        <input className="input" autoFocus={!!phone} placeholder={pt('customerName', locale)} value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add(); }} />
        {exists && <small className="muted">✓ {exists.name || fmtPhone(exists.phone)}</small>}
        <div className="row" style={{ gap: 8 }}><button type="button" className="btn ghost" onClick={() => setAdding(false)}>‹ {pt('back', locale)}</button><span style={{ flex: 1 }} /><button type="button" className="btn primary" disabled={!canAdd} onClick={add}>✓ {pt('ok', locale)}</button></div>
      </div>}
    </div>
  );
}
