'use client';
import { useEffect, useMemo, useState } from 'react';
import { fmtLbp, fmtUsd, roundLbp, settle, usdToLbp, type Currency, type Payment, type Tender } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import Modal, { NumPad } from './Modal';

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
export default function PayDialog({ totalCents, rate, lbpStep, locale, onConfirm, onClose, customer }: {
  totalCents: number; rate: number; lbpStep: number; locale: L; customer?: { name?: string; phone?: string };
  onConfirm: (payments: TenderRow[], changeIn: Currency) => Promise<void>; onClose: () => void;
}) {
  const [tender, setTender] = useState<Tender>('cash_usd');
  const [rows, setRows] = useState<TenderRow[]>([]);
  const [amount, setAmount] = useState('');            // typed amount for the selected tender (string from the numpad)
  const [pristine, setPristine] = useState(true);      // true while the field still holds the suggested exact amount
  const [changeIn, setChangeIn] = useState<Currency>('lbp');
  const [ref, setRef] = useState(''); const [uName, setUName] = useState(customer?.name ?? ''); const [uPhone, setUPhone] = useState(customer?.phone ?? '');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);

  const cur: Currency = tender === 'cash_lbp' ? 'lbp' : 'usd';
  const committed = useMemo(() => settle(totalCents, rows, rate, lbpStep, changeIn), [totalCents, rows, rate, lbpStep, changeIn]);
  const remainingIn = (c: Currency) => (c === 'lbp' ? roundLbp(usdToLbp(committed.remaining_cents, rate), lbpStep, 'up') : committed.remaining_cents / 100);
  const n = Number(amount) || 0;
  const pending: TenderRow | null = n > 0 ? { tender, currency: cur, amount: cur === 'lbp' ? Math.round(n) : Math.round(n * 100), reference: tender === 'card' || tender === 'wallet' ? ref || null : null, unpaid_name: tender === 'unpaid' ? uName.trim() : null, unpaid_phone: tender === 'unpaid' ? uPhone.trim() : null } : null;
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
    return out.sort((a, b) => a - b).slice(0, 6);
  }, [cur, committed.remaining_cents]); // eslint-disable-line react-hooks/exhaustive-deps

  const validatePending = () => { if (tender === 'unpaid' && (!uName.trim() || !uPhone.trim())) { setErr(pt('unpaidNeedsName', locale)); return false; } return true; };
  const addRow = () => { if (!pending || !validatePending()) return; setRows(r => [...r, pending]); setAmount(''); setRef(''); setPristine(true); };
  const confirm = async () => {
    if (busy) return;
    if (pending && !validatePending()) return;
    const all = pending ? [...rows, pending] : rows;
    if (settle(totalCents, all, rate, lbpStep, changeIn).remaining_cents > 0) return;
    setBusy(true);
    try { await onConfirm(all, changeIn); } catch (e) { setErr((e as Error).message); setBusy(false); }
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
    <Modal open onClose={onClose} title={pt('pay', locale)} wide
      footer={<>
        <button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button>
        <span style={{ flex: 1 }} />
        <button className="btn primary big" style={{ width: 'auto', minWidth: 220 }} disabled={!canConfirm || busy} onClick={confirm}>{pt('confirmPay', locale)} ↵</button>
      </>}>
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
            {tender === 'unpaid' && <div className="row" style={{ gap: 8 }}><input className="input" placeholder={pt('customerName', locale)} value={uName} onChange={e => setUName(e.target.value)} /><input className="input" placeholder={pt('customerPhone', locale)} inputMode="tel" value={uPhone} onChange={e => setUPhone(e.target.value)} /></div>}
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
    </Modal>
  );
}
