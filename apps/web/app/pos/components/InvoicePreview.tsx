'use client';
import { fmtLbp, fmtUsd, num, text, type Draft, type Shop } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import Modal from './Modal';
import { doPrint, loadPrintSettings, receiptHtml } from '../lib/print';
import { draftAsOrder, invoiceText, waHref } from '../lib/invoice';

/**
 * Bay3 → 🧾 preview: the whole invoice before payment, big enough to check line by line, with print and WhatsApp.
 * Everyone at the till may open it: it only shows the cart. Nothing is saved, no number is used, no money moves — the printout
 * and the message say "draft invoice — not paid" so they never pass for a receipt.
 */
export default function InvoicePreview({ draft, shop, locale, rate, lbpStep, feeCents, totals, cashier, onPay, onClose }: {
  draft: Draft; shop: Shop; locale: L; rate: number; lbpStep: number; feeCents: number;
  totals: { subtotal_cents: number; discount_cents: number; total_cents: number }; cashier: string; onPay: () => void; onClose: () => void;
}) {
  const { order, lines } = draftAsOrder(draft, rate, lbpStep, feeCents, totals);
  const ps = loadPrintSettings();
  const print = () => doPrint(receiptHtml(order, lines, [], shop, locale, ps, { cashier, draft: true, feeCents }));
  const wa = waHref(draft.customer_phone, invoiceText(order, lines, null, shop, locale, { draft: true, feeCents, lbpStep }));
  return (
    <Modal open onClose={onClose} title={<>🧾 {pt('draftInvoice', locale)}</>}
      footer={<>
        <button className="btn" onClick={print}>🖨 {pt('print', locale)}</button>
        <a className="btn" href={wa} target="_blank" rel="noreferrer">💬 WhatsApp</a>
        <span style={{ flex: 1 }} />
        <button className="btn ghost" onClick={onClose}>{pt('backToCart', locale)}</button>
        <button className="btn primary" onClick={onPay}>{pt('pay', locale)} {fmtUsd(num(order.total_cents))}</button>
      </>}>
      <div className="receipt invoice-preview" style={{ maxWidth: 'none', margin: 0 }}>
        <div className="r-head"><strong>{text(shop.name, locale)}</strong><div className="muted" dir="ltr">{shop.phone ?? ''}</div></div>
        <div className="r-unpaid">⚠ {pt('notPaidYet', locale)}</div>
        {(order.customer_name || order.customer_phone) && <div className="r-meta muted"><span>👤 {order.customer_name || ''}</span><span dir="ltr">{order.customer_phone || ''}</span></div>}
        <table className="r-lines"><tbody>
          {lines.map(l => (
            <tr key={l.id}><td>{text(l.name, locale)}{l.notes && <div className="r-note">📝 {l.notes}</div>}
              <div className="muted">{num(l.quantity)}{l.unit ? ` ${l.unit}` : ''} × {l.price_currency === 'usd' ? fmtUsd(num(l.unit_price_cents)) : fmtLbp(num(l.unit_price_lbp), locale)}{num(l.discount_cents) ? ` − ${fmtUsd(num(l.discount_cents))}` : ''}</div></td>
              <td className="num">{fmtUsd(num(l.line_total_cents))}</td></tr>
          ))}
        </tbody></table>
        <div className="r-totals">
          <div className="muted"><span>{lines.length} {pt('itemsCount', locale)}</span><span>{totals.discount_cents > 0 || feeCents > 0 ? fmtUsd(totals.subtotal_cents) : ''}</span></div>
          {totals.discount_cents > 0 && <div><span>{pt('discount', locale)}{draft.discount_reason ? ` · ${draft.discount_reason}` : ''}</span><span>−{fmtUsd(totals.discount_cents)}</span></div>}
          {feeCents > 0 && <div><span>{pt('deliveryFee', locale)}</span><span>{fmtUsd(feeCents)}</span></div>}
          <div className="big"><span>{pt('total', locale)}</span><span>{fmtUsd(num(order.total_cents))}</span></div>
          <div className="big"><span></span><span>{fmtLbp(num(order.total_lbp), locale)}</span></div>
          <div className="muted"><span>{pt('rate', locale)}</span><span>$1 = {rate.toLocaleString('en-US')} ل.ل.</span></div>
        </div>
      </div>
    </Modal>
  );
}
