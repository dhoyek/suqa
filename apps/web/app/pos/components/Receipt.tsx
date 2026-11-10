'use client';
import { useEffect, useState } from 'react';
import { fmtLbp, fmtUsd, text, usdToLbp, type CommitResult, type Shop } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import Modal from './Modal';
import { doPrint, loadPrintSettings, receiptHtml } from '../lib/print';

/**
 * Receipt after a sale: shop, date, numbers (local now, shop-wide once synced), lines, totals in USD + LBP, rate, payments, change.
 * Actions: new sale (Enter), print (M3 — browser print for now), WhatsApp (text now, template once approved), QR to /r/<id>.
 */
export default function Receipt({ result, shop, locale, cashier, serverNumber, onNew }: { result: CommitResult; shop: Shop; locale: L; cashier: string; serverNumber?: string | null; onNew: () => void }) {
  const { order, lines, payments, settlement: s } = result;
  const [qr, setQr] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [waState, setWaState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [phone, setPhone] = useState(order.customer_phone ?? '');
  const url = `${location.origin}/r/${order.id}`;
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Enter' && !showQr) onNew(); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onNew, showQr]);
  useEffect(() => { if (showQr && !qr) import('qrcode').then(m => m.toDataURL(url, { width: 280, margin: 1 })).then(setQr).catch(() => setQr(null)); }, [showQr, qr, url]);

  const sendWa = async () => {
    if (!phone.trim()) return;
    setWaState('sending');
    try {
      const r = await fetch('/api/pos/receipt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order_id: order.id, phone: phone.trim(), locale }) });
      setWaState(r.ok ? 'sent' : 'error');
    } catch { setWaState('error'); }
  };
  const rate = order.rate_lbp_per_usd;
  return (
    <div className="receipt-wrap">
      <div className="receipt" id="receipt">
        <div className="r-head"><strong>{text(shop.name, locale)}</strong><div className="muted">{shop.phone ?? ''}</div></div>
        <div className="r-meta">
          <span>{pt('orderNo', locale)} {serverNumber ?? order.number ?? order.local_number}{serverNumber || order.number ? ` (${order.local_number})` : ''}</span>
          <span>{new Date(order.placed_at).toLocaleString(locale === 'ar' ? 'ar-LB-u-nu-latn' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' })}</span>
        </div>
        <table className="r-lines"><tbody>
          {lines.filter(l => !l.voided).map(l => (
            <tr key={l.id}><td>{text(l.name, locale)}<div className="muted">{l.quantity} × {l.price_currency === 'usd' ? fmtUsd(l.unit_price_cents) : fmtLbp(l.unit_price_lbp, locale)}{l.discount_cents ? ` − ${fmtUsd(l.discount_cents)}` : ''}</div></td><td className="num">{fmtUsd(l.line_total_cents)}</td></tr>
          ))}
        </tbody></table>
        <div className="r-totals">
          {order.discount_cents > 0 && <div><span>{pt('discount', locale)}</span><span>−{fmtUsd(order.discount_cents)}</span></div>}
          <div className="big"><span>{pt('total', locale)}</span><span>{fmtUsd(order.total_cents)}</span></div>
          <div className="big"><span></span><span>{fmtLbp(order.total_lbp, locale)}</span></div>
          <div className="muted"><span>{pt('rate', locale)}</span><span>{rate.toLocaleString('en-US')} / $1</span></div>
          {payments.map(p => <div key={p.id}><span>{pt(p.tender, locale)}{p.unpaid_name ? ` · ${p.unpaid_name}` : ''}</span><span>{p.currency === 'lbp' ? fmtLbp(p.amount, locale) : fmtUsd(p.amount)}</span></div>)}
          {(s.change_usd_cents > 0 || s.change_lbp > 0) && <div><span>{pt('change', locale)}</span><span>{s.change_usd_cents ? fmtUsd(s.change_usd_cents) : fmtLbp(s.change_lbp, locale)}</span></div>}
        </div>
        <div className="r-foot muted">{pt('cashier', locale)}: {cashier}<br />{shop.receipt_footer || pt('thanks', locale)}</div>
      </div>
      <div className="receipt-actions">
        <button className="btn primary big" onClick={onNew} autoFocus>{pt('newSale', locale)} ↵</button>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" style={{ flex: 1 }} onClick={() => doPrint(receiptHtml(order, lines, payments, shop, locale, loadPrintSettings(), { cashier, serverNumber }))}>🖨 {pt('print', locale)}</button>
          <button className="btn" style={{ flex: 1 }} onClick={() => setShowQr(true)}>▦ {pt('showQr', locale)}</button>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input className="input" inputMode="tel" placeholder={pt('customerPhone', locale)} value={phone} onChange={e => setPhone(e.target.value)} />
          <button className="btn" onClick={sendWa} disabled={!phone.trim() || waState === 'sending'}>{waState === 'sent' ? '✓ ' + pt('sent', locale) : '💬 ' + pt('sendWhatsApp', locale)}</button>
        </div>
        {waState === 'error' && <p className="bad">WhatsApp: error</p>}
        <p className="muted" style={{ fontSize: 12 }}>{usdToLbp(order.total_cents, rate) === order.total_lbp ? '' : ''}{pt('shortcutsLine', locale)}</p>
      </div>
      {showQr && <Modal open onClose={() => setShowQr(false)} title={pt('receipt', locale)}>
        <div style={{ textAlign: 'center' }}>{qr ? <img src={qr} alt="QR" width={280} height={280} /> : <p className="muted">…</p>}<p className="muted">{pt('qrHint', locale)}</p><p style={{ fontSize: 12, direction: 'ltr' }}>{url}</p></div>
      </Modal>}
    </div>
  );
}
