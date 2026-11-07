'use client';
import { useEffect, useMemo, useState } from 'react';
import { commitReturn, currentShift, fmtLbp, fmtUsd, num, roundLbp, text, usdToLbp, type Currency, type Order, type OrderLine, type Staff } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import Modal from './Modal';
import OwnerPin from './OwnerPin';

/** Full or partial return against a delivered order: pick quantities, stock or damaged, refund in $ or ل.ل. Owner approval (PIN for cashiers). */
export default function ReturnDialog({ boot, locale, order, lines, staff, onDone, onClose }: { boot: Booted; locale: L; order: Order; lines: OrderLine[]; staff: Staff; onDone: () => void; onClose: () => void }) {
  const live = lines.filter(l => !l.voided);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [dest, setDest] = useState<Record<string, 'stock' | 'damaged'>>({});
  const [cur, setCur] = useState<Currency>('usd'); const [reason, setReason] = useState(''); const [gate, setGate] = useState(false); const [members, setMembers] = useState<Staff[]>([]);
  useEffect(() => { boot.db.staff.toArray().then(setMembers); }, [boot]);
  const rate = num(order.rate_lbp_per_usd) || 89500; const step = boot.shop.lbp_rounding_step ?? 5000;
  const amount = useMemo(() => live.reduce((s, l) => s + Math.round((num(l.line_total_cents) / num(l.quantity)) * (qty[l.id] ?? 0)), 0), [live, qty]);
  const refundLbp = roundLbp(usdToLbp(amount, rate), step);
  const any = Object.values(qty).some(v => v > 0);
  const save = async (approvedBy: string | null) => {
    const shift = await currentShift(boot.db);
    await commitReturn(boot.db, order, live.filter(l => (qty[l.id] ?? 0) > 0).map(l => ({ order_item_id: l.id, product_id: l.product_id, qty: qty[l.id], destination: dest[l.id] ?? 'stock', amount_cents: Math.round((num(l.line_total_cents) / num(l.quantity)) * qty[l.id]) })),
      { refund_currency: cur, refund_usd_cents: cur === 'usd' ? amount : 0, refund_lbp: cur === 'lbp' ? refundLbp : 0, reason: reason.trim(), approved_by: approvedBy, user_id: staff.user_id, shift_id: shift?.id ?? null });
    boot.engine.poke(); onDone();
  };
  return (
    <>
      <Modal open onClose={onClose} title={`${pt('returnTitle', locale)} · ${order.number ?? order.local_number}`} wide
        footer={<><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} /><strong>{pt('refund', locale)}: {cur === 'usd' ? fmtUsd(amount) : fmtLbp(refundLbp, locale)}</strong><button className="btn danger" disabled={!any} onClick={() => (staff.role === 'owner' ? void save(staff.user_id) : setGate(true))}>{pt('returnTitle', locale)}</button></>}>
        <table className="table"><tbody>
          {live.map(l => <tr key={l.id}>
            <td>{text(l.name, locale)}<div className="muted" style={{ fontSize: 12 }}>{num(l.quantity)}{l.unit ? ' ' + l.unit : '×'} · {fmtUsd(num(l.line_total_cents))}</div></td>
            <td><div className="qty-btns"><button onClick={() => setQty(q => ({ ...q, [l.id]: Math.max(0, (q[l.id] ?? 0) - 1) }))}>−</button><span>{qty[l.id] ?? 0}</span><button onClick={() => setQty(q => ({ ...q, [l.id]: Math.min(num(l.quantity), (q[l.id] ?? 0) + 1) }))}>+</button></div></td>
            <td><div className="seg"><button className={(dest[l.id] ?? 'stock') === 'stock' ? 'active' : ''} onClick={() => setDest(d => ({ ...d, [l.id]: 'stock' }))}>{pt('toStock', locale)}</button><button className={dest[l.id] === 'damaged' ? 'active' : ''} onClick={() => setDest(d => ({ ...d, [l.id]: 'damaged' }))}>{pt('toDamaged', locale)}</button></div></td>
          </tr>)}
        </tbody></table>
        <div className="row" style={{ gap: 10, alignItems: 'center', marginTop: 10 }}>
          <span className="muted">{pt('refundIn', locale)}</span>
          <div className="seg"><button className={cur === 'usd' ? 'active' : ''} onClick={() => setCur('usd')}>$</button><button className={cur === 'lbp' ? 'active' : ''} onClick={() => setCur('lbp')}>ل.ل.</button></div>
          <input className="input" placeholder={pt('returnReason', locale)} value={reason} onChange={e => setReason(e.target.value)} style={{ flex: 1 }} />
        </div>
      </Modal>
      {gate && <OwnerPin open locale={locale} staff={members} me={staff} reason={pt('returnTitle', locale)} onDone={id => { setGate(false); if (id) void save(id); }} />}
    </>
  );
}
