'use client';
import { useMemo, useState } from 'react';

type Mode = 'cash' | 'wallet' | 'card' | 'debt' | 'mixed';
type Props = { orderId: string; dueCents: number; rate: number; step: number; canDebt: boolean; /** the database takes a card payment from this screen (127) */ cardOk?: boolean; creditLimitCents: number | null; debtCents: number | null; ar: boolean };
const usdFmt = (c: number) => `$${(c / 100).toFixed(2)}`;
const lbpFmt = (n: number, ar: boolean) => `${Math.round(n).toLocaleString('en-US')} ${ar ? 'ل.ل.' : 'LBP'}`;
const num = (s: string) => { const n = Number(String(s).replace(/,/g, '')); return Number.isFinite(n) && n > 0 ? n : 0; };

/**
 * The driver's pay screen for one delivery (81, 127). He first says HOW the customer paid — cash, Whish / OMT, card, not paid (debt),
 * or more than one way — and only then sees the boxes that way needs. Cash is money HE holds until he hands it to the shop; every
 * other way went to the shop (or is the customer's debt), so he holds nothing for it and the shop owes him his delivery pay.
 * Details: what the customer handed him in dollars and / or lira, Whish, card, and — for what was not paid — debt on the customer. It suggests the usual notes, works out the change in the currency he chooses, and only lets him
 * close the order when it is covered. The server checks the same things again; this screen only saves him the arithmetic.
 */
export default function DriverPay({ orderId, dueCents, rate, step, canDebt, cardOk, creditLimitCents, debtCents, ar }: Props) {
  const [mode, setMode] = useState<Mode>('cash');
  const [usd, setUsd] = useState(''); const [lbp, setLbp] = useState(''); const [whish, setWhish] = useState(''); const [card, setCard] = useState('');
  const [changeIn, setChangeIn] = useState<'usd' | 'lbp'>('usd'); const [asDebt, setAsDebt] = useState(false); const [busy, setBusy] = useState(false);
  const toLbp = (c: number) => (c * rate) / 100; const up = (n: number) => Math.ceil(n / step) * step; const down = (n: number) => Math.floor(n / step) * step;
  const dueLbp = up(toLbp(dueCents));

  const m = useMemo(() => {
    // only the boxes of the chosen way count: a number typed under another way is never sent
    const hasCash = mode === 'cash' || mode === 'mixed';
    const usdC = hasCash ? Math.round(num(usd) * 100) : 0, lbpN = hasCash ? Math.round(num(lbp)) : 0;
    const whishC = mode === 'wallet' ? dueCents : mode === 'mixed' ? Math.min(Math.round(num(whish) * 100), dueCents) : 0;
    const cardC = mode === 'card' ? dueCents : mode === 'mixed' ? Math.min(Math.round(num(card) * 100), Math.max(0, dueCents - whishC)) : 0;
    const cash = usdC + Math.round((lbpN * 100) / rate);
    const diff = cash + whishC + cardC - dueCents;                       // > 0 change to give · < 0 still missing
    let changeUsd = 0, changeLbp = 0;
    const tol = Math.ceil((step * 100) / rate);                 // under one note of lira: rounding, not change
    if (diff > tol) { if (changeIn === 'usd') changeUsd = diff; else changeLbp = down(toLbp(diff)); }
    const missing = diff < 0 ? -diff : 0;
    const debtRoom = creditLimitCents != null ? Math.max(0, creditLimitCents - (debtCents ?? 0)) : null;   // null = no limit set
    const debtOk = canDebt && (debtRoom == null || missing <= debtRoom);
    const unpaid = (asDebt || mode === 'debt') && missing > 0 && debtOk ? missing : 0;
    const covered = missing === 0 || unpaid > 0;
    return { usdC, lbpN, whishC, cardC, hasCash, cash, diff, tol, changeUsd, changeLbp, missing, debtRoom, debtOk, unpaid, covered };
  }, [mode, usd, lbp, whish, card, changeIn, asDebt, dueCents, rate, step, canDebt, creditLimitCents, debtCents]); // eslint-disable-line react-hooks/exhaustive-deps

  // the notes people usually hand over: the exact amount, then the next round ones
  const usdNotes = useMemo(() => { const s = new Set<number>([dueCents]); for (const n of [500, 1000, 2000, 5000, 10000]) { const v = Math.ceil(dueCents / n) * n; if (v > dueCents) s.add(v); } return [...s].sort((a, b) => a - b).slice(0, 5); }, [dueCents]);
  const lbpNotes = useMemo(() => { const s = new Set<number>([dueLbp]); for (const n of [50000, 100000, 500000, 1000000]) { const v = Math.ceil(dueLbp / n) * n; if (v > dueLbp) s.add(v); } return [...s].sort((a, b) => a - b).slice(0, 4); }, [dueLbp]);
  const pay = JSON.stringify({ usd: m.usdC, lbp: m.lbpN, change_usd: m.changeUsd, change_lbp: m.changeLbp, wallet: m.whishC, ...(m.cardC ? { card: m.cardC } : {}), unpaid: m.unpaid });
  const nothing = m.usdC === 0 && m.lbpN === 0 && m.whishC === 0 && m.cardC === 0;
  const holds = m.cash - (m.changeUsd + Math.round((m.changeLbp * 100) / rate)) > 0;      // does any of it end up in his pocket?
  const chip = (active: boolean): React.CSSProperties => ({ padding: '8px 12px', borderRadius: 999, border: '1px solid #d1d5db', background: active ? 'var(--brand, #0f766e)' : '#fff', color: active ? '#fff' : 'inherit', fontWeight: 600, fontSize: 14 });
  const L = (a: string, e: string) => (ar ? a : e);

  return (
    <form method="post" action={`/api/d/${orderId}/step`} className="stack" style={{ gap: 10 }} onSubmit={e => { if (!m.covered || busy) { e.preventDefault(); return; } setBusy(true); }}>
      <input type="hidden" name="s" value="delivered" /><input type="hidden" name="pay" value={pay} />
      <div className="row spread" style={{ alignItems: 'baseline' }}>
        <strong>💵 {L('المطلوب من الزبون', 'To collect')}</strong>
        <span style={{ textAlign: 'end' }}><strong dir="ltr" style={{ fontSize: 22 }}>{usdFmt(dueCents)}</strong><div className="muted" dir="ltr" style={{ fontSize: 13 }}>{lbpFmt(dueLbp, ar)}</div></span>
      </div>

      <strong style={{ fontSize: 15 }}>{L('كيف دفع الزبون؟', 'How did the customer pay?')}</strong>
      <div className="drv-modes" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {([['cash', '💵', L('نقداً', 'Cash')], ['wallet', '📱', 'Whish / OMT'], ...(cardOk ? [['card', '💳', L('بطاقة', 'Card')]] : []), ['debt', '📒', L('لم يدفع — دين', 'Not paid — debt')], ['mixed', '➕', L('أكثر من طريقة', 'More than one way')]] as [Mode, string, string][]).map(([k, ico, label]) =>
          <button key={k} type="button" aria-pressed={mode === k} onClick={() => setMode(k)} style={{ ...chip(mode === k), borderRadius: 14, padding: '12px 10px', fontSize: 16, minHeight: 54, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}><span aria-hidden="true">{ico}</span>{label}</button>)}
      </div>

      {(mode === 'wallet' || mode === 'card') && <div className="card" style={{ background: '#eff6ff' }}>
        <strong dir="auto">{mode === 'wallet' ? L('دفع الزبون المبلغ كاملاً للمحل عبر Whish / OMT', 'The customer paid the shop the full amount by Whish / OMT') : L('دفع الزبون المبلغ كاملاً بالبطاقة', 'The customer paid the full amount by card')}: <span dir="ltr">{usdFmt(dueCents)}</span></strong>
      </div>}
      {mode === 'debt' && (canDebt
        ? <div className="card" style={{ background: m.debtOk ? '#fff8e6' : '#fef2f2' }}><strong>{L('الزبون لم يدفع: يُسجَّل المبلغ كاملاً ديناً عليه', 'The customer did not pay: the full amount is recorded as his debt')}: <span dir="ltr">{usdFmt(dueCents)}</span></strong>
            {!m.debtOk && <div className="bad" style={{ marginTop: 4 }}>{L('يتجاوز حدّ الدين المسموح لهذا الزبون', 'Over this customer\'s credit limit')} ({usdFmt(m.debtRoom ?? 0)} {L('متاح', 'left')}) — {L('اتصل بالمحل.', 'call the shop.')}</div>}</div>
        : <div className="card bad" style={{ background: '#fef2f2' }}>{L('لا رقم للزبون على الطلب — لا يمكن تسجيل دين. اتصل بالمحل.', 'No customer number on the order — a debt cannot be recorded. Call the shop.')}</div>)}

      {m.hasCash && <>
      <label className="label" style={{ margin: 0 }}>{L('نقدي بالدولار', 'Cash in dollars')}</label>
      <input className="input" dir="ltr" inputMode="decimal" placeholder="0.00" value={usd} onChange={e => setUsd(e.target.value.replace(/[^0-9.]/g, ''))} style={{ fontSize: 20, minHeight: 52 }} />
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{usdNotes.map(c => <button key={c} type="button" style={chip(Math.round(num(usd) * 100) === c && !num(lbp))} onClick={() => { setUsd((c / 100).toFixed(2)); setLbp(''); }}><span dir="ltr">{usdFmt(c)}</span></button>)}</div>

      <label className="label" style={{ margin: 0 }}>{L('نقدي بالليرة', 'Cash in lira')}</label>
      <input className="input" dir="ltr" inputMode="numeric" placeholder="0" value={lbp} onChange={e => setLbp(e.target.value.replace(/[^0-9]/g, ''))} style={{ fontSize: 20, minHeight: 52 }} />
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{lbpNotes.map(n => <button key={n} type="button" style={chip(Math.round(num(lbp)) === n && !num(usd))} onClick={() => { setLbp(String(n)); setUsd(''); }}><span dir="ltr">{n.toLocaleString('en-US')}</span></button>)}</div>

      </>}
      {mode === 'mixed' && <>
      <label className="label" style={{ margin: 0 }}>Whish / OMT ($) <small className="muted">— {L('دفع الزبون للمحل مباشرة', 'the customer paid the shop directly')}</small></label>
      <div className="row" style={{ gap: 6 }}>
        <input className="input" dir="ltr" inputMode="decimal" placeholder="0.00" value={whish} onChange={e => setWhish(e.target.value.replace(/[^0-9.]/g, ''))} style={{ flex: 1 }} />
        <button type="button" className="btn" onClick={() => { setWhish((Math.max(0, dueCents - m.cash - m.cardC) / 100).toFixed(2)); }}>{L('الباقي', 'The rest')}</button>
      </div>
      {cardOk && <><label className="label" style={{ margin: 0 }}>{L('بطاقة ($)', 'Card ($)')}</label>
      <div className="row" style={{ gap: 6 }}>
        <input className="input" dir="ltr" inputMode="decimal" placeholder="0.00" value={card} onChange={e => setCard(e.target.value.replace(/[^0-9.]/g, ''))} style={{ flex: 1 }} />
        <button type="button" className="btn" onClick={() => { setCard((Math.max(0, dueCents - m.cash - m.whishC) / 100).toFixed(2)); }}>{L('الباقي', 'The rest')}</button>
      </div></>}
      </>}

      {m.diff > m.tol && <div className="card stack" style={{ gap: 6, background: '#ecfdf5' }}>
        <div className="row spread"><strong>↩ {L('أرجِع للزبون', 'Give back')}</strong>
          <strong dir="ltr" style={{ fontSize: 20 }}>{changeIn === 'usd' ? usdFmt(m.changeUsd) : lbpFmt(m.changeLbp, ar)}</strong></div>
        <div className="row" style={{ gap: 6 }}>
          <button type="button" style={chip(changeIn === 'usd')} onClick={() => setChangeIn('usd')}>{L('بالدولار', 'In dollars')} <span dir="ltr">{usdFmt(m.diff)}</span></button>
          <button type="button" style={chip(changeIn === 'lbp')} onClick={() => setChangeIn('lbp')}>{L('بالليرة', 'In lira')} <span dir="ltr">{down(toLbp(m.diff)).toLocaleString('en-US')}</span></button>
        </div>
      </div>}

      {m.hasCash && m.missing > 0 && !nothing && <div className="card stack" style={{ gap: 6, background: '#fff8e6' }}>
        <div className="row spread"><strong>{L('الباقي غير مدفوع', 'Still missing')}</strong><strong dir="ltr">{usdFmt(m.missing)} <small className="muted">· {lbpFmt(up(toLbp(m.missing)), ar)}</small></strong></div>
      </div>}
      {m.hasCash && m.missing > 0 && (canDebt
        ? <label className="row" style={{ gap: 8, alignItems: 'center', opacity: m.debtOk ? 1 : .6 }}>
            <input type="checkbox" checked={asDebt && m.debtOk} disabled={!m.debtOk} onChange={e => setAsDebt(e.target.checked)} style={{ width: 22, height: 22 }} />
            <span>📒 {nothing ? L('الزبون لم يدفع — سجّل المبلغ ديناً عليه', 'The customer did not pay — record it as his debt') : L('سجّل الباقي ديناً على الزبون', 'Record the rest as the customer\'s debt')} <strong dir="ltr">{usdFmt(m.missing)}</strong></span>
          </label>
        : <small className="muted">{L('لا رقم للزبون على الطلب — لا يمكن تسجيل دين. اتصل بالمحل.', 'No customer number on the order — a debt cannot be recorded. Call the shop.')}</small>)}
      {m.hasCash && m.missing > 0 && canDebt && !m.debtOk && <small className="bad">{L('يتجاوز حدّ الدين المسموح لهذا الزبون', 'Over this customer\'s credit limit')} ({usdFmt(m.debtRoom ?? 0)} {L('متاح', 'left')}) — {L('اتصل بالمحل.', 'call the shop.')}</small>}

      <button className="btn big primary" type="submit" disabled={!m.covered || busy} style={{ minHeight: 64, fontSize: 19 }}>
        {busy ? '…' : m.covered ? `🏠 ${L('سلّمت الطلب — تأكيد الدفع', 'Delivered — confirm payment')}` : mode === 'debt' ? L('لا يمكن تسجيل الدين — اتصل بالمحل', 'The debt cannot be recorded — call the shop') : L('أدخل المبلغ المستلم', 'Enter what you received')}
      </button>
      {/* who holds the money, said before he confirms */}
      <small className="muted">{holds
        ? L('عند التأكيد يُقفل الطلب عند المحل، ويُسجَّل النقد معك حتى تسلّمه. المحل يستطيع تصحيح المبلغ إن لزم.', 'Confirming closes the order at the shop and records the cash as with you until you hand it over. The shop can correct the amount if needed.')
        : L('عند التأكيد يُقفل الطلب عند المحل. لا نقد معك عن هذا الطلب، وأجرة التوصيل تبقى لك عند المحل حتى المحاسبة.', 'Confirming closes the order at the shop. You hold no cash for this order; your delivery pay stays owed to you by the shop until you settle.')}</small>
    </form>
  );
}
