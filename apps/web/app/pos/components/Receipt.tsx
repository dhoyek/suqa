'use client';
import { useEffect, useState } from 'react';
import { fmtLbp, fmtUsd, lbpToCents, roundLbp, searchCustomers, text, usdToLbp, type CommitResult, type Shop, type ShopCustomer, type Staff } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import Modal from './Modal';
import ReturnDialog from './ReturnDialog';
import { doPrint, loadPrintSettings, receiptHtml } from '../lib/print';
import type { Booted } from '../lib/boot';

/**
 * Receipt after a sale: shop, date, numbers (local now, shop-wide once synced), lines, totals in USD + LBP, rate, payments, change.
 * Actions: new sale (Enter), print (P), WhatsApp (W), QR to /r/<id>, return. Reachable again from "آخر بيع" in the Sell header.
 */
export default function Receipt({ result, shop, locale, cashier, serverNumber, onNew, boot, staff, again }: { result: CommitResult; shop: Shop; locale: L; cashier: string; serverNumber?: string | null; onNew: () => void; boot?: Booted; staff?: Staff; again?: boolean }) {
  const { order, lines, payments, settlement: s } = result;
  const [qr, setQr] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [waState, setWaState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [phone, setPhone] = useState(order.customer_phone ?? '');
  const [pick, setPick] = useState(false); const [cq, setCq] = useState(''); const [found, setFound] = useState<ShopCustomer[]>([]);
  const [printed, setPrinted] = useState<boolean>(() => !again && loadPrintSettings().autoPrint);
  const [ret, setRet] = useState(false);
  const ps = loadPrintSettings();
  const url = `${location.origin}/r/${order.id}`;
  const print = () => { doPrint(receiptHtml(order, lines, payments, shop, locale, loadPrintSettings(), { cashier, serverNumber, again: printed || again })); setPrinted(true); };
  const sendWa = async () => {
    if (!phone.trim()) return;
    setWaState('sending');
    try {
      const r = await fetch('/api/pos/receipt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order_id: order.id, phone: phone.trim(), locale }) });
      setWaState(r.ok ? 'sent' : 'error');
    } catch { setWaState('error'); }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (showQr || pick || ret || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'Enter') onNew();
      else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); print(); }
      else if ((e.key === 'w' || e.key === 'W') && phone.trim()) { e.preventDefault(); void sendWa(); }
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (showQr && !qr) import('qrcode').then(m => m.toDataURL(url, { width: 280, margin: 1 })).then(setQr).catch(() => setQr(null)); }, [showQr, qr, url]);
  useEffect(() => { if (!pick || !boot) return; let on = true; searchCustomers(boot.db, cq, 10).then(r => { if (on) setFound(r); }); return () => { on = false; }; }, [pick, cq, boot]);

  const rate = order.rate_lbp_per_usd;
  const live = lines.filter(l => !l.voided);
  const unpaid = payments.filter(p => p.tender === 'unpaid').reduce((sum, p) => sum + (p.currency === 'lbp' ? lbpToCents(Number(p.amount), rate) : Number(p.amount)), 0);
  const changeUsd = s.change_usd_cents, changeLbp = s.change_lbp;
  return (
    <div className="receipt-wrap">
      <div className={`receipt ${ps.paper === 80 ? 'w80' : 'w58'}`} id="receipt">
        <div className="r-head"><strong>{text(shop.name, locale)}</strong><div className="muted" dir="ltr">{shop.phone ?? ''}</div></div>
        <div className="r-meta">
          <span>{pt('orderNo', locale)} {serverNumber ?? order.number ?? order.local_number}{serverNumber || order.number ? ` (${order.local_number})` : ''}</span>
          <span>{new Date(order.placed_at).toLocaleString(locale === 'ar' ? 'ar-LB-u-nu-latn' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' })}</span>
        </div>
        {(order.customer_name || order.customer_phone) && <div className="r-meta muted"><span>👤 {order.customer_name || ''}</span><span dir="ltr">{order.customer_phone || ''}</span></div>}
        {unpaid > 0 && <div className="r-unpaid">{pt('unpaidBand', locale)} · {fmtUsd(unpaid)}{order.customer_name ? ` · ${order.customer_name}` : ''}</div>}
        <table className="r-lines"><tbody>
          {live.map(l => (
            <tr key={l.id}><td>{text(l.name, locale)}{l.notes && <div className="r-note">📝 {l.notes}</div>}<div className="muted">{l.quantity}{l.unit ? ` ${l.unit}` : ''} × {l.price_currency === 'usd' ? fmtUsd(l.unit_price_cents) : fmtLbp(l.unit_price_lbp, locale)}{l.discount_cents ? ` − ${fmtUsd(l.discount_cents)}` : ''}</div></td><td className="num">{fmtUsd(l.line_total_cents)}</td></tr>
          ))}
        </tbody></table>
        <div className="r-totals">
          <div className="muted"><span>{live.length} {pt('itemsCount', locale)}</span><span>{order.discount_cents > 0 ? fmtUsd(order.subtotal_cents) : ''}</span></div>
          {order.discount_cents > 0 && <div><span>{pt('discount', locale)}{order.discount_reason ? ` · ${order.discount_reason}` : ''}</span><span>−{fmtUsd(order.discount_cents)}</span></div>}
          <div className="big"><span>{pt('total', locale)}</span><span>{fmtUsd(order.total_cents)}</span></div>
          <div className="big"><span></span><span>{fmtLbp(roundLbp(order.total_lbp, shop.lbp_rounding_step ?? 5000), locale)}</span></div>
          <div className="muted"><span>{pt('rate', locale)}</span><span>$1 = {rate.toLocaleString('en-US')} ل.ل.</span></div>
          {payments.map(p => <div key={p.id}><span>{pt(p.tender, locale)}{p.unpaid_name ? ` · ${p.unpaid_name}` : ''}</span><span>{p.currency === 'lbp' ? fmtLbp(p.amount, locale) : fmtUsd(p.amount)}</span></div>)}
          {(changeUsd > 0 || changeLbp > 0) && <div className="r-change"><span>{pt('change', locale)}</span><span>{changeUsd ? <>{fmtUsd(changeUsd)} <small className="muted">≈ {fmtLbp(usdToLbp(changeUsd, rate), locale)}</small></> : <>{fmtLbp(changeLbp, locale)} <small className="muted">≈ {fmtUsd(lbpToCents(changeLbp, rate))}</small></>}</span></div>}
        </div>
        <div className="r-foot muted">{pt('cashier', locale)}: {cashier}<br />{shop.receipt_footer || pt('thanks', locale)}</div>
      </div>
      <div className="receipt-actions">
        <button className="btn primary big" onClick={onNew} autoFocus>{pt('newSale', locale)} ↵</button>
        <div className="row" style={{ gap: 8 }}>
          <button className={`btn ${printed ? '' : 'primary'}`} style={{ flex: 1 }} onClick={print}>{printed ? `✓ ${pt('printed', locale)} · ${pt('reprint', locale)}` : `🖨 ${pt('print', locale)}`} <kbd>P</kbd></button>
          <button className="btn" style={{ flex: 1 }} onClick={() => setShowQr(true)}>▦ {pt('showQr', locale)}</button>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input className="input" inputMode="tel" placeholder={pt('customerPhone', locale)} value={phone} onChange={e => { setPhone(e.target.value); setWaState('idle'); }} />
          {boot && <button className="btn" title={pt('pickCustomer', locale)} onClick={() => { setPick(true); setCq(''); }}>📇</button>}
          <button className="btn" onClick={sendWa} disabled={!phone.trim() || waState === 'sending'}>{waState === 'sent' ? '✓ ' + pt('sent', locale) : '💬 ' + pt('sendWhatsApp', locale)} <kbd>W</kbd></button>
        </div>
        {waState === 'error' && <p className="bad">WhatsApp: {pt('sendFailed', locale)}</p>}
        {boot && staff && <button className="btn ghost" onClick={() => setRet(true)}>↩ {pt('returnItems', locale)}</button>}
        <p className="muted" style={{ fontSize: 12 }}>↵ {pt('newSale', locale)} · P {pt('print', locale)} · W {pt('sendWhatsApp', locale)}</p>
      </div>
      {showQr && <Modal open onClose={() => setShowQr(false)} title={pt('receipt', locale)}>
        <div style={{ textAlign: 'center' }}>{qr ? <img src={qr} alt="QR" width={280} height={280} /> : <p className="muted">…</p>}<p className="muted">{pt('qrHint', locale)}</p><p style={{ fontSize: 12, direction: 'ltr' }}>{url}</p></div>
      </Modal>}
      {pick && <Modal open onClose={() => setPick(false)} title={`📇 ${pt('pickCustomer', locale)}`}>
        <input className="input" autoFocus placeholder={pt('searchCustomer', locale)} value={cq} onChange={e => setCq(e.target.value)} />
        <ul className="tender-list" style={{ marginTop: 8 }}>{found.map(c => <li key={c.id}><span>{c.name} <span className="muted" dir="ltr">{c.phone}</span></span><button className="btn" onClick={() => { setPhone(c.phone); setPick(false); setWaState('idle'); }}>✓</button></li>)}</ul>
        {!found.length && <p className="muted">{pt('noResults', locale)}</p>}
      </Modal>}
      {ret && boot && staff && <ReturnDialog boot={boot} locale={locale} order={order} lines={lines} staff={staff} onDone={() => { setRet(false); onNew(); }} onClose={() => setRet(false)} />}
    </div>
  );
}
