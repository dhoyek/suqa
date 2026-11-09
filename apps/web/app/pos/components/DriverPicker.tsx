'use client';
import { useEffect, useState } from 'react';
import { availableDrivers, fmtPhone, fmtUsd, num, text, upsertDriver, waDigits, type Driver, type Order } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import Modal from './Modal';

/** "مين عم يوصّل؟" — one tap sends the order out: a driver (who gets the order on WhatsApp), or the shop itself. */
export default function DriverPicker({ boot, locale, order, onPick, onClose }: { boot: Booted; locale: L; order: Order; onPick: (d: Driver | null) => void; onClose: () => void }) {
  const [drivers, setDrivers] = useState<Driver[]>([]); const [adding, setAdding] = useState(false);
  const [name, setName] = useState(''); const [phone, setPhone] = useState(''); const [err, setErr] = useState<string | null>(null);
  const load = () => availableDrivers(boot.db).then(setDrivers);
  useEffect(() => { load(); }, [boot]); // eslint-disable-line react-hooks/exhaustive-deps
  const add = async () => {
    try { const d = await upsertDriver(boot.db, boot.shop.id, { name, phone }); boot.engine.poke(); setAdding(false); setName(''); setPhone(''); await load(); onPick(d); }
    catch (e) { setErr((e as Error).message === 'bad_phone' ? pt('customerPhone', locale) + ' ?' : (e as Error).message); }
  };
  const online = typeof navigator === 'undefined' ? true : navigator.onLine;
  return (
    <Modal open onClose={onClose} title={`${pt('whoDelivers', locale)} · ${order.number ?? order.local_number ?? ''}`}
      footer={<><button className="btn" onClick={() => setAdding(a => !a)}>＋ {pt('newDriver', locale)}</button><span style={{ flex: 1 }} /><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button></>}>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>{online ? pt('driverGetsWa', locale) : pt('driverOffline', locale)}</p>
      {adding && <div className="row" style={{ gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        <input className="input" placeholder={pt('driverFullName', locale)} value={name} onChange={e => setName(e.target.value)} style={{ flex: 1, minWidth: 120 }} autoFocus />
        <input className="input" dir="ltr" inputMode="tel" placeholder="70 123 456" value={phone} onChange={e => setPhone(e.target.value)} style={{ flex: 1, minWidth: 120 }} />
        <button className="btn primary" disabled={!name.trim() || phone.replace(/\D/g, '').length < 6} onClick={add}>{pt('save', locale)}</button>
        {err && <div className="bad" style={{ flexBasis: '100%' }}>{err}</div>}
      </div>}
      <div className="driver-grid">
        <button className="item-tile" onClick={() => onPick(null)}><strong>🏪 {pt('shopDelivers', locale)}</strong><small className="muted">{pt('noDriverMsg', locale)}</small></button>
        {drivers.map(d => <button key={d.id} className="item-tile" onClick={() => onPick(d)}>
          <strong>🛵 {d.name}</strong><small className="muted" dir="ltr">{fmtPhone(d.phone)}{d.vehicle ? ` · ${d.vehicle}` : ''}</small>
        </button>)}
      </div>
      {!drivers.length && !adding && <p className="muted">{pt('noDrivers', locale)}</p>}
      <details style={{ marginTop: 10 }}><summary className="muted" style={{ fontSize: 13, cursor: 'pointer' }}>{pt('dispatchPreview', locale)}</summary>
        <pre className="muted" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{dispatchText(order, boot, locale)}</pre></details>
    </Modal>
  );
}

/** The same text the server sends the driver — used for the manual 💬 fallback (wa.me) when offline or the template is pending. */
export function dispatchText(o: Order, boot: Booted, locale: L): string {
  const a = (o.address ?? {}) as Record<string, unknown>;
  const where = [a.line1, a.line2].filter(Boolean).join(', ') + (a.notes ? ` — ${a.notes}` : '');
  const map = a.map_url ? String(a.map_url) : (a.lat != null && a.lng != null ? `https://maps.google.com/?q=${a.lat},${a.lng}` : '');
  const paid = num(o.paid_usd_cents) + Math.round((num(o.paid_lbp) * 100) / (num(o.rate_lbp_per_usd) || 89500));
  const cod = num(o.total_cents) - paid > 1 ? fmtUsd(num(o.total_cents) - paid) : null;
  return [
    `🛵 ${pt('dispatchTitle', locale)} ${o.number ?? o.local_number ?? ''} — ${text(boot.shop.name, locale)}`,
    `${pt('customer', locale)}: ${o.customer_name || ''} ${o.customer_phone ? `+${waDigits(o.customer_phone)}` : ''}`.trim(),
    where ? `${pt('address', locale)}: ${where}` : null, map || null,
    cod ? `${pt('toCollect', locale)}: ${cod}` : `${pt('paid', locale)} ✓`,
  ].filter(Boolean).join('\n');
}
