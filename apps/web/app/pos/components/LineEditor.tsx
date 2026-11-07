'use client';
import { useEffect, useState } from 'react';
import { fmtBoth, lineTotalCents, lbpToCents, text, type DraftLine, type Staff } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import Modal, { NumPad } from './Modal';
import OwnerPin from './OwnerPin';

type Field = 'qty' | 'price' | 'discount';

/**
 * Edit one cart line: quantity (decimals for weighed items), unit price override, line discount, note, void.
 * Price override / discount above shop.max_discount_pct needs the owner PIN (cashiers); the approving owner is stamped on the line.
 */
export default function LineEditor({ line, locale, rate, maxDiscountPct, staff, me, initialField = 'qty', onChange, onVoid, onClose }: {
  line: DraftLine; locale: L; rate: number; maxDiscountPct: number; staff: Staff[]; me: Staff; initialField?: Field;
  onChange: (l: DraftLine) => void; onVoid: (reason: string) => void; onClose: () => void;
}) {
  const [field, setField] = useState<Field>(initialField);
  const [qty, setQty] = useState(String(line.quantity));
  const [price, setPrice] = useState(line.price_currency === 'usd' ? (line.unit_price_cents / 100).toString() : String(line.unit_price_lbp));
  const [disc, setDisc] = useState(line.discount_cents ? (line.discount_cents / 100).toString() : '');
  const [note, setNote] = useState(line.notes ?? '');
  const [gate, setGate] = useState<null | (() => void)>(null);
  const [voiding, setVoiding] = useState(false); const [voidReason, setVoidReason] = useState('');

  const q = Math.max(0, Number(qty) || 0);
  const unitCents = line.price_currency === 'usd' ? Math.round((Number(price) || 0) * 100) : line.unit_price_cents;
  const unitLbp = line.price_currency === 'lbp' ? Math.round(Number(price) || 0) : line.unit_price_lbp;
  const discCents = Math.round((Number(disc) || 0) * 100);
  const gross = lineTotalCents({ price_currency: line.price_currency, unit_price_cents: unitCents, unit_price_lbp: unitLbp, quantity: q }, rate);
  const discPct = gross ? (discCents / gross) * 100 : 0;
  const priceChanged = unitCents !== line.unit_price_cents || unitLbp !== line.unit_price_lbp;
  const needsOwner = me.role !== 'owner' && (priceChanged || discPct > maxDiscountPct);

  const apply = (approvedBy?: string) => {
    onChange({ ...line, quantity: line.product_id && !isDecimalOk(line) ? Math.round(q) : q, unit_price_cents: unitCents, unit_price_lbp: unitLbp, discount_cents: Math.min(discCents, gross), notes: note || null, approved_by: approvedBy ?? line.approved_by });
    onClose();
  };
  const save = () => { if (q <= 0) return; if (needsOwner && !line.approved_by) setGate(() => () => apply()); else apply(); };
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Enter' && !voiding) { e.preventDefault(); save(); } }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }); // eslint-disable-line react-hooks/exhaustive-deps

  const val = field === 'qty' ? qty : field === 'price' ? price : disc;
  const set = field === 'qty' ? setQty : field === 'price' ? setPrice : setDisc;

  return (
    <>
      <Modal open onClose={onClose} title={text(line.name, locale)} wide
        footer={<>
          <button className="btn danger" onClick={() => setVoiding(true)}>{pt('voidLine', locale)}</button>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button>
          <button className="btn primary" onClick={save} disabled={q <= 0}>{pt('ok', locale)}</button>
        </>}>
        <div className="line-editor">
          <div className="stack">
            {(['qty', 'price', 'discount'] as Field[]).map(f => (
              <button key={f} type="button" className={`field ${field === f ? 'active' : ''}`} onClick={() => setField(f)}>
                <span className="muted">{pt(f === 'qty' ? 'qty' : f === 'price' ? 'price' : 'lineDiscount', locale)}{f === 'price' ? ` (${line.price_currency === 'usd' ? '$' : 'ل.ل.'})` : f === 'discount' ? ' ($)' : line.unit ? ` (${line.unit})` : ''}</span>
                <strong>{f === 'qty' ? qty || '0' : f === 'price' ? price || '0' : disc || '0'}</strong>
              </button>
            ))}
            <label className="label">{pt('note', locale)}</label>
            <input className="input" value={note} onChange={e => setNote(e.target.value)} />
            <div className="muted" style={{ fontSize: 13 }}>
              {pt('total', locale)}: <strong>{fmtBoth(Math.max(0, gross - discCents), rate, locale)}</strong>
              {discPct > 0 && ` · ${discPct.toFixed(1)}%`}{needsOwner && !line.approved_by && <span className="bad"> · {pt('ownerPin', locale)}</span>}
            </div>
          </div>
          <NumPad value={val} onChange={set} decimal={field !== 'qty' || isDecimalOk(line)} big />
        </div>
      </Modal>
      {gate && <OwnerPin open locale={locale} staff={staff} me={me} reason={priceChanged ? pt('price', locale) : pt('discount', locale)} onDone={id => { const g = gate; setGate(null); if (id) { apply(id); } }} />}
      {voiding && (
        <Modal open onClose={() => setVoiding(false)} title={pt('voidLine', locale)}
          footer={<><button className="btn ghost" onClick={() => setVoiding(false)}>{pt('cancel', locale)}</button><button className="btn danger" onClick={() => { onVoid(voidReason); onClose(); }}>{pt('voidLine', locale)}</button></>}>
          <label className="label">{pt('cancelReason', locale)}</label>
          <input className="input" value={voidReason} onChange={e => setVoidReason(e.target.value)} autoFocus />
        </Modal>
      )}
    </>
  );
}
const isDecimalOk = (l: DraftLine) => !!l.decimal_qty || !l.product_id;
export const lbpCents = lbpToCents;
