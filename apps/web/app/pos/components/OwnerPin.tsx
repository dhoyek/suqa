'use client';
import { useEffect, useRef, useState } from 'react';
import { verifyApproval, type ApprovalPin, type Staff } from '@suqa/pos-core';
import { freshApproval, getApproval, onApprovalChange } from '../lib/approval';
import { pt, type L } from '../i18n';
import Modal from './Modal';

const FAILS_KEY = 'suqa-pos-approval-fails', MAX_FAILS = 5, LOCK_MS = 60_000;
type Fails = { n: number; until: number };
function readFails(): Fails { try { const f = JSON.parse(localStorage.getItem(FAILS_KEY) || 'null') as Fails | null; if (f && typeof f.n === 'number') return { n: f.n, until: Number(f.until) || 0 }; } catch {} return { n: 0, until: 0 }; }
function writeFails(f: Fails) { try { localStorage.setItem(FAILS_KEY, JSON.stringify(f)); } catch {} }
function clearFails() { writeFails({ n: 0, until: 0 }); }
/** Counts a wrong PIN; returns the time the lock ends when this one triggered it. */
function addFail(): number | null { const f = readFails(); const n = f.n + 1; if (n >= MAX_FAILS) { const until = Date.now() + LOCK_MS; writeFails({ n: 0, until }); return until; } writeFails({ n, until: 0 }); return null; }

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
      if (id) { setPin(''); clearFails(); onDone(id); } else { setErr(true); setPin(''); const u = addFail(); if (u) setLockedUntil(u); }
    })();
    return () => { on = false; };
  }, [pin]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (/^\d$/.test(e.key)) { if (lockRef.current) return; setErr(false); setPin(p => (p + e.key).slice(0, 4)); } else if (e.key === 'Backspace') setPin(p => p.slice(0, -1)); };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [open]);
  // guessing guard: 5 wrong PINs lock approvals on this device for a minute (kept across reloads)
  const [lockedUntil, setLockedUntil] = useState<number>(() => readFails().until);
  const [now, setNow] = useState(() => Date.now());
  const locked = lockedUntil > now; const lockRef = useRef(locked); lockRef.current = locked;
  useEffect(() => { if (open) { setLockedUntil(readFails().until); setNow(Date.now()); } }, [open]);
  useEffect(() => { if (!open || !locked) return; const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, [open, locked]);
  const press = (d: string) => { if (lockRef.current) return; setErr(false); setPin(p => (p + d).slice(0, 4)); };
  if (!open || me.role === 'owner') return null;
  return (
    <Modal open={open} onClose={() => { setPin(''); onDone(null); }} title={pt(approval ? 'approvalPin' : 'ownerPin', locale)}>
      <p className="muted">{pt(approval ? 'approvalPinHint' : 'ownerPinHint', locale)} — {reason}</p>
      <div className="pin-dots">{[0, 1, 2, 3].map(i => <span key={i} className={`dot ${pin.length > i ? 'on' : ''}`} />)}</div>
      {locked ? <p className="bad">🔒 {pt('approvalLocked', locale)} {Math.ceil((lockedUntil - now) / 1000)}s</p> : err && <p className="bad">{pt('wrongPin', locale)}{readFails().n > 0 ? ` · ${MAX_FAILS - readFails().n} ${pt('triesLeft', locale)}` : ''}</p>}
      <div className="pinpad" style={locked ? { opacity: .4, pointerEvents: 'none' } : undefined}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(d => <button key={d} onClick={() => press(d)}>{d}</button>)}
        <button className="muted" onClick={() => setPin('')}>C</button><button onClick={() => press('0')}>0</button><button className="muted" onClick={() => setPin(p => p.slice(0, -1))}>⌫</button>
      </div>
    </Modal>
  );
}
