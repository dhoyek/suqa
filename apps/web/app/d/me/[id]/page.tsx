import { notFound } from 'next/navigation';
import { supabaseAdmin } from '@/lib/server/supabase-admin';
import { getTenant } from '@/lib/tenant';
import { getLocale } from '@/lib/locale';
import { t as tr, type LocalizedText } from '@suqa/shared';

export const dynamic = 'force-dynamic';

type Open = { id: string; number: string | null; customer: string | null; at: string; total_cents: number | null; cash_usd_cents: number; cash_lbp: number; cash_cents: number; pay_cents: number };
type Bal = {
  driver: { id: string; name: string }; shop: { name: LocalizedText; phone: string | null; whatsapp: string | null; tenant_id: string } | null; rate: number;
  cash_usd_cents: number; cash_lbp: number; cash_cents: number; owed_cents: number; net_cents: number;
  on_road: { id: string; number: string | null; customer: string | null; due_cents: number; picked_at: string | null }[];
  open: Open[];
  settlements: { id: string; at: string; orders: number; cash_cents: number; cash_lbp: number; pay_cents: number }[];
  settled: { number: string | null; at: string; total_cents: number | null; cash_usd_cents: number; cash_lbp: number; pay_cents: number }[];
};
const digits = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');

/** /d/me/<driver id> — the driver's own account with the shop: what he is carrying now, the cash he collected and has not handed
 *  over, what the shop owes him, the net, and what was already settled. Public by unguessable id like his delivery sheets;
 *  it shows his deliveries only — no other figure of the shop (81_driver_confirm_cash). */
export default async function DriverAccount({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const admin = supabaseAdmin(); if (!admin || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const tenant = await getTenant(); const L = await getLocale(tenant); const ar = L === 'ar';
  const { data, error } = await admin.rpc('driver_balance', { p_driver: id });
  const b = data as Bal | null;
  if (error || !b || (b.shop?.tenant_id && tenant.id && b.shop.tenant_id !== tenant.id)) notFound();
  const usd = (c: number) => <span dir="ltr">${(Number(c) / 100).toFixed(2)}</span>;
  const lbp = (c: number) => <span dir="ltr" className="muted" style={{ fontSize: '.85em' }}>≈ {Math.round((Number(c) * Number(b.rate)) / 100 / 1000) * 1000 > 0 ? (Math.round((Number(c) * Number(b.rate)) / 100 / 1000) * 1000).toLocaleString('en-US') : 0} {ar ? 'ل.ل.' : 'LBP'}</span>;
  const when = (iso: string) => new Date(iso).toLocaleString(ar ? 'ar-LB-u-nu-latn' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Beirut' });
  // cash is shown in the notes he really holds: dollars and lira side by side
  const cash = (u: number, l: number) => { const a = Number(u), c = Number(l); if (!a && !c) return <span className="muted">—</span>; return <span dir="ltr">{[a ? `$${(a / 100).toFixed(2)}` : '', c ? `${c.toLocaleString('en-US')} ${ar ? 'ل.ل.' : 'LBP'}` : ''].filter(Boolean).join(' + ')}</span>; };
  const onRoadDue = b.on_road.reduce((s, o) => s + Number(o.due_cents), 0);
  const net = Number(b.net_cents); const shopPhone = b.shop?.whatsapp || b.shop?.phone || '';
  const Kpi = ({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: string }) =>
    <div className="card" style={{ flex: '1 1 140px', padding: 12, background: tone }}><div className="muted" style={{ fontSize: 13 }}>{label}</div><div style={{ fontSize: 22, fontWeight: 800 }}>{value}</div>{sub && <div>{sub}</div>}</div>;
  return (
    <main className="container narrow stack" style={{ paddingBottom: 24 }}>
      <h1 style={{ margin: '8px 0 0' }}>💰 {ar ? 'حسابي مع المحل' : 'My account with the shop'}</h1>
      <div className="muted">🛵 {b.driver.name} · 🏪 {tr(b.shop?.name ?? {}, L)}</div>

      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Kpi label={ar ? 'نقد معي للمحل' : 'Cash I hold for the shop'} value={cash(b.cash_usd_cents, b.cash_lbp)} sub={b.cash_lbp ? <span className="muted" style={{ fontSize: '.85em' }}>{ar ? 'القيمة' : 'worth'} {usd(b.cash_cents)}</span> : undefined} tone={b.cash_cents !== 0 ? '#fff8e6' : undefined} />
        <Kpi label={ar ? 'أجرتي غير المدفوعة' : 'My pay, not settled'} value={usd(b.owed_cents)} sub={lbp(b.owed_cents)} />
        <Kpi label={net >= 0 ? (ar ? 'الصافي: أسلّمه للمحل' : 'Net: I hand to the shop') : (ar ? 'الصافي: لي عند المحل' : 'Net: the shop owes me')} value={usd(Math.abs(net))} sub={lbp(Math.abs(net))} tone={net === 0 ? '#ecfdf5' : undefined} />
      </div>
      {net === 0 && !b.cash_usd_cents && !b.cash_lbp && b.owed_cents === 0 && <div className="card" style={{ background: '#ecfdf5', color: '#166534', fontWeight: 700 }}>✓ {ar ? 'لا شيء معلّق — الحساب مصفّى.' : 'Nothing open — all settled.'}</div>}

      {b.on_road.length > 0 && <section className="card stack" style={{ gap: 6 }}>
        <strong>🛵 {ar ? 'معي الآن' : 'With me now'} ({b.on_road.length}){onRoadDue > 0 ? <span className="muted" style={{ fontWeight: 400 }}> · {ar ? 'للتحصيل' : 'to collect'} {usd(onRoadDue)}</span> : null}</strong>
        <table className="table"><tbody>{b.on_road.map(o => <tr key={o.id}>
          <td><a href={`/d/${o.id}`}><strong dir="ltr">{o.number}</strong></a> <span className="muted">{o.customer}</span></td>
          <td className="muted" style={{ fontSize: 12 }}>{o.picked_at ? (ar ? 'في الطريق' : 'on the road') : (ar ? 'عند المحل' : 'at the shop')}</td>
          <td className="num">{Number(o.due_cents) > 0 ? usd(o.due_cents) : <span className="muted">{ar ? 'مدفوع' : 'paid'}</span>}</td>
        </tr>)}</tbody></table>
      </section>}

      <section className="card stack" style={{ gap: 6 }}>
        <strong>⏳ {ar ? 'غير مصفّى' : 'Not settled yet'} ({b.open.length})</strong>
        {b.open.length ? <table className="table"><tbody>
          <tr><th style={{ textAlign: 'start' }}>{ar ? 'الطلب' : 'Order'}</th><th>{ar ? 'نقد معي' : 'Cash I hold'}</th><th>{ar ? 'أجرتي' : 'My pay'}</th></tr>
          {b.open.map(o => <tr key={o.id}>
            <td><a href={`/d/${o.id}`}><strong dir="ltr">{o.number}</strong></a> <span className="muted">{o.customer}</span><div className="muted" style={{ fontSize: 12 }}>{when(o.at)}</div></td>
            <td className="num">{cash(o.cash_usd_cents, o.cash_lbp)}</td>
            <td className="num">{Number(o.pay_cents) > 0 ? usd(o.pay_cents) : <span className="muted">—</span>}</td>
          </tr>)}
          <tr><td><strong>{ar ? 'المجموع' : 'Total'}</strong></td><td className="num"><strong>{cash(b.cash_usd_cents, b.cash_lbp)}</strong></td><td className="num"><strong>{usd(b.owed_cents)}</strong></td></tr>
        </tbody></table> : <div className="muted">—</div>}
      </section>

      {b.settlements.length > 0 && <section className="card stack" style={{ gap: 6 }}>
        <strong>✓ {ar ? 'التصفيات السابقة' : 'Past settlements'}</strong>
        <table className="table"><tbody>
          <tr><th style={{ textAlign: 'start' }}>{ar ? 'التاريخ' : 'Date'}</th><th>{ar ? 'نقد سلّمته' : 'Cash handed in'}</th><th>{ar ? 'أجرتي' : 'My pay'}</th></tr>
          {b.settlements.map(s => <tr key={s.id}>
            <td className="muted" style={{ fontSize: 12 }}>{when(s.at)}</td><td className="num">{cash(s.cash_cents, s.cash_lbp)}</td><td className="num">{Number(s.pay_cents) > 0 ? usd(s.pay_cents) : <span className="muted">—</span>}</td>
          </tr>)}
        </tbody></table>
      </section>}

      {b.settled.length > 0 && <section className="card stack" style={{ gap: 6 }}>
        <strong>{ar ? 'توصيلات مصفّاة (آخر ٣٠ يوماً)' : 'Settled deliveries (last 30 days)'} ({b.settled.length})</strong>
        <table className="table"><tbody>{b.settled.map((o, i) => <tr key={i}>
          <td><strong dir="ltr">{o.number}</strong><div className="muted" style={{ fontSize: 12 }}>{when(o.at)}</div></td>
          <td className="num">{cash(o.cash_usd_cents, o.cash_lbp)}</td>
          <td className="num muted">{Number(o.pay_cents) > 0 ? usd(o.pay_cents) : '—'}</td>
        </tr>)}</tbody></table>
      </section>}

      {shopPhone && <div className="row" style={{ gap: 8 }}><a className="btn" style={{ flex: 1, justifyContent: 'center' }} href={`tel:+${digits(shopPhone)}`}>📞 {ar ? 'اتصال بالمحل' : 'Call shop'}</a><a className="btn" style={{ flex: 1, justifyContent: 'center' }} href={`https://wa.me/${digits(shopPhone)}`} target="_blank" rel="noreferrer">💬 WhatsApp</a></div>}
      <p className="muted" style={{ fontSize: 12 }}>{ar ? 'المبالغ بالدولار؛ المقابل بالليرة تقريبي بسعر المحل اليوم. التصفية يسجّلها المحل.' : 'Amounts in USD; the LBP figure is approximate at the shop\'s rate today. The shop records the settlement.'}</p>
    </main>
  );
}
