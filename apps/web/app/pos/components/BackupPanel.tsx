'use client';
import { useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { pt, type L } from '../i18n';
import { fmtTime, type Booted } from '../lib/boot';
import { buildBackup, saveBlob } from '@/lib/shop-backup';

const key = (shop: string) => `suqa-pos-last-backup-${shop}`;
const WEEK = 7 * 24 * 3600 * 1000;

/** Settings → backup (owner only): downloads everything the shop holds as one file. Restoring is done by the association's admin. */
export default function BackupPanel({ boot, sb, locale, online }: { boot: Booted; sb: SupabaseClient; locale: L; online: boolean }) {
  const [last, setLast] = useState<string | null>(() => { try { return localStorage.getItem(key(boot.shop.id)); } catch { return null; } });
  const [busy, setBusy] = useState(false); const [pct, setPct] = useState(0); const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const stale = !last || Date.now() - new Date(last).getTime() > WEEK;
  const run = async () => {
    setBusy(true); setMsg(null); setPct(0);
    try {
      const b = await buildBackup(sb, boot.shop.id, p => setPct(p.total ? Math.round(p.done / p.total * 100) : 0));
      saveBlob(b.blob, b.name);
      try { localStorage.setItem(key(boot.shop.id), b.at); } catch { /* private mode */ }
      setLast(b.at); setMsg({ ok: true, text: `${pt('backupDone', locale)} — ${b.name} (${b.rows.toLocaleString('en-US')} ${pt('backupRows', locale)}, ${(b.blob.size / 1024 / 1024).toFixed(1)} MB)` });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    setBusy(false);
  };
  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>💾 {pt('backupTitle', locale)}</h3>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>{pt('backupDesc', locale)}</p>
      <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className={`pill ${stale ? 'warn' : 'ok'}`}>{last ? `${pt('backupLast', locale)} ${fmtTime(last, locale)}` : pt('backupNever', locale)}</span>
        <span style={{ flex: 1 }} />
        <button className="btn primary" disabled={!online || busy} onClick={run}>{busy ? `${pct}%` : pt('backupBtn', locale)}</button>
      </div>
      {stale && last && <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>⚠ {pt('backupStale', locale)}</p>}
      {!online && <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>{pt('needOnline', locale)}</p>}
      {msg && <p className={msg.ok ? 'muted' : 'bad'} style={{ marginBottom: 0 }}>{msg.ok ? '✓ ' : ''}{msg.text}</p>}
    </section>
  );
}
