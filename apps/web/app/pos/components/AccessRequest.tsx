'use client';
import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { text } from '@suqa/pos-core';
import { pt, type L } from '../i18n';

type Target = { id: string; name: Record<string, string>; pending: boolean; rejected_at: string | null };

/** Signed-in user with no POS membership: explain, let them ask a shop owner for access, show the pending state. */
export default function AccessRequest({ sb, locale, brand, tenantId, onRetry }: { sb: SupabaseClient; locale: L; brand: string; tenantId: string; onRetry: () => void }) {
  const [targets, setTargets] = useState<Target[] | null>(null); const [shop, setShop] = useState<string>('');
  const [name, setName] = useState(''); const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    const { data, error } = await sb.rpc('pos_request_targets', { p_tenant: tenantId });
    if (error) { setErr(error.message); setTargets([]); return; }
    const t = (data as Target[]) ?? []; setTargets(t); if (t.length === 1) setShop(t[0].id);
    const { data: u } = await sb.auth.getUser(); setName(n => n || (u.user?.user_metadata?.full_name as string) || '');
  }, [sb, tenantId]);
  useEffect(() => { void load(); }, [load]);

  const send = async () => {
    if (!shop || busy) return; setBusy(true); setErr(null); setMsg(null);
    try {
      const { data, error } = await sb.rpc('pos_request_access', { p_shop: shop, p_name: name.trim() || null, p_note: note.trim() || null });
      if (error) throw error;
      const row = data as { id: string };
      try { await fetch('/api/pos/access-request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: row.id }) }); } catch { /* owner still sees it in the POS */ }
      setMsg(pt('accessSent', locale)); await load();
    } catch (e) { const m = (e as Error).message; setErr(/already_member/.test(m) ? pt('accessAlready', locale) : m); }
    finally { setBusy(false); }
  };
  const pending = targets?.filter(t => t.pending) ?? [];
  return (
    <main className="pos-center"><div className="card stack" style={{ maxWidth: 440, width: '100%' }}>
      <div className="brand" style={{ textAlign: 'center' }}>{brand}</div>
      <h2 style={{ margin: 0, textAlign: 'center' }}>{pt('noAccessTitle', locale)}</h2>
      <p className="muted" style={{ margin: 0, textAlign: 'center' }}>{pt('noAccessBody', locale)}</p>
      {pending.length > 0 && <div className="card" style={{ background: '#fff8e6' }}>⏳ {pt('accessPending', locale)}: <strong>{pending.map(t => text(t.name, locale)).join('، ')}</strong></div>}
      {targets === null ? <p className="muted">{pt('loading', locale)}</p> : targets.length === 0 ? <p className="bad">{pt('noShop', locale)}</p> : (
        <>
          {targets.length > 1 && <label className="label">{pt('shop', locale)}
            <select className="input" value={shop} onChange={e => setShop(e.target.value)}>
              <option value="">—</option>
              {targets.map(t => <option key={t.id} value={t.id}>{text(t.name, locale)}{t.pending ? ' ⏳' : ''}</option>)}
            </select></label>}
          <label className="label">{pt('yourName', locale)}<input className="input" value={name} onChange={e => setName(e.target.value)} /></label>
          <label className="label">{pt('accessNote', locale)}<input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder={pt('accessNoteHint', locale)} /></label>
          {err && <div className="bad">{err}</div>}
          {msg && <div className="ok">{msg}</div>}
          <button className="btn primary big" disabled={busy || !shop || !name.trim()} onClick={send}>{targets.find(t => t.id === shop)?.pending ? pt('accessResend', locale) : pt('accessAsk', locale)}</button>
        </>
      )}
      <div className="row" style={{ justifyContent: 'center', gap: 8 }}>
        <button className="btn ghost" onClick={onRetry}>{pt('retry', locale)}</button>
        <a className="btn ghost" href="/">{pt('backHome', locale)}</a>
        <form action="/auth/signout" method="post"><button className="btn ghost" type="submit">{pt('signOut', locale)}</button></form>
      </div>
    </div></main>
  );
}
