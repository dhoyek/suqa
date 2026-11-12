'use client';
import { useEffect, useRef, useState } from 'react';
import { verifyApproval, type ApprovalPin, type Staff } from '@suqa/pos-core';
import { freshApproval, getApproval, onApprovalChange } from '../lib/approval';
import { pt, type L } from '../i18n';
import Modal from './Modal';

/**
 * Approval gate. Owners pass automatically; everyone else types the shop's APPROVAL PIN (schema 55) — or, while the shop has none,
 * an owner's login PIN as before. Checked locally against the hashes on the device, so it works offline.
 * Resolves with an owner's user id (stamped on the op as approved_by) or null when dismissed.
 */
export default function OwnerPin({ open, locale, staff, me, reason, onDone }: { open: boolean; locale: L; staff: Staff[]; me: Staff; reason: string; onDone: (approvedBy: string | null) => void }) {
  const [pin, setPin] = useState(''); const [err, setErr] = useState(false);
  useEffect(() => { if (open && me.role === 'owner') onDone(me.user_id); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const [approval, setApproval] = useState<ApprovalPin>(() => getApproval());
  const fresh = useRef<Promise<ApprovalPin> | null>(null);
  useEffect(() => onApprovalChange(() => setApproval(getApproval())), []);
  // re-read it when the prompt opens (another device may have just changed it); the check below waits for this, briefly
  useEffect(() => { if (open && me.role !== 'owner') fresh.current = freshApproval(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (pin.length !== 4) return;
    let on = true;
    void (async () => {
      const a = await (fresh.current ?? Promise.resolve(getApproval()));
      const id = await verifyApproval(pin, staff, a);
      if (!on) return;
      if (id) { setPin(''); onDone(id); } else { setErr(true); setPin(''); }
    })();
    return () => { on = false; };
  }, [pin]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (/^\d$/.test(e.key)) { setErr(false); setPin(p => (p + e.key).slice(0, 4)); } else if (e.key === 'Backspace') setPin(p => p.slice(0, -1)); };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [open]);
  if (!open || me.role === 'owner') return null;
  return (
    <Modal open={open} onClose={() => { setPin(''); onDone(null); }} title={pt(approval ? 'approvalPin' : 'ownerPin', locale)}>
      <p className="muted">{pt(approval ? 'approvalPinHint' : 'ownerPinHint', locale)} — {reason}</p>
      <div className="pin-dots">{[0, 1, 2, 3].map(i => <span key={i} className={`dot ${pin.length > i ? 'on' : ''}`} />)}</div>
      {err && <p className="bad">{pt('wrongPin', locale)}</p>}
      <div className="pinpad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(d => <button key={d} onClick={() => { setErr(false); setPin(p => (p + d).slice(0, 4)); }}>{d}</button>)}
        <button className="muted" onClick={() => setPin('')}>C</button><button onClick={() => setPin(p => (p + '0').slice(0, 4))}>0</button><button className="muted" onClick={() => setPin(p => p.slice(0, -1))}>⌫</button>
      </div>
    </Modal>
  );
}
