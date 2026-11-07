'use client';
import { useEffect, useState } from 'react';
import { currentShift, fmtLbp, fmtUsd, num, shiftSummary, todaySummary, type Order, type Shift, type ShiftSummary } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import { fmtTime } from '../lib/boot';
import { doPrint, loadPrintSettings, receiptHtml } from '../lib/print';

type Today = Awaited<ReturnType<typeof todaySummary>>;

/** Today — from the local mirror, so it works offline. Period / item / category reports and exports come in M6. */
export default function ReportsView({ boot, locale, tick }: { boot: Booted; locale: L; tick: number }) {
  const [t, setT] = useState<Today | null>(null);
  const [shift, setShift] = useState<ShiftSummary | null>(null);
  const [recent, setRecent] = useState<Order[]>([]);
  useEffect(() => {
    (async () => {
      setT(await todaySummary(boot.db));
      const s: Shift | null = await currentShift(boot.db); setShift(s ? await shiftSummary(boot.db, s) : null);
      setRecent((await boot.db.orders.orderBy('placed_at').reverse().limit(30).toArray()).filter(o => o.channel !== 'online' && !o.parked));
    })();
  }, [boot, tick]);
  const reprint = async (o: Order) => {
    const [lines, pays] = await Promise.all([boot.db.orderLines.where('order_id').equals(o.id).toArray(), boot.db.payments.where('order_id').equals(o.id).toArray()]);
    doPrint(receiptHtml(o, lines, pays, boot.shop, locale, loadPrintSettings(), { again: true }));
  };
  if (!t) return null;
  const unpaid = t.payments.filter(p => p.tender === 'unpaid');
  return (
    <div className="stack" style={{ padding: 16, maxWidth: 900 }}>
      <section className="card">
        <h3 style={{ marginTop: 0 }}>{pt('today', locale)} · {new Date().toLocaleDateString(locale === 'ar' ? 'ar-LB-u-nu-latn' : 'en-GB')}</h3>
        <div className="kpis">
          <div className="kpi"><span>{pt('sales', locale)}</span><strong>{fmtUsd(t.total_cents)}</strong><small>{fmtLbp(t.total_lbp, locale)}</small></div>
          <div className="kpi"><span>{pt('salesCount', locale)}</span><strong>{t.sales_count}</strong><small>{t.items_count} {pt('items', locale)}</small></div>
          <div className="kpi"><span>{pt('avgSale', locale)}</span><strong>{fmtUsd(t.sales_count ? Math.round(t.total_cents / t.sales_count) : 0)}</strong></div>
          <div className="kpi"><span>{pt('expected', locale)}</span><strong>{shift ? fmtUsd(shift.expected_usd_cents) : '—'}</strong><small>{shift ? fmtLbp(shift.expected_lbp, locale) : pt('noShift', locale)}</small></div>
        </div>
        <div className="row" style={{ gap: 24, flexWrap: 'wrap', marginTop: 12 }}>
          <table className="table" style={{ flex: 1, minWidth: 260 }}><tbody>
            <tr><th colSpan={3} style={{ textAlign: 'start' }}>{pt('byChannel', locale)}</th></tr>
            {Object.entries(t.by_channel).map(([c, v]) => <tr key={c}><td>{pt(c as 'walkin', locale)}</td><td className="muted">{v.count}</td><td className="num">{fmtUsd(v.cents)}</td></tr>)}
          </tbody></table>
          <table className="table" style={{ flex: 1, minWidth: 260 }}><tbody>
            <tr><th colSpan={3} style={{ textAlign: 'start' }}>{pt('byTender', locale)}</th></tr>
            {Object.entries(t.by_tender).map(([k, v]) => <tr key={k}><td>{pt(k as 'cash_usd', locale)}</td><td className="muted">{v.count}</td><td className="num">{v.usd ? fmtUsd(v.usd) : ''} {v.lbp ? fmtLbp(v.lbp, locale) : ''}</td></tr>)}
          </tbody></table>
        </div>
      </section>
      {!!unpaid.length && (
        <section className="card">
          <h4 style={{ marginTop: 0 }}>{pt('unpaidList', locale)}</h4>
          <table className="table"><tbody>{unpaid.map(p => { const o = t.orders.find(x => x.id === p.order_id); return <tr key={p.id}><td>{p.unpaid_name} <span className="muted" dir="ltr">{p.unpaid_phone}</span></td><td className="muted">{o?.number ?? o?.local_number}</td><td className="num">{fmtUsd(num(p.amount))}</td></tr>; })}</tbody></table>
        </section>
      )}
      <section className="card">
        <h4 style={{ marginTop: 0 }}>{pt('lastSales', locale)}</h4>
        <table className="table"><tbody>
          {recent.map(o => <tr key={o.id}><td><strong>{o.number ?? o.local_number}</strong>{o.number && o.local_number ? <span className="muted"> ({o.local_number})</span> : ''}</td><td className="muted">{fmtTime(o.placed_at, locale)}</td><td className="muted">{pt(o.channel as 'walkin', locale)}</td><td className="num">{fmtUsd(num(o.total_cents))}</td><td><button className="btn icon" title={pt('reprint', locale)} onClick={() => reprint(o)}>🖨</button></td></tr>)}
        </tbody></table>
      </section>
      <p className="muted" style={{ fontSize: 12 }}>{pt('comingSoon', locale)}: {pt('reports', locale)} (M6)</p>
    </div>
  );
}
