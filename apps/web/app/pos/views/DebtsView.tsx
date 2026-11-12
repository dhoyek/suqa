'use client';
import { useEffect, useMemo, useState } from 'react';
import { allocate, currentShift, debtLines, fmtLbp, fmtUsd, groupByPerson, lbpToCents, normPhone, num, roundLbp, settleDebt, usdToLbp, type Currency, type DebtLine, type DebtPerson, type DebtSettlement, type Rate, type Staff, type Tender } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import { fmtTime } from '../lib/boot';
import { debtReceiptHtml, debtStatementHtml, doPrint, loadPrintSettings } from '../lib/print';
import Modal, { NumPad } from '../components/Modal';
import OrderDetail from '../components/OrderDetail';
import { useOrderItems } from '../lib/useOrderItems';
import { PickChips, PickFilter, type PickItem } from '../components/CategoryFilter';

type Mode = 'date' | 'person';
const TENDERS: Array<Exclude<Tender, 'unpaid'>> = ['cash_usd', 'cash_lbp', 'card', 'wallet'];

/** الدين — who owes what. List by date or grouped by person; filter by period and person(s); print a statement; collect (oldest-first). */
export default function DebtsView({ boot, locale, tick, staff, onCustomer }: { boot: Booted; locale: L; tick: number; staff: Staff; onCustomer?: (phone: string, name: string) => void }) {
  const [detail, setDetail] = useState<DebtLine | null>(null);
  const [all, setAll] = useState<DebtLine[]>([]);
  const [history, setHistory] = useState<DebtSettlement[]>([]);
  const [mode, setMode] = useState<Mode>('person');
  const [openOnly, setOpenOnly] = useState(true);
  const [showItems, setShowItems] = useState<boolean>(() => { try { return localStorage.getItem('suqa-pos-debt-items') !== '0'; } catch { return true; } });
  const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [q, setQ] = useState(''); const [sel, setSel] = useState<Set<string>>(new Set());
  const [rate, setRate] = useState(89500);
  const [collect, setCollect] = useState<DebtPerson | null>(null);
  const [done, setDone] = useState<{ s: DebtSettlement; allocs: Array<{ number: string; amount_cents: number; closed: boolean }>; remaining: number } | null>(null);
  const step = boot.shop.lbp_rounding_step ?? 5000;

  useEffect(() => {
    (async () => { const ls = await debtLines(boot.db); const cs = await boot.db.shopCustomers.toArray(); const byKey = new Map(cs.map(c => [c.phone_key, c.name])); setAll(ls.map(l => ({ ...l, name: l.name || byKey.get(l.phone) || '' }))); })();
    boot.db.debtSettlements.orderBy('at').reverse().limit(50).toArray().then(setHistory);
    boot.db.rates.orderBy('effective_at').reverse().first().then((r: Rate | undefined) => { if (r) setRate(r.lbp_per_usd); });
  }, [boot, tick, done]);

  const people = useMemo(() => groupByPerson(all), [all]);
  const lines = useMemo(() => {
    let xs = all;
    if (openOnly) xs = xs.filter(l => !l.closed);
    if (from) xs = xs.filter(l => l.at >= new Date(from + 'T00:00:00').toISOString());
    if (to) { const d = new Date(to + 'T00:00:00'); d.setDate(d.getDate() + 1); xs = xs.filter(l => l.at < d.toISOString()); }
    if (sel.size) xs = xs.filter(l => sel.has(l.phone || `~${l.name}`));
    else if (q.trim()) { const n = q.trim().toLowerCase(); const qp = normPhone(q); xs = xs.filter(l => l.name.toLowerCase().includes(n) || (qp && l.phone.includes(qp))); }
    return xs;
  }, [all, openOnly, from, to, sel, q]);
  const grouped = useMemo(() => groupByPerson(lines), [lines]);
  const total = lines.reduce((s, l) => s + l.outstanding_cents, 0);
  const keyOf = (p: DebtPerson) => p.phone || `~${p.name}`;
  const peopleItems: PickItem[] = useMemo(() => people.filter(p => !openOnly || p.outstanding_cents > 0).map(p => ({ id: keyOf(p), label: `${p.name || p.phone} · ${fmtUsd(p.outstanding_cents)}`, extra: p.phone || undefined })), [people, openOnly]);
  const Who = ({ name, phone }: { name: string; phone: string }) => onCustomer && phone
    ? <button className="btn ghost" style={{ minHeight: 0, padding: '0 6px', font: 'inherit', fontWeight: 700 }} title={pt('customersNav', locale)} onClick={() => onCustomer(phone, name)}>{name || '—'}</button>
    : <strong>{name || '—'}</strong>;
  const items = useOrderItems(boot.db, lines.map(l => l.order.id), locale, showItems);
  // order number = link to the full order; the items sit under it when "📋 الأصناف" is on
  const No = ({ l }: { l: DebtLine }) => <><button className="link-btn" title={pt('orderDetails', locale)} onClick={() => setDetail(l)}>{l.number} ↗</button>{l.note && <div className="order-items-line" style={{ color: '#92400e' }}>📝 {l.note}</div>}{showItems && items.get(l.order.id) && <div className="order-items-line">{items.get(l.order.id)}</div>}</>;
  const printList = (person?: DebtPerson) => {
    const st = loadPrintSettings();
    doPrint(debtStatementHtml(person ? person.lines.filter(l => openOnly ? !l.closed : true) : lines, boot.shop, locale, st, { person: person ? { name: person.name, phone: person.phone } : undefined, rate, lbpStep: step }), st);
  };

  return (
    <div className="stack" style={{ padding: 16, maxWidth: 1200, margin: '0 auto', width: '100%' }}>
      <section className="card">
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>{pt('debtBook', locale)}</h3>
          <div className="seg"><button className={mode === 'person' ? 'active' : ''} onClick={() => setMode('person')}>{pt('byPerson', locale)}</button><button className={mode === 'date' ? 'active' : ''} onClick={() => setMode('date')}>{pt('byDate', locale)}</button></div>
          <label className="row" style={{ gap: 6, alignItems: 'center' }}><input type="checkbox" checked={openOnly} onChange={e => setOpenOnly(e.target.checked)} /> {pt('openOnly', locale)}</label>
          <button className={`chip ${showItems ? 'active' : ''}`} onClick={() => setShowItems(v => { try { localStorage.setItem('suqa-pos-debt-items', v ? '0' : '1'); } catch { /* ignore */ } return !v; })}>📋 {pt('showItems', locale)}</button>
          <input className="input" type="date" dir="ltr" value={from} onChange={e => setFrom(e.target.value)} style={{ width: 150 }} title={pt('from', locale)} />
          <input className="input" type="date" dir="ltr" value={to} onChange={e => setTo(e.target.value)} style={{ width: 150 }} title={pt('to', locale)} />
          <input className="input" placeholder={pt('searchPerson', locale)} value={q} onChange={e => { setQ(e.target.value); setSel(new Set()); }} style={{ flex: 1, minWidth: 160 }} />
          <PickFilter items={peopleItems} selected={sel} onChange={setSel} locale={locale} icon="👥" title={pt('person', locale)} />
          <button className="btn" onClick={() => printList()} disabled={!lines.length}>🖨 {pt('printStatement', locale)}</button>
        </div>
        <div style={{ marginTop: sel.size ? 10 : 0 }}><PickChips items={peopleItems} selected={sel} onChange={setSel} locale={locale} /></div>
        <div className="kpis" style={{ marginTop: 10 }}>
          <div className="kpi"><span>{pt('totalOutstanding', locale)}</span><strong>{fmtUsd(total)}</strong><small>{fmtLbp(roundLbp(usdToLbp(total, rate), step), locale)}</small></div>
          <div className="kpi"><span>{pt('person', locale)}</span><strong>{grouped.filter(p => p.outstanding_cents > 0).length}</strong><small>{lines.length} {pt('ordersNav', locale)}</small></div>
        </div>
      </section>

      {!lines.length && <p className="muted" style={{ paddingInlineStart: 8 }}>{pt('noDebts', locale)}</p>}

      {mode === 'person' && grouped.map(p => (
        <section className="card" key={keyOf(p)}>
          <div className="row spread" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div style={{ fontSize: 17 }}><Who name={p.name} phone={p.phone} /> <span className="muted" dir="ltr" style={{ fontSize: 13 }}>{p.phone}</span></div>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <strong className={p.outstanding_cents ? 'bad' : 'ok'} style={{ fontSize: 18 }}>{fmtUsd(p.outstanding_cents)}</strong>
              <button className="btn icon" title={pt('printStatement', locale)} onClick={() => printList(p)}>🖨</button>
              {p.outstanding_cents > 0 && <button className="btn primary" onClick={() => setCollect(p)}>💵 {pt('collect', locale)}</button>}
            </div>
          </div>
          <table className="table" style={{ marginTop: 6 }}><tbody>
            {p.lines.map(l => <tr key={l.order.id} className={l.closed ? 'muted' : ''}><td className="muted">{fmtTime(l.at, locale)}</td><td><No l={l} /></td><td className="num muted">{fmtUsd(l.original_cents)}</td><td className="num muted">{l.paid_cents ? '− ' + fmtUsd(l.paid_cents) : ''}</td><td className="num"><strong>{l.closed ? '✓' : fmtUsd(l.outstanding_cents)}</strong></td></tr>)}
          </tbody></table>
        </section>
      ))}

      {mode === 'date' && !!lines.length && (
        <section className="card">
          <table className="table"><tbody>
            <tr><th style={{ textAlign: 'start' }}>{pt('when', locale)}</th><th style={{ textAlign: 'start' }}>{pt('orderNo', locale)}</th><th style={{ textAlign: 'start' }}>{pt('person', locale)}</th><th>{pt('original', locale)}</th><th>{pt('paidSoFar', locale)}</th><th>{pt('outstanding', locale)}</th></tr>
            {[...lines].sort((a, b) => b.at.localeCompare(a.at)).map(l => <tr key={l.order.id} className={l.closed ? 'muted' : ''}><td className="muted">{fmtTime(l.at, locale)}</td><td><No l={l} /></td><td><Who name={l.name} phone={l.phone} /> <span className="muted" dir="ltr">{l.phone}</span></td><td className="num muted">{fmtUsd(l.original_cents)}</td><td className="num muted">{l.paid_cents ? fmtUsd(l.paid_cents) : ''}</td><td className="num"><strong>{l.closed ? '✓' : fmtUsd(l.outstanding_cents)}</strong></td></tr>)}
          </tbody></table>
        </section>
      )}

      {!!history.length && (
        <section className="card">
          <h4 style={{ marginTop: 0 }}>{pt('settlementsHistory', locale)}</h4>
          <table className="table"><tbody>
            {history.map(s => <tr key={s.id}><td className="muted">{fmtTime(s.at, locale)}</td><td>{s.name} <span className="muted" dir="ltr">{s.phone}</span></td><td className="muted">{pt(s.tender, locale)}</td><td className="num">{s.currency === 'lbp' ? fmtLbp(num(s.amount), locale) : fmtUsd(num(s.amount))}</td></tr>)}
          </tbody></table>
        </section>
      )}

      {detail && <OrderDetail boot={boot} locale={locale} order={detail.order} onClose={() => setDetail(null)} onCustomer={onCustomer ? (ph, nm) => { setDetail(null); onCustomer(ph, nm); } : undefined} />}
      {collect && <CollectDialog boot={boot} locale={locale} person={collect} rate={rate} step={step} staff={staff} onClose={() => setCollect(null)}
        onDone={d => { setCollect(null); setDone(d); }} />}
      {done && <Modal open onClose={() => setDone(null)} title={pt('collected', locale)} footer={<><button className="btn" onClick={() => doPrint(debtReceiptHtml(done.s, done.allocs, done.remaining, boot.shop, locale, loadPrintSettings()))}>🖨 {pt('printReceipt', locale)}</button><span style={{ flex: 1 }} /><button className="btn primary" onClick={() => setDone(null)}>{pt('ok', locale)}</button></>}>
        <div className="stack">
          <div className="row spread"><strong>{done.s.name}</strong><strong>{done.s.currency === 'lbp' ? fmtLbp(num(done.s.amount), locale) : fmtUsd(num(done.s.amount))}</strong></div>
          {done.allocs.map(a => <div className="row spread" key={a.number}><span>{a.number}{a.closed ? ' ✓ ' + pt('fullyPaid', locale) : ''}</span><span>{fmtUsd(a.amount_cents)}</span></div>)}
          <div className="row spread" style={{ borderTop: '1px solid var(--line)', paddingTop: 6 }}><span>{pt('outstanding', locale)}</span><strong>{fmtUsd(done.remaining)}</strong></div>
        </div>
      </Modal>}
    </div>
  );
}

function CollectDialog({ boot, locale, person, rate, step, staff, onClose, onDone }: { boot: Booted; locale: L; person: DebtPerson; rate: number; step: number; staff: Staff; onClose: () => void; onDone: (d: { s: DebtSettlement; allocs: Array<{ number: string; amount_cents: number; closed: boolean }>; remaining: number }) => void }) {
  const [tender, setTender] = useState<Exclude<Tender, 'unpaid'>>('cash_usd');
  const cur: Currency = tender === 'cash_lbp' ? 'lbp' : 'usd';
  const owed = person.outstanding_cents;
  const fullIn = (c: Currency) => (c === 'lbp' ? String(roundLbp(usdToLbp(owed, rate), step, 'up')) : (owed / 100).toFixed(2).replace(/\.00$/, ''));
  const [amount, setAmount] = useState(() => fullIn('usd'));
  const [pristine, setPristine] = useState(true);       // still showing the suggested full amount: the first key replaces it
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setAmount(fullIn(cur)); setPristine(true); }, [cur]); // eslint-disable-line react-hooks/exhaustive-deps
  const type = (v: string) => { setAmount(v); setPristine(false); setErr(null); };
  // quick amounts: everything, "up to and including" each of the oldest orders, then round notes below the total
  const suggestions = useMemo(() => {
    const toCur = (c: number) => (cur === 'lbp' ? roundLbp(usdToLbp(c, rate), step, 'up') : Math.round(c) / 100);
    const out: number[] = [toCur(owed)]; let run = 0;
    for (const l of person.lines.filter(x => !x.closed).slice(0, 3)) { run += l.outstanding_cents; const v = toCur(run); if (!out.includes(v)) out.push(v); }
    const notes = cur === 'lbp' ? [500000, 1000000, 2000000, 5000000] : [5, 10, 20, 50, 100];
    for (const nv of notes) if (nv < toCur(owed) && !out.includes(nv)) out.push(nv);
    return out.slice(0, 6).sort((a, b) => a - b);
  }, [cur, owed, person, rate, step]);
  const n = Number(amount) || 0;
  const raw = cur === 'lbp' ? Math.round(n) : Math.round(n * 100);
  const cents = cur === 'lbp' ? lbpToCents(raw, rate) : raw;
  const plan = useMemo(() => allocate(person.lines, cents), [person, cents]);
  const allocated = plan.reduce((s, p) => s + p.amount_cents, 0);
  const remaining = owed - allocated;
  const confirm = async () => {
    if (busy || raw <= 0 || cents <= 0) return; setBusy(true); setErr(null);
    try {
      const shift = await currentShift(boot.db);
      const r = await settleDebt(boot.db, { phone: person.phone, name: person.name, tender, currency: cur, amount: raw, rate, lbpStep: step, lines: person.lines, shift, user_id: staff.user_id, reason: `${pt('debtCollected', locale)} · ${person.name || person.phone}` });
      boot.engine.poke();
      onDone({ s: r.settlement, allocs: r.allocations.map(a => { const l = person.lines.find(x => x.order.id === a.order_id)!; return { number: l.number, amount_cents: a.amount_cents, closed: a.amount_cents >= l.outstanding_cents }; }), remaining });
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  // keyboard: digits, dot, Backspace, Enter — like the sale's payment screen
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'Enter') { e.preventDefault(); void confirm(); }
      else if (/^\d$/.test(e.key) || (e.key === '.' && cur === 'usd' && !(amount.includes('.') && !pristine))) { e.preventDefault(); type(pristine ? e.key : amount + e.key); }
      else if (e.key === 'Backspace') { e.preventDefault(); type(pristine ? '' : amount.slice(0, -1)); }
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal open onClose={onClose} title={`${pt('collectFrom', locale)} ${person.name || person.phone}`} wide
      footer={<><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} /><button className="btn primary big" style={{ width: 'auto', minWidth: 200 }} disabled={busy || raw <= 0 || cents <= 0} onClick={confirm}>{pt('collect', locale)} {raw > 0 ? (cur === 'lbp' ? fmtLbp(raw, locale) : fmtUsd(raw)) : ''} ↵</button></>}>
      <div className="pay-grid">
        <div className="stack">
          <div className="pay-due">
            <div><span className="muted">{pt('totalOutstanding', locale)}</span><strong>{fmtUsd(owed)}</strong><strong>{fmtLbp(roundLbp(usdToLbp(owed, rate), step), locale)}</strong></div>
            <div><span className="muted">{pt('amountPaid', locale)}</span><span>{cur === 'lbp' ? fmtLbp(raw, locale) : fmtUsd(raw)}</span></div>
            <div className={remaining > 0 ? 'bad' : 'ok'}><span>{remaining > 0 ? pt('outstanding', locale) : pt('fullyPaid', locale)}</span><strong>{fmtUsd(Math.max(0, remaining))}</strong></div>
            {cents > owed && <div className="bad"><span>{pt('overpaid', locale)}</span><strong>{fmtUsd(cents - owed)}</strong></div>}
          </div>
          <div className="tenders">{TENDERS.map(t => <button key={t} className={`chip ${tender === t ? 'active' : ''}`} onClick={() => setTender(t)}>{pt(t, locale)}</button>)}</div>
          <div className="card alloc-box" style={{ background: '#fafafa' }}>
            <strong>{pt('allocation', locale)}</strong>
            {!plan.length && <div className="muted" style={{ fontSize: 13 }}>—</div>}
            {plan.map(p => <div className="row spread" key={p.line.order.id}><span>{fmtTime(p.line.at, locale)} · {p.line.number}</span><span>{fmtUsd(p.amount_cents)}{p.amount_cents >= p.line.outstanding_cents ? ' ✓' : ` (${pt('remainsOpen', locale)} ${fmtUsd(p.line.outstanding_cents - p.amount_cents)})`}</span></div>)}
          </div>
          {err && <p className="bad">{err}</p>}
        </div>
        <div className="stack">
          <div className={`pay-amount ${pristine ? 'pristine' : ''}`}><span className="muted">{pt(tender, locale)}</span><strong dir="ltr">{amount || '0'}</strong></div>
          <div className="suggest-grid">
            {suggestions.map(v => <button key={v} className={`chip ${Number(amount) === v ? 'active' : ''}`} onClick={() => type(String(v))}>{cur === 'lbp' ? v.toLocaleString('en-US') : '$' + v}</button>)}
          </div>
          {/* no ↵ on the pad here: the only way to collect is the labelled button below (or Enter on a keyboard) */}
          <NumPad value={pristine ? '' : amount} onChange={type} decimal={cur === 'usd'} big />
        </div>
      </div>
    </Modal>
  );
}
