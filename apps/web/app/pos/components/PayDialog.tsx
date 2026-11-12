'use client';
import { useEffect, useMemo, useState } from 'react';
import { fmtLbp, fmtUsd, roundLbp, settle, usdToLbp, type Currency, type Payment, type Tender , debtLines, findCustomer, normPhone, searchCustomers, type ShopCustomer, type Staff } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import Modal, { NumPad } from './Modal';
import CustomerPick from './CustomerPick';
import OwnerPin from './OwnerPin';

type TenderRow = Omit<Payment, 'id' | 'order_id' | 'at'>;
const TENDERS: Tender[] = ['cash_usd', 'cash_lbp', 'card', 'wallet', 'unpaid'];
const USD_NOTES = [1, 5, 10, 20, 50, 100];
const LBP_NOTES = [50000, 100000, 500000, 1000000];

/**
 * Pay. The amount field is pre-filled with the exact remaining amount in the selected tender's currency, and whatever is in the
 * field counts immediately in paid / remaining / change — so a plain cash sale is: open → confirm. "إضافة" only matters for split
 * payments (it moves the typed amount into the list so a second tender can be typed). Suggested amounts are the next notes a
 * customer would hand over for what remains. The layout never reflows when switching tender or currency.
 */
export type CourierExtra = { courier_name: string | null; courier_fee_cents: number; fee_currency: Currency; fee_amount: number };
export default function PayDialog({ totalCents, rate, lbpStep, locale, onConfirm, onClose, customer, onCustomer, courier, title, boot, isOwner, me }: {
  totalCents: number; rate: number; lbpStep: number; locale: L; customer?: { name?: string; phone?: string };
  /** sale in progress: the customer shown here IS the cart's customer — picking / clearing it here changes the cart (one field, two places to reach it) */
  onCustomer?: (c: { name: string; phone: string } | null) => void;
  /** delivery handover: ask who delivered and the driver's fee (recorded as cash out of the drawer) */
  courier?: { name?: string | null } | null; title?: string; boot?: Booted; isOwner?: boolean; /** who is at the till — lets a non-owner get an over-limit debt approved with the approval PIN */ me?: Staff;
  onConfirm: (payments: TenderRow[], changeIn: Currency, extra?: CourierExtra) => Promise<void>; onClose: () => void;
}) {
  const [drvName, setDrvName] = useState(courier?.name ?? ''); const [drvFee, setDrvFee] = useState(''); const [drvCur, setDrvCur] = useState<Currency>('usd');
  const feeCents = drvCur === 'lbp' ? Math.round(((Number(drvFee) || 0) / rate) * 100) : Math.round((Number(drvFee) || 0) * 100);
  const [tender, setTender] = useState<Tender>('cash_usd');
  const [rows, setRows] = useState<TenderRow[]>([]);
  const [amount, setAmount] = useState('');            // typed amount for the selected tender (string from the numpad)
  const [pristine, setPristine] = useState(true);      // true while the field still holds the suggested exact amount
  const [changeIn, setChangeIn] = useState<Currency>('lbp');
  const [ref, setRef] = useState(''); const [uName, setUName] = useState(customer?.name ?? ''); const [uPhone, setUPhone] = useState(customer?.phone ?? '');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  // the customer comes from the cart / the order (line at the top). It can be picked here only when the sale has none yet, or changed when the caller allows it (Sell).
  const [pickOpen, setPickOpen] = useState(false);
  const [cust, setCust] = useState<{ name: string; phone: string } | null>(customer?.phone ? { name: customer.name ?? '', phone: customer.phone } : null);
  const [custDebt, setCustDebt] = useState(0);
  useEffect(() => { if (!boot || !cust?.phone) { setCustDebt(0); return; } let on = true; debtLines(boot.db, { openOnly: true, phones: [cust.phone] }).then(ls => { if (on) setCustDebt(ls.reduce((a, l) => a + l.outstanding_cents, 0)); }); return () => { on = false; }; }, [boot, cust?.phone]);
  const canChange = !!onCustomer || !customer?.phone;      // an order that already has its customer is fixed
  const pickCustomer = (c: { name: string; phone: string }) => { const v = { name: c.name || '', phone: c.phone }; setUName(v.name); setUPhone(v.phone); setCust(v); setPickOpen(false); setErr(null); onCustomer?.(v); };
  const clearCustomer = () => { setCust(null); setUName(''); setUPhone(''); onCustomer?.(null); };

  const cur: Currency = tender === 'cash_lbp' ? 'lbp' : 'usd';
  const committed = useMemo(() => settle(totalCents, rows, rate, lbpStep, changeIn), [totalCents, rows, rate, lbpStep, changeIn]);
  const remainingIn = (c: Currency) => (c === 'lbp' ? roundLbp(usdToLbp(committed.remaining_cents, rate), lbpStep, 'up') : committed.remaining_cents / 100);
  const n = Number(amount) || 0;
  const pending: TenderRow | null = n > 0 ? { tender, currency: cur, amount: cur === 'lbp' ? Math.round(n) : Math.round(n * 100), reference: ref.trim() || null, unpaid_name: tender === 'unpaid' ? uName.trim() : null, unpaid_phone: tender === 'unpaid' ? uPhone.trim() : null } : null;
  const live = useMemo(() => settle(totalCents, pending ? [...rows, pending] : rows, rate, lbpStep, changeIn), [totalCents, rows, pending, rate, lbpStep, changeIn]);

  // pre-fill the exact remaining amount whenever the tender changes or a row is added, unless the cashier already typed something
  useEffect(() => {
    if (!pristine) return;
    const r = remainingIn(cur);
    setAmount(r > 0 ? (cur === 'lbp' ? String(r) : r.toFixed(2).replace(/\.00$/, '')) : '');
  }, [tender, rows, committed.remaining_cents]); // eslint-disable-line react-hooks/exhaustive-deps
  const type = (v: string) => { setAmount(v); setPristine(false); setErr(null); };
  const pick = (v: number) => { setAmount(cur === 'lbp' ? String(v) : String(v)); setPristine(false); setErr(null); };

  const suggestions = useMemo(() => {
    const rem = remainingIn(cur); const notes = cur === 'lbp' ? LBP_NOTES : USD_NOTES; const out: number[] = [];
    if (rem <= 0) return notes.slice(0, 6);
    for (const d of notes) for (let k = 1; out.length < 12; k++) { const v = Math.ceil(rem / d) * d + (k - 1) * d; if (v > rem - 1e-9 && !out.includes(v)) { out.push(v); break; } }
    for (const d of notes) { const v = Math.ceil(rem / d) * d + d; if (!out.includes(v)) out.push(v); }
    const list = out.sort((a, b) => a - b).slice(0, cur === 'usd' ? 4 : 6);
    // USD: $50 and $100 are always offered last — customers often only carry big notes
    if (cur === 'usd') for (const big of [50, 100]) { if (big > rem - 1e-9 && !list.includes(big)) list.push(big); }
    return cur === 'usd' ? [...new Set(list)].sort((a, b) => a - b) : list;
  }, [cur, committed.remaining_cents]); // eslint-disable-line react-hooks/exhaustive-deps

  const [credit, setCredit] = useState<{ limit: number; outstanding: number } | null>(null);
  useEffect(() => {
    if (!boot || tender !== 'unpaid' || normPhone(uPhone).length < 6) { setCredit(null); return; }
    let on = true;
    (async () => { const c = await findCustomer(boot.db, uPhone); if (!c?.credit_limit_cents) { if (on) setCredit(null); return; } const ls = await debtLines(boot.db, { openOnly: true, phones: [uPhone] }); if (on) setCredit({ limit: c.credit_limit_cents, outstanding: ls.reduce((s, l) => s + l.outstanding_cents, 0) }); })();
    return () => { on = false; };
  }, [boot, tender, uPhone]);
  const pendingCents = pending ? (pending.currency === 'lbp' ? Math.round((pending.amount * 100) / rate) : pending.amount) : 0;
  const overLimit = credit && pending ? credit.outstanding + pendingCents > credit.limit : false;
  // over the customer's credit limit: the owner passes; anyone else needs the approval PIN once for this payment
  const [limitOk, setLimitOk] = useState(false); const [limitGate, setLimitGate] = useState<null | 'add' | 'confirm'>(null); const [members, setMembers] = useState<Staff[]>([]);
  useEffect(() => { boot?.db.staff.toArray().then(setMembers); }, [boot]);
  useEffect(() => { setLimitOk(false); }, [uPhone]);
  const validatePending = (why: 'add' | 'confirm' = 'confirm') => {
    if (tender === 'unpaid' && !uPhone.trim()) { setErr(pt('unpaidNeedsCustomer', locale)); if (canChange && boot) { setPickOpen(true); } return false; }
    if (tender === 'unpaid' && overLimit && !isOwner && !limitOk) { if (me && members.length) setLimitGate(why); else setErr(pt('creditLimitExceeded', locale)); return false; }
    return true;
  };
  const addRow = () => { if (!pending || !validatePending('add')) return; setRows(r => [...r, pending]); setAmount(''); setRef(''); setPristine(true); };
  const confirm = async () => {
    if (busy) return;
    if (pending && !validatePending('confirm')) return;
    const all = pending ? [...rows, pending] : rows;
    if (settle(totalCents, all, rate, lbpStep, changeIn).remaining_cents > 0) return;
    setBusy(true);
    try { await onConfirm(all, changeIn, courier ? { courier_name: drvName.trim() || null, courier_fee_cents: feeCents, fee_currency: drvCur, fee_amount: drvCur === 'lbp' ? Math.round(Number(drvFee) || 0) : Math.round((Number(drvFee) || 0) * 100) } : undefined); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  const canConfirm = live.remaining_cents === 0 && (rows.length > 0 || !!pending);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'Enter') { e.preventDefault(); if (canConfirm) void confirm(); else if (pending) addRow(); }
      else if (/^\d$/.test(e.key) || e.key === '.') { e.preventDefault(); type(pristine ? e.key : amount + e.key); }
      else if (e.key === 'Backspace') { e.preventDefault(); type(pristine ? '' : amount.slice(0, -1)); }
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const money = (c: Currency, v: number) => (c === 'lbp' ? fmtLbp(v, locale) : fmtUsd(Math.round(v * 100)));
  return (
    <Modal open onClose={onClose} title={title ?? pt('pay', locale)} wide
      footer={<>
        <button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button>
        <span style={{ flex: 1 }} />
        <button className="btn primary big" style={{ width: 'auto', minWidth: 220 }} disabled={!canConfirm || busy} onClick={confirm}>{pt('confirmPay', locale)} ↵</button>
      </>}>
      {boot && (cust || canChange) && <div className="pay-customer">
        {cust
          ? <><span>👤 <strong>{cust.name || '—'}</strong> <span className="muted" dir="ltr">{cust.phone}</span></span>
              {custDebt > 0 && <span className="pill bad">{pt('debtShort', locale)} {fmtUsd(custDebt)}</span>}
              <span style={{ flex: 1 }} />
              {canChange && <><span className="cust-anchor"><button type="button" className="btn" aria-expanded={pickOpen} onClick={() => setPickOpen(o => !o)}>📇 {pt('changeCustomer', locale)}</button>{pickOpen && <CustomerPick boot={boot} locale={locale} onPick={pickCustomer} onClose={() => setPickOpen(false)} />}</span>
              <button type="button" className="btn icon" title={pt('removeCustomer', locale)} onClick={clearCustomer}>✕</button></>}</>
          : <><span className="muted">👤 {pt('noCustomer', locale)}</span><span style={{ flex: 1 }} /><span className="cust-anchor"><button type="button" className="btn" aria-expanded={pickOpen} onClick={() => setPickOpen(o => !o)}>📇 {pt('pickCustomer', locale)}</button>{pickOpen && <CustomerPick boot={boot} locale={locale} onPick={pickCustomer} onClose={() => setPickOpen(false)} />}</span></>}
      </div>}
      <div className="pay-grid">
        <div className="stack">
          <div className="pay-due">
            <div><span className="muted">{pt('due', locale)}</span><strong>{fmtUsd(totalCents)}</strong><strong>{fmtLbp(roundLbp(usdToLbp(totalCents, rate), lbpStep), locale)}</strong></div>
            <div><span className="muted">{pt('paid', locale)}</span><span>{fmtUsd(live.paid_cents + live.unpaid_cents)}</span></div>
            <div className={live.remaining_cents > 0 ? 'bad' : 'ok'}>
              <span>{live.remaining_cents > 0 ? pt('remaining', locale) : pt('change', locale)}</span>
              <strong>{live.remaining_cents > 0 ? fmtUsd(live.remaining_cents) : changeIn === 'usd' ? fmtUsd(live.change_usd_cents) : fmtLbp(live.change_lbp, locale)}</strong>
              <strong>{live.remaining_cents > 0 ? fmtLbp(roundLbp(usdToLbp(live.remaining_cents, rate), lbpStep, 'up'), locale) : changeIn === 'usd' ? fmtLbp(usdToLbp(live.change_usd_cents, rate), locale) : fmtUsd(live.change_cents)}</strong>
            </div>
            {courier && <div className="cod-driver">
              <div className="row" style={{ gap: 6, alignItems: 'center' }}><span className="muted" style={{ minWidth: 80 }}>{pt('driverName', locale)}</span><input className="input" value={drvName} onChange={e => setDrvName(e.target.value)} style={{ flex: 1 }} /></div>
              <div className="row" style={{ gap: 6, alignItems: 'center' }}><span className="muted" style={{ minWidth: 80 }}>{pt('driverFee', locale)}</span>
                <input className="input" dir="ltr" inputMode="decimal" value={drvFee} onChange={e => setDrvFee(e.target.value)} style={{ flex: 1 }} placeholder="0" />
                <div className="seg"><button className={drvCur === 'usd' ? 'active' : ''} onClick={() => setDrvCur('usd')}>$</button><button className={drvCur === 'lbp' ? 'active' : ''} onClick={() => setDrvCur('lbp')}>ل.ل.</button></div></div>
              <div className="row spread"><span className="muted">{pt('netToStore', locale)}</span><strong>{fmtUsd(live.paid_cents - feeCents)}</strong></div>
              <small className="muted">{pt('driverFeeHint', locale)}</small>
            </div>}
            <div className="row" style={{ gap: 6, alignItems: 'center' }}>
              <span className="muted" style={{ fontSize: 13 }}>{pt('changeIn', locale)}</span>
              <div className="seg"><button className={changeIn === 'lbp' ? 'active' : ''} onClick={() => setChangeIn('lbp')}>ل.ل.</button><button className={changeIn === 'usd' ? 'active' : ''} onClick={() => setChangeIn('usd')}>$</button></div>
            </div>
          </div>
          <div className="tenders">
            {TENDERS.map(t => <button key={t} className={`chip ${tender === t ? 'active' : ''}`} onClick={() => { setTender(t); setPristine(true); setErr(null); }}>{pt(t, locale)}</button>)}
          </div>
          <div className="tender-extra">
            {(tender === 'card' || tender === 'wallet') && <input className="input" placeholder={pt('reference', locale)} value={ref} onChange={e => setRef(e.target.value)} />}
            {tender !== 'card' && tender !== 'wallet' && <input className="input" placeholder={pt(tender === 'unpaid' ? 'debtNote' : 'payNote', locale)} value={ref} onChange={e => setRef(e.target.value)} />}
            {tender === 'unpaid' && credit && <small className={overLimit ? 'bad' : 'muted'}>{pt('creditLimit', locale)} {fmtUsd(credit.limit)} · {pt('outstanding', locale)} {fmtUsd(credit.outstanding)}{overLimit ? ` — ${pt(isOwner ? 'creditLimitOwner' : 'creditLimitExceeded', locale)}` : ''}</small>}
          </div>
          <ul className="tender-list">
            {rows.map((r, i) => <li key={i}><span>{pt(r.tender, locale)}{r.reference ? ` · ${r.reference}` : ''}{r.unpaid_name ? ` · ${r.unpaid_name}` : ''}</span><strong>{r.currency === 'lbp' ? fmtLbp(r.amount, locale) : fmtUsd(r.amount)}</strong><button className="btn icon" onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}>✕</button></li>)}
            {pending && <li className="pending"><span>{pt(tender, locale)}</span><strong>{money(cur, n)}</strong><button className="btn" onClick={addRow} title={pt('addTender', locale)}>＋ {pt('addTender', locale)}</button></li>}
          </ul>
          {err && <p className="bad">{err}</p>}
        </div>
        <div className="stack">
          <div className={`pay-amount ${pristine ? 'pristine' : ''}`}><span className="muted">{pt(tender, locale)}</span><strong dir="ltr">{amount || '0'}</strong></div>
          <div className="suggest-grid">
            {suggestions.map(v => <button key={v} className={`chip ${Number(amount) === v ? 'active' : ''}`} onClick={() => pick(v)}>{cur === 'lbp' ? v.toLocaleString('en-US') : '$' + v}</button>)}
          </div>
          <NumPad value={pristine ? '' : amount} onChange={v => type(v)} decimal={cur === 'usd'} onEnter={() => (canConfirm ? void confirm() : addRow())} big />
        </div>
      </div>
      {limitGate && me && <OwnerPin open locale={locale} staff={members} me={me} reason={`${pt('creditLimit', locale)} ${credit ? fmtUsd(credit.limit) : ''}`} onDone={id => { setLimitGate(null); if (id) { setLimitOk(true); setErr(null); } }} />}
    </Modal>
  );
}
