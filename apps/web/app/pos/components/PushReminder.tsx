'use client';
import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { pt, type L } from '../i18n';
import { pushEnable, pushState, type PushState } from '../lib/push';

// A reminder on the sale and orders screens for the shop's own staff whose device does not get a notification for new online
// orders yet (Dan, 24 Nov 2026: on prod nobody had turned the 🔔 on — it sits in Settings, where nobody looks).
// One tap turns it on; "later" hides it on this device for three days. Never shown to an association admin setting a shop up
// (the notification carries the order's total, which is the shop's own business), nor when the browser cannot do it.
const LATER_MS = 3 * 24 * 3600 * 1000;
export default function PushReminder({ sb, shopId, locale, label, online }: { sb: SupabaseClient; shopId: string; locale: L; label: string; online: boolean }) {
  const key = `suqa-pos-push-later-${shopId}`;
  const [state, setState] = useState<PushState | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    let later = 0; try { later = Number(localStorage.getItem(key) ?? 0); } catch { /* private mode */ }
    setHidden(Date.now() - later < LATER_MS);
    void pushState().then(setState).catch(() => setState(null));
  }, [key]);
  if (hidden || !online || (state !== 'off' && state !== 'ios_home')) return null;
  const later = () => { try { localStorage.setItem(key, String(Date.now())); } catch { /* private mode */ } setHidden(true); };
  const turnOn = async () => {
    setBusy(true); setErr(null);
    try {
      const s = await pushEnable(sb, shopId, label); setState(s);
      if (s !== 'on') setErr(pt(s === 'blocked' ? 'pushBlocked' : s === 'not_set_up' ? 'pushNotSetUp' : 'pushDeclined', locale));
    } catch (e) { setErr(/not_shop_staff/.test((e as Error).message) ? pt('pushStaffOnly', locale) : (e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="pos-pushbar" role="status">
      <span style={{ flex: 1, minWidth: 180 }}>🔔 {state === 'ios_home' ? pt('pushIosHome', locale) : pt('pushRemind', locale)}{err && <span className="bad" style={{ display: 'block', fontSize: 13 }}>{err}</span>}</span>
      {state === 'off' && <button className="btn primary" disabled={busy} onClick={() => void turnOn()}>{busy ? '…' : pt('pushTurnOn', locale)}</button>}
      <button className="btn ghost" disabled={busy} onClick={later}>{pt('pushLater', locale)}</button>
    </div>
  );
}
