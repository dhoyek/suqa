'use client';
import { useEffect, useState } from 'react';
import { setShopRate, type Rate } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import { fmtTime, type Booted } from '../lib/boot';
import { useConfirm } from '@/components/ConfirmProvider';

/**
 * Settings → exchange rate (owner). The till's own rate: lira per dollar, used for every lira figure on this shop's screens,
 * receipts and change. Saving adds a dated rate — sales already made keep the rate they were made at. Works offline and reaches
 * the shop's other devices on sync. (Online orders use the market's rate, set by the market's admin.)
 */
export default function RatePanel({ boot, locale }: { boot: Booted; locale: L }) {
  const confirm = useConfirm();
  const [cur, setCur] = useState<Rate | null>(null); const [v, setV] = useState(''); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false);
  const load = () => boot.db.rates.orderBy('effective_at').reverse().first().then((r: Rate | undefined) => { setCur(r ?? null); setV(String(r?.lbp_per_usd ?? 89500)); });
  useEffect(() => { void load(); }, [boot]); // eslint-disable-line react-hooks/exhaustive-deps
  const now = cur?.lbp_per_usd ?? 89500; const n = Math.round(Number(v) || 0);
  const ok = n >= 1000 && n <= 10_000_000 && n !== now;
  const save = async () => {
    if (!ok || busy) return;
    if (!(await confirm(`${pt('rateConfirm', locale)}\n$1 = ${now.toLocaleString('en-US')} → ${n.toLocaleString('en-US')} ${locale === 'ar' ? 'ل.ل.' : 'LBP'}`))) return;
    setBusy(true);
    try { await setShopRate(boot.db, boot.shop.id, n); boot.engine.poke(); await load(); setDone(true); setTimeout(() => setDone(false), 4000); } finally { setBusy(false); }
  };
  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>💱 {pt('rate', locale)}</h3>
      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>{pt('rateHint', locale)}</div>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span dir="ltr" style={{ fontWeight: 700 }}>$1 =</span>
        <input className="input" dir="ltr" inputMode="numeric" style={{ maxWidth: 160, fontSize: 18 }} value={v} onChange={e => setV(e.target.value.replace(/[^0-9]/g, ''))} onKeyDown={e => { if (e.key === 'Enter') void save(); }} aria-label={pt('rate', locale)} />
        <span>{locale === 'ar' ? 'ل.ل.' : 'LBP'}</span>
        <button className="btn primary" disabled={!ok || busy} onClick={save}>{pt('save', locale)}</button>
        {done && <span className="pill ok">✓ {pt('rateSaved', locale)}</span>}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{cur ? `${pt('rateSince', locale)} ${fmtTime(cur.effective_at, locale)}` : pt('rateDefault', locale)}</div>
    </section>
  );
}
