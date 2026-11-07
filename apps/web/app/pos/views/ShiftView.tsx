'use client';
import { useEffect, useState } from 'react';
import { cashMove, closeShift, currentShift, fmtLbp, fmtUsd, num, openShift, shiftSummary, type Currency, type Shift, type ShiftSummary, type Staff } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import { fmtTime } from '../lib/boot';
import { doPrint, loadPrintSettings, zReportHtml } from '../lib/print';
import Modal, { NumPad } from '../components/Modal';

/** Shift per device: open with a float, cash in/out with reason, close with a count per currency; Z report printable any time. */
export default function ShiftView({ boot, locale, staff, tick }: { boot: Booted; locale: L; staff: Staff; tick: number }) {
  const [shift, setShift] = useState<Shift | null>(null);
  const [sum, setSum] = useState<ShiftSummary | null>(null);
  const [past, setPast] = useState<Shift[]>([]);
  const [members, setMembers] = useState<Staff[]>([]);
  const [dialog, setDialog] = useState<null | 'open' | 'in' | 'out' | 'close'>(null);
  const reload = async () => {
    const s = await currentShift(boot.db); setShift(s); setSum(s ? await shiftSummary(boot.db, s) : null);
    setPast((await boot.db.shifts.where('device_id').equals(boot.deviceId).reverse().sortBy('opened_at')).filter(x => x.closed_at).slice(0, 10));
    setMembers(await boot.db.staff.toArray());
  };
  useEffect(() => { void reload(); }, [boot, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = (id?: string | null) => { const m = members.find(x => x.user_id === id); return m?.display_name || m?.full_name || ''; };
  const printZ = async (s: Shift) => { const z = await shiftSummary(boot.db, s); doPrint(zReportHtml(z, boot.shop, locale, loadPrintSettings(), { opened: name(s.opened_by), closed: name(s.closed_by) })); };

  return (
    <div className="stack" style={{ padding: 16, maxWidth: 760 }}>
      {!shift ? (
        <section className="card stack">
          <h3 style={{ margin: 0 }}>{pt('noShift', locale)}</h3>
          <button className="btn primary big" onClick={() => setDialog('open')}>{pt('openShift', locale)}</button>
        </section>
      ) : sum && (
        <>
          <section className="card">
            <div className="row spread" style={{ alignItems: 'center' }}>
              <div><strong>{pt('shiftOpenSince', locale)} {fmtTime(shift.opened_at, locale)}</strong><div className="muted">{pt('openedBy', locale)}: {name(shift.opened_by)}</div></div>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn" onClick={() => setDialog('in')}>＋ {pt('cashIn', locale)}</button>
                <button className="btn" onClick={() => setDialog('out')}>− {pt('cashOut', locale)}</button>
                <button className="btn" onClick={() => printZ(shift)}>🖨 {pt('zReport', locale)}</button>
              </div>
            </div>
            <div className="kpis">
              <div className="kpi"><span>{pt('salesCount', locale)}</span><strong>{sum.sales_count}</strong></div>
              <div className="kpi"><span>{pt('total', locale)}</span><strong>{fmtUsd(sum.total_cents)}</strong><small>{fmtLbp(sum.total_lbp, locale)}</small></div>
              <div className="kpi"><span>{pt('expected', locale)} $</span><strong>{fmtUsd(sum.expected_usd_cents)}</strong><small>{pt('float', locale)} {fmtUsd(num(shift.float_usd_cents))}</small></div>
              <div className="kpi"><span>{pt('expected', locale)} ل.ل.</span><strong>{fmtLbp(sum.expected_lbp, locale)}</strong><small>{pt('float', locale)} {fmtLbp(num(shift.float_lbp), locale)}</small></div>
            </div>
            <table className="table" style={{ marginTop: 10 }}><tbody>
              {Object.entries(sum.by_tender).map(([t, v]) => <tr key={t}><td>{pt(t as 'cash_usd', locale)}</td><td className="muted">{v.count}</td><td className="num">{v.usd ? fmtUsd(v.usd) : ''} {v.lbp ? fmtLbp(v.lbp, locale) : ''}</td></tr>)}
              {sum.moves.map(m => <tr key={m.id}><td>{m.kind === 'in' ? '＋' : '−'} {m.reason}</td><td className="muted">{fmtTime(m.at, locale)}</td><td className="num">{m.currency === 'lbp' ? fmtLbp(num(m.amount), locale) : fmtUsd(num(m.amount))}</td></tr>)}
            </tbody></table>
            <button className="btn danger big" style={{ marginTop: 12 }} onClick={() => setDialog('close')}>{pt('closeShift', locale)}</button>
          </section>
        </>
      )}
      {!!past.length && (
        <section className="card">
          <h4 style={{ marginTop: 0 }}>{pt('pastShifts', locale)}</h4>
          <table className="table"><tbody>
            {past.map(s => <tr key={s.id}><td>{fmtTime(s.opened_at, locale)} → {fmtTime(s.closed_at, locale)}</td><td className="muted">{name(s.closed_by)}</td>
              <td className={`num ${num(s.diff_usd_cents) || num(s.diff_lbp) ? 'bad' : ''}`}>{pt('difference', locale)}: {fmtUsd(num(s.diff_usd_cents))} · {fmtLbp(num(s.diff_lbp), locale)}</td>
              <td><button className="btn" onClick={() => printZ(s)}>🖨</button></td></tr>)}
          </tbody></table>
        </section>
      )}

      {dialog === 'open' && <TwoCurrency locale={locale} title={pt('openShift', locale)} labels={[pt('float', locale) + ' $', pt('float', locale) + ' ل.ل.']}
        onDone={async (usd, lbp) => { await openShift(boot.db, { float_usd_cents: usd, float_lbp: lbp, opened_by: staff.user_id }); boot.engine.poke(); setDialog(null); await reload(); }} onClose={() => setDialog(null)} />}
      {(dialog === 'in' || dialog === 'out') && shift && <CashDialog locale={locale} kind={dialog}
        onDone={async (amount, currency, reason) => { await cashMove(boot.db, shift, { kind: dialog, amount, currency, reason, user_id: staff.user_id }); boot.engine.poke(); setDialog(null); await reload(); }} onClose={() => setDialog(null)} />}
      {dialog === 'close' && shift && sum && <TwoCurrency locale={locale} title={pt('closeShift', locale)} labels={[pt('counted', locale) + ' $', pt('counted', locale) + ' ل.ل.']} note
        hint={`${pt('expected', locale)}: ${fmtUsd(sum.expected_usd_cents)} · ${fmtLbp(sum.expected_lbp, locale)}`}
        onDone={async (usd, lbp, note) => { const c = await closeShift(boot.db, shift, { counted_usd_cents: usd, counted_lbp: lbp, closed_by: staff.user_id, note }); boot.engine.poke(); setDialog(null); await reload(); if (loadPrintSettings().autoPrint) void printZ(c); }} onClose={() => setDialog(null)} />}
    </div>
  );
}

/** Two amounts (USD then LBP) with one numpad; Enter moves to the next field / confirms. */
function TwoCurrency({ locale, title, labels, hint, note, onDone, onClose }: { locale: L; title: string; labels: [string, string]; hint?: string; note?: boolean; onDone: (usdCents: number, lbp: number, note?: string) => void; onClose: () => void }) {
  const [f, setF] = useState<0 | 1>(0); const [usd, setUsd] = useState(''); const [lbp, setLbp] = useState(''); const [n, setN] = useState('');
  const submit = () => onDone(Math.round((Number(usd) || 0) * 100), Math.round(Number(lbp) || 0), n.trim() || undefined);
  return (
    <Modal open onClose={onClose} title={title} footer={<><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} /><button className="btn primary" onClick={submit}>{pt('ok', locale)}</button></>}>
      {hint && <p className="muted">{hint}</p>}
      <div className="stack">
        {([0, 1] as const).map(i => <button key={i} type="button" className={`field ${f === i ? 'active' : ''}`} onClick={() => setF(i)} style={{ display: 'flex', justifyContent: 'space-between', border: `2px solid ${f === i ? 'var(--brand-primary)' : 'var(--line)'}`, borderRadius: 10, padding: '10px 12px', background: f === i ? '#eef6f8' : '#fff', font: 'inherit', fontSize: 16 }}>
          <span className="muted">{labels[i]}</span><strong style={{ fontSize: 20, direction: 'ltr' }}>{(i === 0 ? usd : lbp) || '0'}</strong></button>)}
        {note && <input className="input" placeholder={pt('note', locale)} value={n} onChange={e => setN(e.target.value)} />}
      </div>
      <NumPad value={f === 0 ? usd : lbp} onChange={f === 0 ? setUsd : setLbp} decimal={f === 0} onEnter={() => (f === 0 ? setF(1) : submit())} />
    </Modal>
  );
}

function CashDialog({ locale, kind, onDone, onClose }: { locale: L; kind: 'in' | 'out'; onDone: (amount: number, currency: Currency, reason: string) => void; onClose: () => void }) {
  const [cur, setCur] = useState<Currency>('usd'); const [v, setV] = useState(''); const [reason, setReason] = useState('');
  const submit = () => { const n = Number(v); if (!n || n <= 0) return; onDone(cur === 'usd' ? Math.round(n * 100) : Math.round(n), cur, reason.trim()); };
  return (
    <Modal open onClose={onClose} title={pt(kind === 'in' ? 'cashIn' : 'cashOut', locale)} footer={<><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} /><button className="btn primary" disabled={!Number(v)} onClick={submit}>{pt('ok', locale)}</button></>}>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <div className="seg"><button className={cur === 'usd' ? 'active' : ''} onClick={() => { setCur('usd'); setV(''); }}>$</button><button className={cur === 'lbp' ? 'active' : ''} onClick={() => { setCur('lbp'); setV(''); }}>ل.ل.</button></div>
        <strong style={{ marginInlineStart: 'auto', fontSize: 22, direction: 'ltr' }}>{v || '0'}</strong>
      </div>
      <input className="input" placeholder={pt('reason', locale)} value={reason} onChange={e => setReason(e.target.value)} style={{ marginTop: 8 }} />
      <NumPad value={v} onChange={setV} decimal={cur === 'usd'} onEnter={submit} />
    </Modal>
  );
}
