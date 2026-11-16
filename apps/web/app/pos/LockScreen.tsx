'use client';
import { LS_SHOP, myMemberships } from './lib/boot';
import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { META, daysOffline, getMeta, setMeta, hashPin, isValidPin, offlineUnlockAllowed, verifyPin, type Staff, type SyncStatus } from '@suqa/pos-core';
import { pt, type L } from './i18n';
import type { Booted } from './lib/boot';

/**
 * Lock screen: staff tiles + numeric PIN pad. Verification is local (hash synced from the server), so it works offline for
 * shop.offline_days. A user without a PIN sets one here (needs internet: pos_set_pin). The signed-in account is pre-selected.
 */
export default function LockScreen({ boot, sb, locale, status, onUnlock }: { boot: Booted; sb: SupabaseClient; locale: L; status: SyncStatus | null; onUnlock: (s: Staff) => void }) {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [who, setWho] = useState<Staff | null>(null);
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);   // non-null while setting a new PIN (2nd entry)
  const [err, setErr] = useState<string | null>(null);
  const [lastOnline, setLastOnline] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // the same account can work in several shops (a cashier with two jobs, an owner with two businesses): offer the switch.
  // Remembered on the device so the button is also there offline.
  const [multi, setMulti] = useState(() => { try { return localStorage.getItem('suqa-pos-multi') === '1'; } catch { return false; } });
  useEffect(() => {
    myMemberships(sb).then(ms => { const m = ms.some(x => x.shop_id !== boot.shop.id); setMulti(m); try { localStorage.setItem('suqa-pos-multi', m ? '1' : '0'); } catch { /* private mode */ } }).catch(() => {});
  }, [sb, boot.shop.id]);

  useEffect(() => {
    (async () => {
      let rows = (await boot.db.staff.toArray()).filter(s => s.active !== false);
      // an association admin who is not one of the shop's people (schema 71): one "setup" tile with its own PIN, kept on this
      // device (the shop's staff list is not sent to a setup device)
      if (boot.role === 'setup') {
        const p = await getMeta<{ hash: string; salt: string }>(boot.db, setupPinKey(boot.userId));
        rows = [{ user_id: boot.userId, shop_id: boot.shop.id, role: 'setup', display_name: pt('role_setup', locale), pin_hash: p?.hash ?? null, pin_salt: p?.salt ?? null, active: true }];
      }
      setStaff(rows);
      // pre-select the signed-in account only once; later status ticks must not undo a tap on another tile
      setWho(w => (w && rows.some(s => s.user_id === w.user_id) ? w : rows.find(s => s.user_id === boot.userId) ?? rows[0] ?? null));
      setLastOnline((await getMeta<string>(boot.db, META.lastOnlineAt)) ?? null);
    })();
  }, [boot, status?.lastOnlineAt]);

  const online = status?.online ?? navigator.onLine;
  const allowed = online || offlineUnlockAllowed(lastOnline, boot.shop.offline_days ?? 30);
  const days = daysOffline(lastOnline);
  const settingPin = !!who && !who.pin_hash;

  const press = (d: string) => { if (pin.length < 4) { setErr(null); setPin(p => p + d); } };
  const clear = () => { setPin(''); setErr(null); };

  useEffect(() => {
    if (pin.length !== 4 || !who || busy) return;
    (async () => {
      setBusy(true);
      try {
        if (settingPin) {
          if (!online && who.role !== 'setup') { setErr(pt('pinNeedsOnline', locale)); setPin(''); return; }
          if (confirm === null) { setConfirm(pin); setPin(''); return; }
          if (confirm !== pin) { setErr(pt('pinMismatch', locale)); setConfirm(null); setPin(''); return; }
          if (who.user_id !== boot.userId && boot.role !== 'owner') { setErr(pt('pinNeedsOnline', locale)); setPin(''); return; }
          const { hash, salt } = await hashPin(pin);
          if (who.role === 'setup') {
            await setMeta(boot.db, setupPinKey(boot.userId), { hash, salt });
            setConfirm(null); setPin(''); onUnlock({ ...who, pin_hash: hash, pin_salt: salt }); return;
          }
          const { error } = await sb.rpc('pos_set_pin', { p_shop: boot.shop.id, p_user: who.user_id, p_hash: hash, p_salt: salt });
          if (error) { setErr(error.message); setPin(''); setConfirm(null); return; }
          const updated = { ...who, pin_hash: hash, pin_salt: salt };
          await boot.db.staff.put(updated);
          setConfirm(null); setPin('');
          onUnlock(updated);
          return;
        }
        if (!allowed) { setErr(pt('offlineTooLong', locale)); setPin(''); return; }
        const ok = await verifyPin(pin, who.pin_hash!, who.pin_salt!);
        if (!ok) { setErr(pt('wrongPin', locale)); setPin(''); return; }
        setPin(''); onUnlock(who);
      } finally { setBusy(false); }
    })();
  }, [pin]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (/^\d$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') setPin(p => p.slice(0, -1)); else if (e.key === 'Escape') clear(); };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [pin]); // eslint-disable-line react-hooks/exhaustive-deps

  const name = (s: Staff) => s.display_name || s.full_name || s.user_id.slice(0, 8);
  const roleLabel = (s: Staff) => pt((`role_${s.role}` as 'role_owner'), locale);

  return (
    <main className="pos-lock">
      <div className="pos-lock-card">
        <div className="row spread" style={{ alignItems: 'center' }}>
          <div className="brand">{boot.shop.name?.[locale] ?? boot.shop.name?.ar}</div>
          <span className={`pill ${online ? 'ok' : 'warn'}`}>{online ? pt('online', locale) : pt('offline', locale)}{!online && days !== Infinity ? ` · ${days} ${pt('daysOffline', locale)}` : ''}</span>
        </div>
        <h2 style={{ margin: '12px 0 8px' }}>{pt('whoIsThis', locale)}</h2>
        {staff.length === 0 && <div className="stack" style={{ gap: 8, padding: '10px 12px', border: '1px dashed #d97706', borderRadius: 10, background: '#fffbeb' }}>
          <b>{pt('noStaffTitle', locale)}</b>
          <span className="muted" style={{ fontSize: 14 }}>{pt('noStaffHint', locale)}</span>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <a className="btn" href={`/admin/shops/${boot.shop.id}`}>👥 {pt('noStaffAdd', locale)}</a>
            <button className="btn ghost" onClick={async () => {
              // only leave this shop when there is another one with the POS switched on; otherwise say so
              const others = (await myMemberships(sb).catch(() => [])).filter(m => m.shop_id !== boot.shop.id);
              if (!others.length) { setErr(pt('noOtherShop', locale)); return; }
              localStorage.removeItem(LS_SHOP); window.location.reload();
            }}>🏪 {pt('otherShop', locale)}</button>
          </div>
        </div>}
        {boot.role === 'setup' && <p className="muted" style={{ fontSize: 13, margin: '0 0 8px' }}>🛠️ {pt('setupHint', locale)}</p>}
        <div className="staff-tiles">
          {staff.map(s => <button key={s.user_id} className={`tile ${who?.user_id === s.user_id ? 'active' : ''}`} onClick={() => { setWho(s); clear(); setConfirm(null); }}>
            <div className="tile-name">{name(s)}</div><div className="muted" style={{ fontSize: 12 }}>{roleLabel(s)}{!s.pin_hash ? ' · ' + pt('setPin', locale).split(' ')[0] : ''}</div>
          </button>)}
        </div>
        <p className="muted" style={{ margin: '14px 0 6px', minHeight: 20 }}>
          {!who ? '' : settingPin ? (confirm === null ? pt('setPin', locale) : pt('confirmPin', locale)) : pt('enterPin', locale)}
        </p>
        <div className="pin-dots">{[0, 1, 2, 3].map(i => <span key={i} className={`dot ${pin.length > i ? 'on' : ''}`} />)}</div>
        {err && <p className="bad" style={{ margin: '6px 0' }}>{err}</p>}
        {!allowed && !settingPin && <p className="bad">{pt('offlineTooLong', locale)}</p>}
        <div className="pinpad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(d => <button key={d} onClick={() => press(d)} disabled={!who || busy}>{d}</button>)}
          <button onClick={clear} className="muted">C</button>
          <button onClick={() => press('0')} disabled={!who || busy}>0</button>
          <button onClick={() => setPin(p => p.slice(0, -1))} className="muted">⌫</button>
        </div>
        <div className="row spread" style={{ marginTop: 14 }}>
          <span className="row" style={{ gap: 4 }}>
            {boot.role === 'setup'
              ? <a className="btn ghost muted" href={`/admin/shops/${boot.shop.id}`}>{pt('adminArea', locale)}</a>
              : <a className="btn ghost muted" href="/shop">{pt('backToShop', locale)}</a>}
            {multi && <button className="btn ghost muted" onClick={() => { localStorage.removeItem(LS_SHOP); window.location.reload(); }}>🏪 {pt('otherShop', locale)}</button>}
          </span>
          <span className="muted" style={{ fontSize: 12 }}>{pt('lastSync', locale)}: {status?.lastSyncAt ? new Date(status.lastSyncAt).toLocaleTimeString(locale === 'ar' ? 'ar-LB-u-nu-latn' : 'en-GB', { hour: '2-digit', minute: '2-digit' }) : pt('never', locale)}</span>
        </div>
      </div>
    </main>
  );
}
export const pinOk = isValidPin;
const setupPinKey = (userId: string) => `setup_pin_${userId}`;
