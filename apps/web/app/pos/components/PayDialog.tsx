'use client';
import { useEffect, useMemo, useState } from 'react';
import { fmtLbp, fmtUsd, lbpToCents, roundLbp, settle, usdToLbp, type Currency, type Payment, type Tender } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import Modal, { NumPad } from './Modal';

type TenderRow = Omit<Payment, 'id' | 'order_id' | 'at'>;
const TENDERS: Tender[] = ['cash_usd', 'cash_lbp', 'card', 'wallet', 'unpaid'];

/**
 * Pay: amount due in both currencies; add tenders (cash USD, cash LBP, card, wallet+ref, unpaid+name/phone); change in the currency the
 * cashier picks, LBP rounded down to the note step. Confirm is enabled only when nothing remains due.
 * Keyboard: digits type the amount, Enter adds the selected tender, Ctrl+Enter = exact cash USD, Esc closes.
 */
export default function PayDialog({ totalCents, rate, lbpStep, locale, onConfirm, onClose, customer }: {
  totalCents: number; rate: number; lbpStep: number; locale: L; customer?: { name?: string; phone?: string };
  onConfirm: (payments: TenderRow[], changeIn: Currency) => Promise<void>; onClose: () => void;
}) {
  const [tender, setTender] = useState<Tender>('cash_usd');
  const [amount, setAmount] = useState('');
  const [rows, setRows] = useState<TenderRow[]>([]);
  const [changeIn, setChangeIn] = useState<Currency>('lbp');
  const [ref, setRef] = useState(''); const [uName, setUName] = useState(customer?.name ?? ''); const [uPhone, setUPhone] = useState(customer?.phone ?? '');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);

  const s = useMemo(() => settle(totalCents, rows, rate, lbpStep, changeIn), [totalCents, rows, rate, lbpStep, changeIn]);
  const cur: Currency = tender === 'cash_lbp' ? 'lbp' : 'usd';
  const remainingIn = cur === 'lbp' ? roundLbp(usdToLbp(s.remaining_cents, rate), lbpStep, 'up') : s.remaining_cents / 100;

  const add = (amt?: number) => {
    const n = amt ?? Number(amount);
    if (!n || n <= 0) return;
    if (tender === 'unpaid' && (!uName.trim() || !uPhone.trim())) { setErr(pt('unpaidNeedsName', locale)); return; }
    const row: TenderRow = { tender, currency: cur, amount: cur === 'lbp' ? Math.round(n) : Math.round(n * 100),
      reference: tender === 'card' || tender === 'wallet' ? ref || null : null, unpaid_name: tender === 'unpaid' ? uName.trim() : null, unpaid_phone: tender === 'unpaid' ? uPhone.trim() : null };
    setRows(r => [...r, row]); setAmount(''); setRef(''); setErr(null);
  };
  const exact = () => add(remainingIn);
  const confirm = async () => {
    if (s.remaining_cents > 0 || busy) return;
    setBusy(true);
    try { await onConfirm(rows, changeIn); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); if (s.remaining_cents > 0) { setTender('cash_usd'); add(s.remaining_cents / 100); } else void confirm(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (amount) add(); else if (s.remaining_cents === 0) void confirm(); }
      else if (/^\d$/.test(e.key) || e.key === '.') { if (!(e.target instanceof HTMLInputElement)) setAmount(a => a + e.key); }
      else if (e.key === 'Backspace' && !(e.target instanceof HTMLInputElement)) setAmount(a => a.slice(0, -1));
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Modal open onClose={onClose} title={pt('pay', locale)} wide
      footer={<>
        <button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button>
        <span style={{ flex: 1 }} />
        <button className="btn primary big" style={{ width: 'auto', minWidth: 220 }} disabled={s.remaining_cents > 0 || busy} onClick={confirm}>{pt('confirmPay', locale)}</button>
      </>}>
      <div className="pay-grid">
        <div className="stack">
          <div className="pay-due">
            <div><span className="muted">{pt('due', locale)}</span><strong>{fmtUsd(totalCents)}</strong><strong>{fmtLbp(roundLbp(usdToLbp(totalCents, rate), lbpStep), locale)}</strong></div>
            <div><span className="muted">{pt('paid', locale)}</span><span>{fmtUsd(s.paid_cents + s.unpaid_cents)}</span></div>
            {s.remaining_cents > 0
              ? <div className="bad"><span>{pt('remaining', locale)}</span><strong>{fmtUsd(s.remaining_cents)}</strong><strong>{fmtLbp(roundLbp(usdToLbp(s.remaining_cents, rate), lbpStep, 'up'), locale)}</strong></div>
              : <div className="ok"><span>{pt('change', locale)}</span><strong>{changeIn === 'usd' ? fmtUsd(s.change_usd_cents) : fmtLbp(s.change_lbp, locale)}</strong></div>}
            <div className="row" style={{ gap: 6, alignItems: 'center' }}>
              <span className="muted" style={{ fontSize: 13 }}>{pt('changeIn', locale)}</span>
              <div className="seg"><button className={changeIn === 'lbp' ? 'active' : ''} onClick={() => setChangeIn('lbp')}>ل.ل.</button><button className={changeIn === 'usd' ? 'active' : ''} onClick={() => setChangeIn('usd')}>$</button></div>
            </div>
          </div>
          <div className="tenders">
            {TENDERS.map(t => <button key={t} className={`chip ${tender === t ? 'active' : ''}`} onClick={() => setTender(t)}>{pt(t, locale)}</button>)}
          </div>
          {(tender === 'card' || tender === 'wallet') && <input className="input" placeholder={pt('reference', locale)} value={ref} onChange={e => setRef(e.target.value)} />}
          {tender === 'unpaid' && <div className="row" style={{ gap: 8 }}><input className="input" placeholder={pt('customerName', locale)} value={uName} onChange={e => setUName(e.target.value)} /><input className="input" placeholder={pt('customerPhone', locale)} inputMode="tel" value={uPhone} onChange={e => setUPhone(e.target.value)} /></div>}
          <ul className="tender-list">
            {rows.map((r, i) => <li key={i}><span>{pt(r.tender, locale)}{r.reference ? ` · ${r.reference}` : ''}{r.unpaid_name ? ` · ${r.unpaid_name}` : ''}</span><strong>{r.currency === 'lbp' ? fmtLbp(r.amount, locale) : fmtUsd(r.amount)}</strong><button className="btn icon" onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}>✕</button></li>)}
          </ul>
          {err && <p className="bad">{err}</p>}
        </div>
        <div className="stack">
          <div className="pay-amount"><span className="muted">{pt(tender, locale)} · {cur === 'lbp' ? 'ل.ل.' : '$'}</span><strong>{amount || '0'}</strong></div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" style={{ flex: 1 }} onClick={exact} disabled={s.remaining_cents === 0}>{pt('exact', locale)}: {cur === 'lbp' ? fmtLbp(remainingIn as number, locale) : fmtUsd(s.remaining_cents)}</button>
            <button className="btn primary" onClick={() => add()} disabled={!amount}>{pt('addTender', locale)}</button>
          </div>
          <NumPad value={amount} onChange={setAmount} decimal={cur === 'usd'} onEnter={() => add()} big />
          {cur === 'lbp' && <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{[100000, 500000, 1000000, 5000000].map(n => <button key={n} className="chip" onClick={() => setAmount(String((Number(amount) || 0) + n))}>+{(n / 1000).toLocaleString('en-US')}k</button>)}</div>}
          {cur === 'usd' && <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{[1, 5, 10, 20, 50, 100].map(n => <button key={n} className="chip" onClick={() => setAmount(String((Number(amount) || 0) + n))}>+${n}</button>)}</div>}
        </div>
      </div>
    </Modal>
  );
}
export const _lbpToCents = lbpToCents;
