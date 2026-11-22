'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabaseBrowser } from '@/lib/supabase-browser';

type Phrase = { key: string; phrase: string; times: number; people: number; found: number; not_found: number; yorgo_app: number; yorgo_whatsapp: number; search: number; last_at: string };
type Report = { days: number; total: number; not_found: number; people: number; phrases: Phrase[] };
type Person = { name: string | null; phone: string | null; source: 'yorgo_app' | 'yorgo_whatsapp' | 'search'; shop_id: string | null; times: number; found: boolean; last_at: string; as_written: string };
type Show = 'all' | 'missing' | 'yorgo' | 'search';

export default function Demand({ tenantId, locale, timeZone, shops }: { tenantId: string; locale: 'ar' | 'en'; timeZone: string; shops: { id: string; name: string }[] }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const T = (a: string, e: string) => (locale === 'ar' ? a : e);
  const [days, setDays] = useState(30);
  const [show, setShow] = useState<Show>('all');
  const [rep, setRep] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [people, setPeople] = useState<Person[] | null>(null);

  useEffect(() => {
    let live = true; setRep(null); setErr(null); setOpen(null);
    sb.rpc('demand_report', { p_tenant: tenantId, p_days: days }).then(({ data, error }) => {
      if (!live) return;
      if (error) setErr(error.message); else setRep(data as Report);
    });
    return () => { live = false; };
  }, [sb, tenantId, days]);

  useEffect(() => {
    if (!open) { setPeople(null); return; }
    let live = true; setPeople(null);
    sb.rpc('demand_people', { p_tenant: tenantId, p_key: open, p_days: days }).then(({ data, error }) => { if (live) setPeople(error ? [] : (data as Person[])); });
    return () => { live = false; };
  }, [sb, tenantId, days, open]);

  const when = (iso: string) => new Intl.DateTimeFormat(locale === 'ar' ? 'ar-LB' : 'en-GB', { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const shopName = (id: string | null) => (id ? shops.find(s => s.id === id)?.name ?? '—' : T('الصفحة الرئيسية', 'home page'));
  const sourceName = (p: Person) => p.source === 'yorgo_whatsapp' ? T('يورغو · واتساب', 'Yorgo · WhatsApp') : p.source === 'yorgo_app' ? T('يورغو · التطبيق', 'Yorgo · app') : `${T('بحث', 'Search')} · ${shopName(p.shop_id)}`;
  const list = (rep?.phrases ?? []).filter(p => show === 'all' ? true : show === 'missing' ? p.not_found > 0 : show === 'yorgo' ? p.yorgo_app + p.yorgo_whatsapp > 0 : p.search > 0)
    .sort((a, b) => show === 'missing' ? b.not_found - a.not_found || b.times - a.times : 0);
  const chip = (v: Show, label: string) => <button type="button" className={`chip ${show === v ? 'active' : ''}`} onClick={() => setShow(v)}>{label}</button>;

  return (
    <div className="stack">
      <div className="row spread" style={{ alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>📊 {T('الطلب', 'Demand')} <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>· {T('ماذا يطلب الناس', 'what people ask for')}</span></h2>
        <Link href="/admin/yorgo" className="btn ghost">← Yorgo</Link>
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {[7, 30, 90].map(d => <button key={d} type="button" className={`chip ${days === d ? 'active' : ''}`} onClick={() => setDays(d)}>{d} {T('يوماً', 'days')}</button>)}
      </div>
      {err && <div className="card paused">{/does not exist|schema cache/i.test(err) ? T('تقرير الطلب غير مثبّت في قاعدة البيانات بعد (السكربت 99).', 'The demand report is not installed in the database yet (script 99).') : T('تعذّر تحميل التقرير.', 'The report could not be loaded.')}</div>}
      {!rep && !err && <div className="card"><span className="muted">…</span></div>}
      {rep && <>
        <div className="grid">
          <div className="card stack"><span className="muted">{T('طلبات', 'Requests')}</span><strong style={{ fontSize: 26 }}>{rep.total}</strong></div>
          <div className="card stack"><span className="muted">{T('لم يُعثر عليها', 'Not found')}</span><strong style={{ fontSize: 26 }}>{rep.not_found}</strong></div>
          <div className="card stack"><span className="muted">{T('أشخاص', 'People')}</span><strong style={{ fontSize: 26 }}>{rep.people}</strong></div>
        </div>
        <nav className="row chips" style={{ flexWrap: 'wrap' }}>
          {chip('all', T('الأكثر طلباً', 'Most asked'))}{chip('missing', T('طُلب ولم يُعثر عليه', 'Asked, not found'))}{chip('yorgo', 'Yorgo')}{chip('search', T('مربّع البحث', 'Search box'))}
        </nav>
        <div className="card stack">
          {!list.length && <span className="muted">{T('لا شيء في هذه الفترة.', 'Nothing in this period.')}</span>}
          {list.map(p => (
            <div key={p.key} style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
              <button type="button" className="row spread" onClick={() => setOpen(o => (o === p.key ? null : p.key))} aria-expanded={open === p.key}
                style={{ width: '100%', background: 'none', border: 0, padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', textAlign: 'start', gap: 8 }}>
                <span style={{ minWidth: 0 }}><strong dir="auto">{p.phrase}</strong> <span className="muted">×{p.times} · {p.people} {T('شخص', p.people === 1 ? 'person' : 'people')}</span></span>
                <span className="muted" style={{ fontSize: 13, flex: 'none' }}>{p.not_found > 0 && <span style={{ color: 'var(--bad)' }}>{T('لم يُعثر', 'not found')} ×{p.not_found} </span>}{open === p.key ? '▴' : '▾'}</span>
              </button>
              <div className="muted" style={{ fontSize: 13 }}>
                {[p.yorgo_app ? `${T('يورغو · التطبيق', 'Yorgo app')} ${p.yorgo_app}` : '', p.yorgo_whatsapp ? `${T('واتساب', 'WhatsApp')} ${p.yorgo_whatsapp}` : '', p.search ? `${T('بحث', 'search')} ${p.search}` : ''].filter(Boolean).join(' · ')} · {when(p.last_at)}
              </div>
              {open === p.key && <div className="stack" style={{ marginTop: 8, gap: 6 }}>
                {!people && <span className="muted">…</span>}
                {people?.map((x, i) => (
                  <div key={i} className="row spread" style={{ gap: 8, fontSize: 14 }}>
                    <span style={{ minWidth: 0 }}>
                      {x.name || x.phone ? <><strong>{x.name ?? x.phone}</strong>{x.name && x.phone ? <> · <a href={`tel:${x.phone}`} dir="ltr">{x.phone}</a></> : null}</> : <span className="muted">{T('زائر بلا حساب', 'Visitor, not signed in')}</span>}
                      <span className="muted"> · {sourceName(x)}{x.as_written !== p.phrase ? <> · <span dir="auto">“{x.as_written}”</span></> : null}</span>
                    </span>
                    <span className="muted" style={{ flex: 'none', fontSize: 13 }}>×{x.times}{x.found ? '' : ` · ${T('لم يُعثر', 'not found')}`} · {when(x.last_at)}</span>
                  </div>))}
              </div>}
            </div>))}
        </div>
      </>}
      <p className="muted" style={{ fontSize: 12, margin: 0 }}>{T('كلمات الأصناف ومن طلبها فقط — لا نصّ الرسائل. يورغو منذ أول يوم؛ مربّع البحث منذ تثبيت هذا التقرير. «لم يُعثر» = لا صنف قريب كفاية في أي محل.', 'Item words and who asked only — not the text of messages. Yorgo since its first day; the search boxes since this report was installed. "Not found" = no close enough item in any shop.')}</p>
    </div>
  );
}
