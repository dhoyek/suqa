'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { currentShift, dayKey, fmtLbp, fmtUsd, localReport, num, shiftSummary, text, todaySummary, type CatalogIndex, type Order, type Report, type Shift, type ShiftSummary, type SyncStatus } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import ApprovalsReport from '../components/ApprovalsReport';
import type { Booted } from '../lib/boot';
import { can, roleOf } from '../lib/perm';
import type { Staff } from '@suqa/pos-core';
import { fmtTime } from '../lib/boot';
import { doPrint, loadPrintSettings, receiptHtml } from '../lib/print';
import { downloadCsv, downloadXlsx, flat, usd, type Row } from '../lib/export';

type Today = Awaited<ReturnType<typeof todaySummary>>;
type Preset = 'today' | 'yesterday' | 'week' | 'month' | 'lastMonth' | 'custom';
type Tab = 'overview' | 'items' | 'sections' | 'slow' | 'stock' | 'unpaid' | 'shifts' | 'approvals';

function presetRange(p: Preset): [string, string] {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  if (p === 'yesterday') { d.setDate(d.getDate() - 1); return [dayKey(d), dayKey(d)]; }
  if (p === 'week') { const s = new Date(d); s.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return [dayKey(s), dayKey(d)]; }       // Monday → today
  if (p === 'month') { return [dayKey(new Date(d.getFullYear(), d.getMonth(), 1)), dayKey(d)]; }
  if (p === 'lastMonth') { return [dayKey(new Date(d.getFullYear(), d.getMonth() - 1, 1)), dayKey(new Date(d.getFullYear(), d.getMonth(), 0))]; }
  return [dayKey(d), dayKey(d)];
}

/** Today (always local, works offline) + period reports (server for owners when online, mirror otherwise) + exports. */
export default function ReportsView({ boot, sb, locale, tick, status, staff, index }: { boot: Booted; sb: SupabaseClient; locale: L; tick: number; status: SyncStatus | null; staff: Staff; index: CatalogIndex }) {
  const owner = can(roleOf(staff), 'reports.profit');
  const online = status?.online ?? true;
  const [t, setT] = useState<Today | null>(null);
  const [shift, setShift] = useState<ShiftSummary | null>(null);
  const [recent, setRecent] = useState<Order[]>([]);
  const [preset, setPreset] = useState<Preset>('today');
  const [range, setRange] = useState<[string, string]>(() => presetRange('today'));
  const [tab, setTab] = useState<Tab>('overview');
  const [rep, setRep] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setT(await todaySummary(boot.db));
      const s: Shift | null = await currentShift(boot.db); setShift(s ? await shiftSummary(boot.db, s) : null);
      setRecent((await boot.db.orders.orderBy('placed_at').reverse().limit(30).toArray()).filter(o => o.channel !== 'online' && !o.parked));
    })();
  }, [boot, tick]);

  const load = useCallback(async () => {
    if (!owner) return;
    setBusy(true); setErr(null);
    try {
      if (online) {
        const { data, error } = await sb.rpc('pos_report', { p_shop: boot.shop.id, p_from: range[0], p_to: range[1] });
        if (!error) { setRep(data as Report); return; }
        setErr(error.message);
      }
      setRep(await localReport(boot.db, range[0], range[1]));
    } finally { setBusy(false); }
  }, [owner, online, sb, boot, range]);
  useEffect(() => { void load(); }, [load, tick]);

  const reprint = async (o: Order) => {
    const [lines, pays] = await Promise.all([boot.db.orderLines.where('order_id').equals(o.id).toArray(), boot.db.payments.where('order_id').equals(o.id).toArray()]);
    doPrint(receiptHtml(o, lines, pays, boot.shop, locale, loadPrintSettings(), { again: true }));
  };
  const pick = (p: Preset) => { setPreset(p); if (p !== 'custom') setRange(presetRange(p)); };
  const title = `${text(boot.shop.name, locale)} ${range[0]}${range[1] !== range[0] ? '_' + range[1] : ''}`;

  const sheets = useMemo(() => {
    if (!rep) return null;
    const s: Record<string, Row[]> = {};
    s[pt('overview', locale)] = [
      { [pt('period', locale)]: `${rep.from} → ${rep.to}`, [pt('sales', locale)]: usd(rep.totals.total_cents), [pt('salesCount', locale)]: rep.totals.sales_count, [pt('items', locale)]: rep.totals.items_count,
        [pt('discounts', locale)]: usd(rep.totals.discount_cents), [pt('returnsTotal', locale)]: usd(rep.totals.returns_cents), [pt('netSales', locale)]: usd(rep.totals.total_cents - rep.totals.returns_cents),
        [pt('courierFees', locale)]: usd(rep.totals.courier_fees_cents), [pt('deliveryFees', locale)]: usd(rep.totals.delivery_fees_cents), [pt('purchasesTotal', locale)]: usd(rep.totals.purchases_cents ?? 0), [pt('supplierPaid', locale)]: usd(rep.totals.supplier_paid_cents ?? 0), [pt('suppliersBalance', locale)]: usd(rep.totals.suppliers_balance_cents ?? 0), [pt('cost', locale)]: usd(rep.totals.cost_cents), [pt('grossMargin', locale)]: usd(rep.totals.total_cents - rep.totals.cost_cents), [pt('rate', locale)]: rep.rate },
    ];
    s[pt('byDay', locale)] = rep.by_day.map(d => ({ [pt('when', locale)]: d.day, [pt('salesCount', locale)]: d.count, [pt('sales', locale)]: usd(d.cents) }));
    s[pt('byChannel', locale)] = Object.entries(rep.by_channel).map(([c, v]) => ({ [pt('channelLabel', locale)]: pt(c as 'walkin', locale), [pt('salesCount', locale)]: v.count, [pt('sales', locale)]: usd(v.cents) }));
    s[pt('byTender', locale)] = Object.entries(rep.by_tender).map(([k, v]) => ({ [pt('tender', locale)]: pt(k as 'cash_usd', locale), [pt('salesCount', locale)]: v.count, USD: usd(v.usd), LBP: v.lbp }));
    s[pt('byItem', locale)] = rep.by_item.map(i => ({ [pt('items', locale)]: text(i.name, locale), [pt('qtySold', locale)]: i.qty, [pt('sales', locale)]: usd(i.cents), [pt('cost', locale)]: usd(i.cost_cents), [pt('grossMargin', locale)]: usd(i.cents - i.cost_cents) }));
    s[pt('bySection', locale)] = rep.by_section.map(i => ({ [pt('section', locale)]: i.section || '—', [pt('qtySold', locale)]: i.qty, [pt('sales', locale)]: usd(i.cents) }));
    s[pt('slowMovers', locale)] = rep.slow.map(i => ({ [pt('items', locale)]: text(i.name, locale), [pt('onHand', locale)]: i.on_hand, [pt('cost', locale)]: usd(num(i.cost_cents)) }));
    s[pt('unpaidList', locale)] = rep.unpaid.map(u => ({ [pt('when', locale)]: u.at, [pt('orderNo', locale)]: u.number ?? '', [pt('customerName', locale)]: u.name ?? '', [pt('customerPhone', locale)]: u.phone ?? '', [pt('amount', locale)]: u.currency === 'lbp' ? u.amount : usd(u.amount), [pt('currency', locale)]: u.currency }));
    s[pt('shiftsList', locale)] = rep.shifts.map(x => ({ [pt('openedAt', locale)]: x.opened_at, [pt('closedAt', locale)]: x.closed_at ?? '', ['USD ' + pt('expected', locale)]: usd(num(x.expected_usd_cents)), ['USD ' + pt('counted', locale)]: usd(num(x.counted_usd_cents)), ['USD ' + pt('diff', locale)]: usd(num(x.diff_usd_cents)), ['LBP ' + pt('expected', locale)]: num(x.expected_lbp), ['LBP ' + pt('counted', locale)]: num(x.counted_lbp), ['LBP ' + pt('diff', locale)]: num(x.diff_lbp) }));
    return s;
  }, [rep, locale]);

  const exportAll = async () => {
    setBusy(true);
    try {
      const { data, error } = await sb.rpc('pos_export', { p_shop: boot.shop.id, p_from: null, p_to: null });
      if (error) { setErr(error.message); return; }
      const d = data as Record<string, unknown>;
      const sheets: Record<string, Row[]> = {};
      for (const k of ['products', 'barcodes', 'orders', 'order_items', 'payments', 'stock_moves', 'shifts', 'cash_moves', 'returns', 'return_lines', 'staff', 'devices', 'audit_log']) sheets[k] = flat((d[k] as Record<string, unknown>[]) ?? []);
      await downloadXlsx(`${text(boot.shop.name, locale)} export ${dayKey(new Date())}`, sheets);
    } finally { setBusy(false); }
  };

  if (!t) return null;
  const unpaid = t.payments.filter(p => p.tender === 'unpaid');
  const N = (c: number) => fmtUsd(c);
  return (
    <div className="stack" style={{ padding: 16, maxWidth: 1000 }}>
      <section className="card">
        <h3 style={{ marginTop: 0 }}>{pt('today', locale)} · {new Date().toLocaleDateString(locale === 'ar' ? 'ar-LB-u-nu-latn' : 'en-GB')}</h3>
        <div className="kpis">
          <div className="kpi"><span>{pt('sales', locale)}</span><strong>{N(t.total_cents)}</strong><small>{fmtLbp(t.total_lbp, locale)}</small></div>
          <div className="kpi"><span>{pt('salesCount', locale)}</span><strong>{t.sales_count}</strong><small>{t.items_count} {pt('items', locale)}</small></div>
          <div className="kpi"><span>{pt('avgSale', locale)}</span><strong>{N(t.sales_count ? Math.round(t.total_cents / t.sales_count) : 0)}</strong></div>
          <div className="kpi"><span>{pt('expected', locale)}</span><strong>{shift ? N(shift.expected_usd_cents) : '—'}</strong><small>{shift ? fmtLbp(shift.expected_lbp, locale) : pt('noShift', locale)}</small></div>
        </div>
        {!!unpaid.length && <table className="table" style={{ marginTop: 10 }}><tbody>
          <tr><th colSpan={3} style={{ textAlign: 'start' }}>{pt('unpaidList', locale)}</th></tr>
          {unpaid.map(p => { const o = t.orders.find(x => x.id === p.order_id); return <tr key={p.id}><td>{p.unpaid_name} <span className="muted" dir="ltr">{p.unpaid_phone}</span></td><td className="muted">{o?.number ?? o?.local_number}</td><td className="num">{p.currency === 'lbp' ? fmtLbp(num(p.amount), locale) : N(num(p.amount))}</td></tr>; })}
        </tbody></table>}
      </section>

      {owner && (
        <section className="card">
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0 }}>{pt('reports', locale)}</h3>
            <div className="seg">{(['today', 'yesterday', 'week', 'month', 'lastMonth', 'custom'] as Preset[]).map(p => <button key={p} className={preset === p ? 'active' : ''} onClick={() => pick(p)}>{pt(`p${p[0].toUpperCase()}${p.slice(1)}` as 'pToday', locale)}</button>)}</div>
            {preset === 'custom' && <span className="row" style={{ gap: 6, alignItems: 'center' }}>
              <input className="input" type="date" dir="ltr" value={range[0]} max={range[1]} onChange={e => setRange([e.target.value, range[1]])} style={{ width: 150 }} />
              <input className="input" type="date" dir="ltr" value={range[1]} min={range[0]} onChange={e => setRange([range[0], e.target.value])} style={{ width: 150 }} />
            </span>}
            <span style={{ flex: 1 }} />
            {sheets && <>
              <button className="btn" disabled={busy} onClick={() => void downloadXlsx(title, sheets)}>📗 {pt('exportExcel', locale)}</button>
              <button className="btn ghost" disabled={busy} onClick={() => downloadCsv(title, sheets[pt(tab === 'overview' ? 'byDay' : tab === 'items' ? 'byItem' : tab === 'sections' ? 'bySection' : tab === 'slow' ? 'slowMovers' : tab === 'unpaid' ? 'unpaidList' : tab === 'shifts' ? 'shiftsList' : 'overview', locale)] ?? [])}>CSV</button>
            </>}
          </div>
          {rep?.partial && <p className="pill warn" style={{ marginTop: 8 }}>{pt('partialReport', locale)}</p>}
          {err && <p className="muted" style={{ fontSize: 12 }}>{err}</p>}
          {rep && <>
            <div className="kpis">
              <div className="kpi"><span>{pt('sales', locale)}</span><strong>{N(rep.totals.total_cents)}</strong><small>{rep.totals.sales_count} · {rep.totals.items_count} {pt('items', locale)}</small></div>
              <div className="kpi"><span>{pt('returnsTotal', locale)}</span><strong>{N(rep.totals.returns_cents)}</strong><small>{rep.totals.returns_count}</small></div>
              <div className="kpi"><span>{pt('netSales', locale)}</span><strong>{N(rep.totals.total_cents - rep.totals.returns_cents)}</strong><small>{pt('discounts', locale)} {N(rep.totals.discount_cents)}{rep.totals.courier_fees_cents ? ` · ${pt('courierFees', locale)} ${N(rep.totals.courier_fees_cents)}` : ''}</small></div>
              {rep.totals.purchases_cents != null && <div className="kpi"><span>{pt('purchasesTotal', locale)}</span><strong>{N(rep.totals.purchases_cents)}</strong><small>{pt('suppliersBalance', locale)} {N(rep.totals.suppliers_balance_cents ?? 0)}</small></div>}
              <div className="kpi"><span>{pt('grossMargin', locale)}</span><strong>{N(rep.totals.total_cents - rep.totals.cost_cents)}</strong><small>{pt('cost', locale)} {N(rep.totals.cost_cents)}{rep.totals.total_cents ? ` · ${Math.round(((rep.totals.total_cents - rep.totals.cost_cents) / rep.totals.total_cents) * 100)}%` : ''}</small></div>
            </div>
            <div className="seg" style={{ marginTop: 12, flexWrap: 'wrap' }}>
              {(['overview', 'items', 'sections', 'slow', 'stock', 'unpaid', 'shifts', ...(owner && online ? ['approvals'] : [])] as Tab[]).map(x => <button key={x} className={tab === x ? 'active' : ''} onClick={() => setTab(x)}>{pt(({ overview: 'byDay', items: 'byItem', sections: 'bySection', slow: 'slowMovers', stock: 'stockValue', unpaid: 'unpaidList', shifts: 'shiftsList', approvals: 'approvalsTab' } as const)[x], locale)}</button>)}
            </div>
            <div style={{ marginTop: 10, overflowX: 'auto' }}>
              {tab === 'overview' && <div className="row" style={{ gap: 24, flexWrap: 'wrap' }}>
                <table className="table" style={{ flex: 2, minWidth: 260 }}><tbody>
                  <tr><th style={{ textAlign: 'start' }}>{pt('byDay', locale)}</th><th>{pt('salesCount', locale)}</th><th>{pt('sales', locale)}</th></tr>
                  {rep.by_day.map(d => <tr key={d.day}><td dir="ltr">{d.day}</td><td className="muted" style={{ textAlign: 'center' }}>{d.count}</td><td className="num">{N(d.cents)}</td></tr>)}
                </tbody></table>
                <table className="table" style={{ flex: 1, minWidth: 220 }}><tbody>
                  <tr><th colSpan={3} style={{ textAlign: 'start' }}>{pt('byChannel', locale)}</th></tr>
                  {Object.entries(rep.by_channel).map(([c, v]) => <tr key={c}><td>{pt(c as 'walkin', locale)}</td><td className="muted">{v.count}</td><td className="num">{N(v.cents)}</td></tr>)}
                  <tr><th colSpan={3} style={{ textAlign: 'start' }}>{pt('byTender', locale)}</th></tr>
                  {Object.entries(rep.by_tender).map(([k, v]) => <tr key={k}><td>{pt(k as 'cash_usd', locale)}</td><td className="muted">{v.count}</td><td className="num">{v.usd ? N(v.usd) : ''} {v.lbp ? fmtLbp(v.lbp, locale) : ''}</td></tr>)}
                </tbody></table>
              </div>}
              {tab === 'items' && <table className="table"><tbody>
                <tr><th style={{ textAlign: 'start' }}>{pt('items', locale)}</th><th>{pt('qtySold', locale)}</th><th>{pt('sales', locale)}</th><th>{pt('grossMargin', locale)}</th></tr>
                {rep.by_item.map((i, n) => <tr key={i.product_id ?? n}><td>{text(i.name, locale)}</td><td style={{ textAlign: 'center' }}>{i.qty}</td><td className="num">{N(i.cents)}</td><td className="num muted">{i.cost_cents ? N(i.cents - i.cost_cents) : '—'}</td></tr>)}
              </tbody></table>}
              {tab === 'sections' && <table className="table"><tbody>
                <tr><th style={{ textAlign: 'start' }}>{pt('section', locale)}</th><th>{pt('qtySold', locale)}</th><th>{pt('sales', locale)}</th></tr>
                {rep.by_section.map(i => <tr key={i.section}><td>{i.section || '—'}</td><td style={{ textAlign: 'center' }}>{i.qty}</td><td className="num">{N(i.cents)}</td></tr>)}
              </tbody></table>}
              {tab === 'slow' && (rep.slow.length ? <table className="table"><tbody>
                <tr><th style={{ textAlign: 'start' }}>{pt('noSalesInPeriod', locale)}</th><th>{pt('onHand', locale)}</th><th>{pt('atCost', locale)}</th></tr>
                {rep.slow.map(i => <tr key={i.product_id}><td>{text(i.name, locale)}</td><td style={{ textAlign: 'center' }}>{i.on_hand}</td><td className="num muted">{N(num(i.cost_cents) * i.on_hand)}</td></tr>)}
              </tbody></table> : <p className="muted">—</p>)}
              {tab === 'stock' && <div className="kpis">
                <div className="kpi"><span>{pt('skus', locale)}</span><strong>{rep.stock.skus}</strong><small>{rep.stock.units} {pt('units', locale)}</small></div>
                <div className="kpi"><span>{pt('atCost', locale)}</span><strong>{N(rep.stock.cost_cents)}</strong></div>
                <div className="kpi"><span>{pt('atRetail', locale)}</span><strong>{N(rep.stock.retail_cents)}</strong></div>
                <div className="kpi"><span>{pt('lowStockCount', locale)}</span><strong>{rep.stock.low}</strong></div>
              </div>}
              {tab === 'unpaid' && <table className="table"><tbody>
                {rep.unpaid.map((u, n) => <tr key={n}><td className="muted">{fmtTime(u.at, locale)}</td><td>{u.number}</td><td>{u.name} <span className="muted" dir="ltr">{u.phone}</span></td><td className="num">{u.currency === 'lbp' ? fmtLbp(u.amount, locale) : N(u.amount)}</td></tr>)}
                {!rep.unpaid.length && <tr><td className="muted">—</td></tr>}
              </tbody></table>}
              {tab === 'approvals' && <ApprovalsReport boot={boot} sb={sb} locale={locale} index={index} from={range[0]} to={range[1]} />}
              {tab === 'shifts' && <table className="table"><tbody>
                <tr><th style={{ textAlign: 'start' }}>{pt('openedAt', locale)}</th><th>{pt('closedAt', locale)}</th><th>{pt('expected', locale)}</th><th>{pt('counted', locale)}</th><th>{pt('diff', locale)}</th></tr>
                {rep.shifts.map(x => <tr key={x.id}><td className="muted">{fmtTime(x.opened_at, locale)}</td><td className="muted">{x.closed_at ? fmtTime(x.closed_at, locale) : pt('open', locale)}</td>
                  <td className="num">{N(num(x.expected_usd_cents))}<br /><small>{fmtLbp(num(x.expected_lbp), locale)}</small></td><td className="num">{x.counted_usd_cents == null ? '—' : N(x.counted_usd_cents)}<br /><small>{x.counted_lbp == null ? '' : fmtLbp(x.counted_lbp, locale)}</small></td>
                  <td className={`num ${num(x.diff_usd_cents) || num(x.diff_lbp) ? 'bad' : ''}`}>{x.diff_usd_cents == null ? '—' : N(x.diff_usd_cents)}<br /><small>{x.diff_lbp == null ? '' : fmtLbp(x.diff_lbp, locale)}</small></td></tr>)}
              </tbody></table>}
            </div>
          </>}
          <div className="row" style={{ marginTop: 12, gap: 8, alignItems: 'center' }}>
            <button className="btn ghost" disabled={busy || !online} title={online ? '' : pt('needOnline', locale)} onClick={exportAll}>🗄 {busy ? pt('exporting', locale) : pt('exportAll', locale)}</button>
          </div>
        </section>
      )}

      <section className="card">
        <h4 style={{ marginTop: 0 }}>{pt('lastSales', locale)}</h4>
        <table className="table"><tbody>
          {recent.map(o => <tr key={o.id}><td><strong>{o.number ?? o.local_number}</strong>{o.number && o.local_number ? <span className="muted"> ({o.local_number})</span> : ''}</td><td className="muted">{fmtTime(o.placed_at, locale)}</td><td className="muted">{pt(o.channel as 'walkin', locale)}</td><td className="num">{N(num(o.total_cents))}</td><td><button className="btn icon" title={pt('reprint', locale)} onClick={() => reprint(o)}>🖨</button></td></tr>)}
        </tbody></table>
      </section>
    </div>
  );
}
