'use client';
import { useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CatalogIndex } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import Modal from './Modal';

/** Owner, online: ±% on sell prices per section (or all) and online visibility per section (or all). Devices get the changes through the feed. */
export default function BulkDialog({ boot, sb, locale, index, onDone, onClose }: { boot: Booted; sb: SupabaseClient; locale: L; index: CatalogIndex; onDone: () => void; onClose: () => void }) {
  const ar = locale === 'ar';
  const [section, setSection] = useState(''); const [pct, setPct] = useState(''); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const sections = [...index.categories.keys()];
  const count = section ? index.byCategory(section, 10000).length : index.size;
  const call = async (fn: string, args: Record<string, unknown>) => {
    setBusy(true); setMsg(null);
    const { data, error } = await sb.rpc(fn, args);
    setBusy(false); setMsg(error ? error.message : `${data} ${ar ? 'صنف' : 'items'} ✓`); if (!error) { boot.engine.poke(); onDone(); }
  };
  return (
    <Modal open onClose={onClose} title={ar ? 'تعديل جماعي' : 'Bulk changes'}>
      <label className="label">{pt('category', locale)}<select className="input" value={section} onChange={e => setSection(e.target.value)}><option value="">{pt('all', locale)} ({index.size})</option>{sections.map(s => <option key={s} value={s}>{s}</option>)}</select></label>
      <div className="card" style={{ marginTop: 10 }}>
        <strong>{ar ? 'تغيير الأسعار بالنسبة المئوية' : 'Change prices by %'}</strong>
        <div className="row" style={{ gap: 8, marginTop: 6 }}><input className="input" dir="ltr" inputMode="decimal" placeholder="+10 / -5" value={pct} onChange={e => setPct(e.target.value)} /><button className="btn primary" disabled={busy || !Number(pct)} onClick={() => { if (confirm(`${Number(pct) > 0 ? '+' : ''}${pct}% → ${count} ${ar ? 'صنف' : 'items'}?`)) void call('pos_bulk_price', { p_shop: boot.shop.id, p_section: section || null, p_pct: Number(pct), p_lbp_step: boot.shop.lbp_rounding_step ?? 1000 }); }}>{pt('ok', locale)}</button></div>
        <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>{ar ? 'أسعار الدولار تُقرَّب إلى السنت، وأسعار الليرة إلى خطوة التقريب.' : 'USD prices round to the cent, LBP prices to the rounding step.'}</p>
      </div>
      <div className="card" style={{ marginTop: 10 }}>
        <strong>{pt('visibleOnline', locale)}</strong>
        <div className="row" style={{ gap: 8, marginTop: 6 }}>
          <button className="btn" disabled={busy} onClick={() => call('pos_bulk_visibility', { p_shop: boot.shop.id, p_section: section || null, p_visible: true })}>👁 {ar ? 'إظهار الكل' : 'Show all'} ({count})</button>
          <button className="btn" disabled={busy} onClick={() => call('pos_bulk_visibility', { p_shop: boot.shop.id, p_section: section || null, p_visible: false })}>🚫 {ar ? 'إخفاء الكل' : 'Hide all'} ({count})</button>
        </div>
      </div>
      {msg && <p className={/✓/.test(msg) ? 'muted' : 'bad'}>{msg}</p>}
    </Modal>
  );
}
