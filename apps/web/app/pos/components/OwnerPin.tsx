'use client';
import { useEffect, useState } from 'react';
import { verifyOwnerPin, type Staff } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import Modal from './Modal';

/**
 * Owner approval gate. Owners pass automatically; everyone else types an owner's PIN (verified locally against the synced hashes).
 * Resolves with the approving owner's user id (stamped on the op as approved_by) or null when dismissed.
 */
export default function OwnerPin({ open, locale, staff, me, reason, onDone }: { open: boolean; locale: L; staff: Staff[]; me: Staff; reason: string; onDone: (approvedBy: string | null) => void }) {
  const [pin, setPin] = useState(''); const [err, setErr] = useState(false);
  useEffect(() => { if (open && me.role === 'owner') onDone(me.user_id); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (pin.length !== 4) return;
    verifyOwnerPin(pin, staff).then(id => { if (id) { setPin(''); onDone(id); } else { setErr(true); setPin(''); } });
  }, [pin]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (/^\d$/.test(e.key)) { setErr(false); setPin(p => (p + e.key).slice(0, 4)); } else if (e.key === 'Backspace') setPin(p => p.slice(0, -1)); };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [open]);
  if (!open || me.role === 'owner') return null;
  return (
    <Modal open={open} onClose={() => { setPin(''); onDone(null); }} title={pt('ownerPin', locale)}>
      <p className="muted">{pt('ownerPinHint', locale)} — {reason}</p>
      <div className="pin-dots">{[0, 1, 2, 3].map(i => <span key={i} className={`dot ${pin.length > i ? 'on' : ''}`} />)}</div>
      {err && <p className="bad">{pt('wrongPin', locale)}</p>}
      <div className="pinpad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(d => <button key={d} onClick={() => { setErr(false); setPin(p => (p + d).slice(0, 4)); }}>{d}</button>)}
        <button className="muted" onClick={() => setPin('')}>C</button><button onClick={() => setPin(p => (p + '0').slice(0, 4))}>0</button><button className="muted" onClick={() => setPin(p => p.slice(0, -1))}>⌫</button>
      </div>
    </Modal>
  );
}
