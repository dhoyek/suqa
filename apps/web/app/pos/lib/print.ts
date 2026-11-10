'use client';
import { fmtLbp, fmtUsd, num, text, usdToLbp, type DebtLine, type DebtSettlement, type Order, type OrderLine, type Payment, type Shift, type ShiftSummary, type Shop, type Supplier } from '@suqa/pos-core';
import { pt, type L } from '../i18n';

/**
 * Printing — ported from Hsarat POS (index.html → doPrint/vchHTML/cutBlock):
 * a hidden #printArea is filled with the receipt HTML, @page is set to the paper width (58/80 mm) and window.print() runs.
 * The thermal printer is simply the system printer (Windows driver, Android print service, AirPrint). No ESC/POS, no drivers in the app.
 * Per-device settings live in localStorage (paper width, feed lines, cut mark, auto-print, show LBP).
 */
export interface PrintSettings { paper: 58 | 80; feed: number; cutMark: boolean; autoPrint: boolean; showLbp: boolean }
const KEY = 'suqa-pos-print';
export const defaultPrint: PrintSettings = { paper: 58, feed: 3, cutMark: true, autoPrint: false, showLbp: true };
export function loadPrintSettings(): PrintSettings { try { return { ...defaultPrint, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return defaultPrint; } }
export function savePrintSettings(s: PrintSettings): void { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ } }

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const ltr = (s: string) => `<i>${s}</i>`;

function cutBlock(st: PrintSettings): string {
  const mark = st.cutMark ? '<div class="cut">✂ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─</div>' : '';
  return mark + '<div class="feed">&nbsp;</div>'.repeat(Math.max(0, st.feed));
}

export function doPrint(html: string, st: PrintSettings = loadPrintSettings()): void {
  let area = document.getElementById('printArea');
  if (!area) { area = document.createElement('div'); area.id = 'printArea'; document.body.appendChild(area); }
  let style = document.getElementById('pgStyle') as HTMLStyleElement | null;
  if (!style) { style = document.createElement('style'); style.id = 'pgStyle'; document.head.appendChild(style); }
  style.textContent = `@media print{@page{size:${st.paper}mm auto;margin:${st.paper === 80 ? '3mm' : '2mm'}}}`;
  area.className = st.paper === 80 ? 'w80' : '';
  area.innerHTML = html;
  setTimeout(() => window.print(), 60);
}

const fmtDT = (iso: string, L: L) => new Date(iso).toLocaleString(L === 'ar' ? 'ar-LB-u-nu-latn' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' });

/** Sale receipt. `again` marks a reprint. */
export function receiptHtml(o: Order, lines: OrderLine[], payments: Payment[], shop: Shop, L: L, st: PrintSettings, opts: { cashier?: string; again?: boolean; serverNumber?: string | null } = {}): string {
  const rate = num(o.rate_lbp_per_usd);
  const no = opts.serverNumber ?? o.number ?? o.local_number ?? '';
  const rows = lines.filter(l => !l.voided).map(l => {
    const unit = l.price_currency === 'usd' ? fmtUsd(num(l.unit_price_cents)) : fmtLbp(num(l.unit_price_lbp), L);
    return `<tr><td class="q">${num(l.quantity)}${l.unit ? esc(l.unit) : '×'}</td><td>${esc(text(l.name, L))}${l.discount_cents ? ` <small>−${fmtUsd(num(l.discount_cents))}</small>` : ''}${l.notes ? `<div class="u nt">» ${esc(l.notes)}</div>` : ''}<div class="u">${ltr(unit)}</div></td><td class="a">${ltr(fmtUsd(num(l.line_total_cents)))}</td></tr>`;
  }).join('');
  const pays = payments.map(p => `<div class="ft">${esc(pt(p.tender, L))}${p.unpaid_name ? ' · ' + esc(p.unpaid_name) : ''}: ${ltr(p.currency === 'lbp' ? fmtLbp(num(p.amount), L) : fmtUsd(num(p.amount)))}</div>`).join('');
  const change = num(o.change_usd_cents) || num(o.change_lbp) ? `<div class="ft">${esc(pt('change', L))}: ${ltr(num(o.change_usd_cents) ? fmtUsd(num(o.change_usd_cents)) : fmtLbp(num(o.change_lbp), L))}</div>` : '';
  return `<div class="vch">
    <div class="club">${esc(text(shop.name, L))}</div>${shop.phone ? `<div class="ev">${ltr(esc(shop.phone))}</div>` : ''}<hr>
    <div class="no">${esc(no)}</div><div class="ev">${esc(fmtDT(o.placed_at, L))}${opts.cashier ? ' · ' + esc(opts.cashier) : ''}</div>
    ${o.customer_name || o.customer_phone ? `<div class="ev">${esc(o.customer_name || '')} ${ltr(esc(o.customer_phone || ''))}</div>` : ''}<hr>
    <table>${rows}</table><hr>
    ${num(o.discount_cents) ? `<div class="ft">${esc(pt('discount', L))}: ${ltr('−' + fmtUsd(num(o.discount_cents)))}</div>` : ''}
    <div class="tot">${ltr(fmtUsd(num(o.total_cents)))}${st.showLbp ? '<span class="sep">·</span>' + ltr(fmtLbp(num(o.total_lbp) || usdToLbp(num(o.total_cents), rate), L)) : ''}</div>
    <div class="ev">${esc(pt('rate', L))} ${ltr(rate.toLocaleString('en-US'))} / $1</div><hr>
    ${pays}${change}
    ${opts.again ? `<div class="ft rp">${esc(pt('reprintMark', L))}</div>` : ''}
    <div class="ft">${esc(shop.receipt_footer || pt('thanks', L))}</div>${cutBlock(st)}</div>`;
}

/** Order sheet for the packer / kitchen: big items with notes, no prices. */
export function orderSheetHtml(o: Order, lines: OrderLine[], shop: Shop, L: L, st: PrintSettings): string {
  const rows = lines.filter(l => !l.voided).map(l => `<tr><td class="q">${num(l.quantity)}${l.unit ? esc(l.unit) : '×'}</td><td>${esc(text(l.name, L))}${l.notes ? `<div class="u nt">» ${esc(l.notes)}</div>` : ''}</td><td class="a">☐</td></tr>`).join('');
  const a = (o.address ?? {}) as Record<string, unknown>;
  const addr = [a.line1, a.line2, a.area, a.city].filter(Boolean).map(String).join(', ');
  return `<div class="vch">
    <div class="club">${esc(text(shop.name, L))}</div><div class="ev">${esc(pt('printSheet', L))}</div><hr>
    <div class="no">${esc(o.number ?? o.local_number ?? '')}</div><div class="ev">${esc(fmtDT(o.placed_at, L))}${o.needed_at ? ' · ⏰ ' + esc(fmtDT(o.needed_at, L)) : ''}</div>
    <div class="kiosk">${o.fulfillment === 'pickup' ? '🛍 ' + esc(pt('pickupBadge', L)) : '🛵 ' + esc(pt('deliveryBadge', L))}</div>
    <div class="ev">${esc(o.customer_name || '')} ${ltr(esc(o.customer_phone || ''))}</div>${addr ? `<div class="ev">📍 ${esc(addr)}</div>` : ''}<hr>
    <table>${rows}</table><hr>
    ${o.customer_notes ? `<div class="ft">📝 ${esc(o.customer_notes)}</div>` : ''}
    <div class="ft">${lines.filter(l => !l.voided).length} ${esc(pt('itemsCount', L))}</div>${cutBlock(st)}</div>`;
}

/** Z report for a shift (open or closed). */
export function zReportHtml(s: ShiftSummary, shop: Shop, L: L, st: PrintSettings, names: { opened?: string; closed?: string } = {}): string {
  const sh: Shift = s.shift;
  const line = (k: string, v: string) => `<div class="kv"><span>${esc(k)}</span>${ltr(v)}</div>`;
  const tenders = Object.entries(s.by_tender).map(([t, v]) => line(pt(t as 'cash_usd', L) + ` (${v.count})`, [v.usd ? fmtUsd(v.usd) : '', v.lbp ? fmtLbp(v.lbp, L) : ''].filter(Boolean).join(' + '))).join('');
  const channels = Object.entries(s.by_channel).map(([c, v]) => line(pt(c as 'walkin', L) + ` (${v.count})`, fmtUsd(v.cents))).join('');
  const moves = s.moves.map(m => line(`${m.kind === 'in' ? '+' : '−'} ${esc(m.reason ?? '')}`, m.currency === 'lbp' ? fmtLbp(num(m.amount), L) : fmtUsd(num(m.amount)))).join('');
  const diff = (d: number | null | undefined, f: (n: number) => string) => d == null ? '' : (d === 0 ? '0' : (d > 0 ? '+' : '−') + f(Math.abs(d)));
  return `<div class="vch">
    <div class="club">${esc(text(shop.name, L))}</div><div class="kiosk">${esc(pt('zReport', L))}</div>
    <div class="ev">${esc(fmtDT(sh.opened_at, L))} → ${sh.closed_at ? esc(fmtDT(sh.closed_at, L)) : '…'}</div>
    <div class="ev">${esc(pt('openedBy', L))}: ${esc(names.opened ?? '')}${names.closed ? ' · ' + esc(names.closed) : ''}</div><hr>
    ${line(pt('salesCount', L), String(s.sales_count))}${line(pt('total', L), fmtUsd(s.total_cents))}${line('', fmtLbp(s.total_lbp, L))}<hr>
    <div class="ft"><b>${esc(pt('byTender', L))}</b></div>${tenders}<hr>
    <div class="ft"><b>${esc(pt('byChannel', L))}</b></div>${channels}<hr>
    ${moves ? `<div class="ft"><b>${esc(pt('movements', L))}</b></div>${moves}<hr>` : ''}
    <div class="ft"><b>USD</b></div>${line(pt('float', L), fmtUsd(num(sh.float_usd_cents)))}${line(pt('cashSales', L), fmtUsd(s.cash_usd_sales))}${line(pt('changeGiven', L), '−' + fmtUsd(s.change_usd))}${line(pt('expected', L), fmtUsd(s.expected_usd_cents))}
    ${sh.closed_at ? line(pt('counted', L), fmtUsd(num(sh.counted_usd_cents))) + line(pt('difference', L), diff(sh.diff_usd_cents, fmtUsd)) : ''}<hr>
    <div class="ft"><b>LBP</b></div>${line(pt('float', L), fmtLbp(num(sh.float_lbp), L))}${line(pt('cashSales', L), fmtLbp(s.cash_lbp_sales, L))}${line(pt('changeGiven', L), '−' + fmtLbp(s.change_lbp, L))}${line(pt('expected', L), fmtLbp(s.expected_lbp, L))}
    ${sh.closed_at ? line(pt('counted', L), fmtLbp(num(sh.counted_lbp), L)) + line(pt('difference', L), diff(sh.diff_lbp, n => fmtLbp(n, L))) : ''}
    ${sh.note ? `<hr><div class="ft">${esc(sh.note)}</div>` : ''}${cutBlock(st)}</div>`;
}

export function testPrintHtml(shop: Shop, L: L, st: PrintSettings): string {
  return `<div class="vch"><div class="club">${esc(text(shop.name, L))}</div><div class="ev">${esc(pt('testPrint', L))} · ${st.paper}mm</div><hr>
    <table><tr><td class="q">2×</td><td>لبنة بلدية<div class="u"><i>$3.50</i></div></td><td class="a"><i>$7.00</i></td></tr><tr><td class="q">1×</td><td>Arabic bread<div class="u"><i>$1.00</i></div></td><td class="a"><i>$1.00</i></td></tr></table><hr>
    <div class="tot"><i>$8.00</i><span class="sep">·</span><i>716,000 ل.ل.</i></div><hr><div class="ft">0123456789 abc ABC</div>${cutBlock(st)}</div>`;
}

/** Debt statement for one person (or a filtered list): lines with date, number, original, paid, outstanding; total owed. */
export function debtStatementHtml(lines: DebtLine[], shop: Shop, L: L, st: PrintSettings, opts: { person?: { name: string; phone: string }; rate?: number; lbpStep?: number } = {}): string {
  const total = lines.reduce((s, l) => s + l.outstanding_cents, 0);
  const rows = lines.map(l => `<div class="kv"><span>${esc(fmtDT(l.at, L).split(',')[0])} · ${esc(l.number)}${opts.person ? '' : ' · ' + esc(l.name)}</span>${ltr(l.closed ? '✓' : fmtUsd(l.outstanding_cents))}</div>${l.paid_cents && !l.closed ? `<div class="ft">&nbsp;&nbsp;${esc(pt('original', L))} ${ltr(fmtUsd(l.original_cents))} · ${esc(pt('paidSoFar', L))} ${ltr(fmtUsd(l.paid_cents))}</div>` : ''}`).join('');
  return `<div class="vch">
    <div class="club">${esc(text(shop.name, L))}</div><div class="kiosk">${esc(pt('statement', L))}</div>
    ${opts.person ? `<div class="no">${esc(opts.person.name)}</div><div class="ev">${ltr(esc(opts.person.phone))}</div>` : ''}
    <div class="ev">${esc(fmtDT(new Date().toISOString(), L))}</div><hr>
    ${rows}<hr>
    <div class="kv tot"><span>${esc(pt('totalOutstanding', L))}</span>${ltr(fmtUsd(total))}</div>
    ${opts.rate && st.showLbp ? `<div class="kv"><span></span>${ltr(fmtLbp(Math.round(usdToLbp(total, opts.rate) / (opts.lbpStep ?? 5000)) * (opts.lbpStep ?? 5000), L))}</div>` : ''}
    ${shop.receipt_footer ? `<hr><div class="ft">${esc(shop.receipt_footer)}</div>` : ''}${cutBlock(st)}</div>`;
}

/** Receipt for a debt collection: amount, allocation, remaining balance. */
export function debtReceiptHtml(s: DebtSettlement, allocs: Array<{ number: string; amount_cents: number; closed: boolean }>, remaining_cents: number, shop: Shop, L: L, st: PrintSettings): string {
  return `<div class="vch">
    <div class="club">${esc(text(shop.name, L))}</div><div class="kiosk">${esc(pt('debtCollected', L))}</div>
    <div class="no">${esc(s.name ?? '')}</div><div class="ev">${ltr(esc(s.phone))} · ${esc(fmtDT(s.at, L))}</div><hr>
    <div class="kv tot"><span>${esc(pt(s.tender, L))}</span>${ltr(s.currency === 'lbp' ? fmtLbp(num(s.amount), L) : fmtUsd(num(s.amount)))}</div>
    ${s.currency === 'lbp' ? `<div class="kv"><span></span>${ltr('= ' + fmtUsd(s.amount_cents))}</div>` : ''}<hr>
    ${allocs.map(a => `<div class="kv"><span>${esc(a.number)}${a.closed ? ' ✓' : ''}</span>${ltr(fmtUsd(a.amount_cents))}</div>`).join('')}<hr>
    <div class="kv tot"><span>${esc(pt('outstanding', L))}</span>${ltr(fmtUsd(remaining_cents))}</div>
    ${shop.receipt_footer ? `<hr><div class="ft">${esc(shop.receipt_footer)}</div>` : ''}${cutBlock(st)}</div>`;
}

/** Supplier statement: purchases / returns / payments with running balance. */
export function supplierStatementHtml(s: Supplier, rows: Array<{ at: string; kind: string; ref: string; amount_cents: number; balance_cents: number }>, shop: Shop, L: L, st: PrintSettings): string {
  const lines = [...rows].reverse().map(r => `<div class="kv"><span>${esc(fmtDT(r.at, L).split(',')[0])} · ${esc(r.kind === 'payment' ? pt('paySupplier', L) : r.ref.replace('~', ''))}${r.kind === 'void' ? ' ✕' : ''}</span>${ltr((r.amount_cents < 0 ? '−' : '') + fmtUsd(Math.abs(r.amount_cents)))}</div>`).join('');
  return `<div class="vch">
    <div class="club">${esc(text(shop.name, L))}</div><div class="kiosk">${esc(pt('statementTitle', L))}</div>
    <div class="no">${esc(s.name)}</div><div class="ev">${ltr(esc(s.phone ?? ''))} · ${esc(fmtDT(new Date().toISOString(), L))}</div><hr>
    ${lines}<hr>
    <div class="kv tot"><span>${esc(pt('weOwe', L))}</span>${ltr(fmtUsd(num(s.balance_cents)))}</div>${cutBlock(st)}</div>`;
}
