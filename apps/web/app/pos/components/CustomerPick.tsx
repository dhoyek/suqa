'use client';
import { useEffect, useState } from 'react';
import { fmtPhone, normPhone, searchCustomers, type ShopCustomer } from '@suqa/pos-core';
import Modal from './Modal';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';

/**
 * Pick a customer — the same look as the cart's customer dialog: number and name fields that search as you type, the matches as
 * a tidy list (name, formatted number, address), recent customers as chips, and a new number can be used straight away.
 */
export default function CustomerPick({ boot, locale, onPick, onClose }: { boot: Booted; locale: L; onPick: (c: { name: string; phone: string }) => void; onClose: () => void }) {
  const [phone, setPhone] = useState(''); const [name, setName] = useState('');
  const [matches, setMatches] = useState<ShopCustomer[]>([]);
  useEffect(() => { let on = true; searchCustomers(boot.db, phone || name, 8).then(m => { if (on) setMatches(m); }); return () => { on = false; }; }, [boot, phone, name]);
  const key = normPhone(phone);
  const exact = matches.find(m => m.phone_key === key);
  const typing = !!(phone.trim() || name.trim());
  const canUseNew = key.length >= 7 && !exact;
  const use = () => { if (exact) onPick({ name: exact.name || name.trim(), phone: exact.phone }); else if (canUseNew) onPick({ name: name.trim(), phone: phone.trim() }); };
  return (
    <Modal open onClose={onClose} title={`👤 ${pt('pickCustomer', locale)}`}
      footer={<><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} /><button className="btn primary" disabled={!exact && !canUseNew} onClick={use}>✓ {exact ? (exact.name || fmtPhone(exact.phone)) : canUseNew ? pt('newCustomer', locale) : pt('ok', locale)}</button></>}>
      <div className="stack" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label className="label" style={{ flex: '1 1 160px' }}>{pt('customerPhone', locale)}
            <input className="input" inputMode="tel" dir="ltr" autoFocus placeholder="70 123 456" value={phone} onChange={e => setPhone(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') use(); }} /></label>
          <label className="label" style={{ flex: '1 1 160px' }}>{pt('customerName', locale)}
            <input className="input" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') use(); }} /></label>
        </div>
        {!typing && matches.length > 0 && <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}><small className="muted">{pt('recentCustomers', locale)}:</small>{matches.map(c => <button key={c.id} className="chip" onClick={() => onPick({ name: c.name || '', phone: c.phone })}>{c.name || fmtPhone(c.phone)}</button>)}</div>}
        {typing && matches.length > 0 && <div className="cust-list static">
          {matches.map(c => <button key={c.id} type="button" onClick={() => onPick({ name: c.name || '', phone: c.phone })}>
            <strong>{c.name || '—'}</strong><span dir="ltr" className="muted">{fmtPhone(c.phone)}</span>{c.address?.line1 && <small className="muted">📍 {c.address.line1}</small>}
          </button>)}
        </div>}
        {typing && !matches.length && <p className="muted" style={{ margin: 0 }}>{canUseNew ? `＋ ${pt('newCustomer', locale)}` : pt('noResults', locale)}</p>}
      </div>
    </Modal>
  );
}
