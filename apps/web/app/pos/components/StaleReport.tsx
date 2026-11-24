'use client';
import { useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { num, patchProduct, text, type Localized } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import { downloadCsv } from '../lib/export';
import Modal from './Modal';

type Row = { id: string; name: Localized; section: string | null; sku: string | null; created_at: string; last_sold_at: string | null; track_stock: boolean; on_hand: number | string | null; visible_online: boolean; is_available: boolean; listed_empty: boolean };
type Show = 'all' | 'empty' | 'never' | 'stock' | 'online';

/**
 * Reports → stale items (108): the shop's active items with no sale for `shops.stale_days` (60 unless the owner set another) — read
 * from the server (owner / stock, online), because a till only holds its own recent sales. Listed online with no stock comes first:
 * most likely no longer in the shop. Two things can be done to the ticked items, both through the usual item edit (so they sync and
 * are undone from the item editor): hide them from the site, or stop selling them (inactive — history stays). Nothing is deleted here.
 */
export default function StaleReport({ boot, sb, locale }: { boot: Booted; sb: SupabaseClient; locale: L }) {
  const [rows, setRows] = useState<Row[] | null>(null); const [days, setDays] = useState<number>(boot.shop.stale_days ?? 60); const [err, setErr] = useState<string | null>(null);
  const [show, setShow] = useState<Show>('all'); const [cat, setCat] = useState<string>('*'); const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set()); const [ask, setAsk] = useState<null | 'hide' | 'stop'>(null); const [busy, setBusy] = useState(false);
  useEffect(() => {
    let on = true; setRows(null); setErr(null);
    void sb.rpc('pos_report_stale', { p_shop: boot.shop.id }).then(({ data, error }) => {
      if (!on) return;
      if (error) { setErr(error.message); setRows([]); return; }
      const r = data as { days: number; rows: Row[] } | null; setDays(num(r?.days) || 60); setRows(r?.rows ?? []);
    });
    return () => { on = false; };
  }, [boot, sb]);
  const cats = useMemo(() => [...new Set((rows ?? []).map(r => r.section || ''))].sort((a, b) => a.localeCompare(b)), [rows]);
  const online = (r: Row) => r.visible_online && r.is_available;
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (rows ?? []).filter(r => (show === 'all' || (show === 'empty' ? r.listed_empty : show === 'never' ? !r.last_sold_at : show === 'stock' ? r.track_stock && num(r.on_hand) > 0 : online(r)))
      && (cat === '*' || (r.section || '') === cat)
      && (!needle || `${r.name?.ar ?? ''} ${r.name?.en ?? ''} ${r.sku ?? ''}`.toLowerCase().includes(needle)));
  }, [rows, show, cat, q]);
  const count = (s: Show) => (rows ?? []).filter(r => (s === 'all' ? true : s === 'empty' ? r.listed_empty : s === 'never' ? !r.last_sold_at : s === 'stock' ? r.track_stock && num(r.on_hand) > 0 : online(r))).length;
  const ago = (iso: string) => Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  const day = (iso: string) => new Date(iso).toLocaleDateString(locale === 'ar' ? 'ar-LB' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const picked = shown.filter(r => sel.has(r.id)); const allOn = !!shown.length && picked.length === shown.length;
  const toggle = (id: string) => setSel(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const apply = async (what: 'hide' | 'stop') => {
    setBusy(true); setErr(null);
    try {
      const done = new Set<string>(); let missing = 0;
      for (const r of picked) {
        const p = await boot.db.products.get(r.id);
        if (!p) { missing++; continue; }                          // not on this till yet: left as it is, and said
        await patchProduct(boot.db, p, { fields: what === 'hide' ? { visible_online: false } : { is_active: false } });
        done.add(r.id);
      }
      boot.engine.poke();
      setRows(rs => (rs ?? []).flatMap(r => !done.has(r.id) ? [r] : what === 'stop' ? [] : [{ ...r, visible_online: false, listed_empty: false }]));
      setSel(new Set()); setAsk(null);
      if (missing) setErr(pt('staleMissing', locale).replace('{n}', String(missing)));
    } finally { setBusy(false); }
  };
  if (!rows) return <p className="muted">…</p>;
  return (
    <>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>ⓘ {pt('staleHow', locale).replace('{n}', String(days))}</p>
      {err && <p className="bad">{err}</p>}
      <div className="seg wrap">{(['all', 'empty', 'never', 'stock', 'online'] as Show[]).map(s => <button key={s} className={show === s ? 'active' : ''} onClick={() => setShow(s)}>{pt(`stale_${s}` as 'stale_all', locale)} · {count(s)}</button>)}</div>
      <div className="row" style={{ gap: 8, margin: '8px 0', flexWrap: 'wrap' }}>
        <input className="input" style={{ flex: 1, minWidth: 160 }} placeholder={pt('findItem', locale)} value={q} onChange={e => setQ(e.target.value)} />
        {cats.length > 1 && <select className="input" style={{ width: 'auto', maxWidth: 200 }} value={cat} onChange={e => setCat(e.target.value)}><option value="*">{pt('all', locale)}</option>{cats.map(c => <option key={c} value={c}>{c || '—'}</option>)}</select>}
        <button className="btn ghost" disabled={!shown.length} onClick={() => downloadCsv(pt('staleTab', locale), shown.map(r => ({ [pt('items', locale)]: text(r.name, locale), [pt('category', locale)]: r.section ?? '', [pt('staleLast', locale)]: r.last_sold_at ? r.last_sold_at.slice(0, 10) : pt('staleNever', locale), [pt('onHand', locale)]: r.track_stock ? num(r.on_hand) : '', [pt('onlineShop', locale)]: online(r) ? '✓' : '' })))}>CSV</button>
      </div>
      {!!picked.length && <div className="row" style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <strong>{picked.length}</strong>
        <button className="btn" onClick={() => setAsk('hide')}>🚫 {pt('staleHide', locale)}</button>
        <button className="btn danger" onClick={() => setAsk('stop')}>⏹ {pt('staleStop', locale)}</button>
      </div>}
      {!shown.length ? <p className="muted">—</p> : <table className="table"><tbody>
        <tr><th style={{ width: 28 }}><input type="checkbox" checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(shown.map(r => r.id)))} /></th><th style={{ textAlign: 'start' }}>{pt('items', locale)}</th><th>{pt('staleLast', locale)}</th><th>{pt('onHand', locale)}</th></tr>
        {shown.slice(0, 500).map(r => <tr key={r.id} onClick={() => toggle(r.id)} style={{ cursor: 'pointer' }}>
          <td><input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} onClick={e => e.stopPropagation()} /></td>
          <td>{text(r.name, locale)}<div className="muted" style={{ fontSize: 12 }}>{r.section || '—'}{online(r) ? <> · 🌐 {pt('onlineShop', locale)}</> : null}{r.listed_empty ? <span className="bad"> · {pt('staleListedEmpty', locale)}</span> : null}</div></td>
          <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>{r.last_sold_at ? <>{day(r.last_sold_at)}<div className="muted" style={{ fontSize: 12 }}>{pt('staleDaysAgo', locale).replace('{n}', String(ago(r.last_sold_at)))}</div></> : <>{pt('staleNever', locale)}<div className="muted" style={{ fontSize: 12 }}>{pt('staleAdded', locale).replace('{n}', String(ago(r.created_at)))}</div></>}</td>
          <td style={{ textAlign: 'center' }} dir="ltr">{r.track_stock ? num(r.on_hand) : '—'}</td>
        </tr>)}
      </tbody></table>}
      {shown.length > 500 && <p className="muted" style={{ fontSize: 12 }}>ⓘ {pt('salesFirstRows', locale).replace('{n}', '500')}</p>}
      {ask && <Modal open onClose={() => setAsk(null)} title={`${pt(ask === 'hide' ? 'staleHide' : 'staleStop', locale)} · ${picked.length}`}
        footer={<><button className="btn ghost" onClick={() => setAsk(null)}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} /><button className={`btn ${ask === 'stop' ? 'danger' : 'primary'}`} disabled={busy} onClick={() => void apply(ask)}>{pt('ok', locale)}</button></>}>
        <p>{pt(ask === 'hide' ? 'staleHideHow' : 'staleStopHow', locale)}</p>
        <p className="muted" style={{ fontSize: 13 }}>{picked.slice(0, 8).map(r => text(r.name, locale)).join(' · ')}{picked.length > 8 ? ' …' : ''}</p>
      </Modal>}
    </>
  );
}
