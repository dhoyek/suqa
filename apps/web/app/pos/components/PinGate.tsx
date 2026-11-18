'use client';
import { useEffect, useRef, useState } from 'react';
import { verifyPin, type Staff } from '@suqa/pos-core';
import { pt, type L } from '../i18n';

const FAILS_KEY = 'suqa-pos-gate-fails', MAX_FAILS = 5, LOCK_MS = 60_000;
type Fails = { n: number; until: number };
function readFails(): Fails { try { const f = JSON.parse(localStorage.getItem(FAILS_KEY) || 'null') as Fails | null; if (f && typeof f.n === 'number') return { n: f.n, until: Number(f.until) || 0 }; } catch {} return { n: 0, until: 0 }; }
function writeFails(f: Fails) { try { localStorage.setItem(FAILS_KEY, JSON.stringify(f)); } catch {} }

/**
 * A sensitive screen (الدين) asks the person who is signed in for their OWN PIN again before it shows anything — a till left
 * unlocked must not let a passer-by read who owes what. Checked on the device against the hash it already holds (works offline).
 * Five wrong tries lock it for a minute. Rendered in place of the screen; `onOk` when the PIN matches.
 */
export default function PinGate({ locale, me, title, onOk, onCancel }: { locale: L; me: Staff; title: string; onOk: () => void; onCancel: () => void }) {
  const [pin, setPin] = useState(''); const [err, setErr] = useState(false);
  const [lockedUntil, setLockedUntil] = useState<number>(() => readFails().until); const [now, setNow] = useState(() => Date.now());
  const locked = lockedUntil > now; const lockRef = useRef(locked); lockRef.current = locked;
  useEffect(() => { if (!locked) return; const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, [locked]);
  useEffect(() => {
    if (pin.length !== 4) return;
    let on = true;
    void (async () => {
      const ok = !!me.pin_hash && !!me.pin_salt && await verifyPin(pin, me.pin_hash, me.pin_salt);
      if (!on) return;
      if (ok) { writeFails({ n: 0, until: 0 }); setPin(''); onOk(); return; }
      setErr(true); setPin('');
      const n = readFails().n + 1;
      if (n >= MAX_FAILS) { const until = Date.now() + LOCK_MS; writeFails({ n: 0, until }); setLockedUntil(until); setNow(Date.now()); } else writeFails({ n, until: 0 });
    })();
    return () => { on = false; };
  }, [pin]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // capture + stop, so the digits never reach the barcode scanner or a field behind
    const h = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) { e.preventDefault(); e.stopPropagation(); if (lockRef.current) return; setErr(false); setPin(p => (p + e.key).slice(0, 4)); }
      else if (e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); setPin(p => p.slice(0, -1)); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', h, true); return () => window.removeEventListener('keydown', h, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const press = (d: string) => { if (lockRef.current) return; setErr(false); setPin(p => (p + d).slice(0, 4)); };
  return (
    <div className="stack" style={{ maxWidth: 340, margin: '24px auto', padding: 16, textAlign: 'center' }}>
      <h3 style={{ margin: 0 }}>🔒 {title}</h3>
      <p className="muted" style={{ margin: 0 }}>{pt('pinGateHint', locale)} — {me.display_name || me.full_name || ''}</p>
      <div className="pin-dots">{[0, 1, 2, 3].map(i => <span key={i} className={`dot ${pin.length > i ? 'on' : ''}`} />)}</div>
      {locked ? <p className="bad">🔒 {pt('approvalLocked', locale)} {Math.ceil((lockedUntil - now) / 1000)}s</p> : err && <p className="bad">{pt('wrongPin', locale)}</p>}
      <div className="pinpad" style={locked ? { opacity: .4, pointerEvents: 'none' } : undefined}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(d => <button key={d} onClick={() => press(d)}>{d}</button>)}
        <button className="muted" onClick={() => setPin('')}>C</button><button onClick={() => press('0')}>0</button><button className="muted" onClick={() => setPin(p => p.slice(0, -1))}>⌫</button>
      </div>
      <button className="btn ghost" onClick={onCancel}>{pt('back', locale)}</button>
    </div>
  );
}
