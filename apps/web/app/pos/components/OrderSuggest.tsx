'use client';
import { useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { num, text, waDigits, type Localized, type Supplier } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';

type Row = { id: string; name: Localized; unit: string | null; on_hand: number | string | null; reserved: number | string | null; min_stock: number | string | null; sold: number | string; free: number | string; suggest: number | string; supplier_id: string | null; supplier: string | null };

/**
 * Stock → "what should I order?" (125): read from the server (owner / stock keeper, online) because a till only holds its own recent
 * sales. Per item: what sold in the last N days, scaled to the days to cover, never under the item's minimum, less what is free on
 * the shelf. Grouped by the item's usual supplier. The person edits quantities or drops lines, then sends the list to the supplier
 * on WhatsApp or opens a purchase invoice with it. Nothing is ordered, saved or counted by this screen. No cost is shown.
 */
export default function OrderSuggest({ boot, sb, locale, online, suppliers, onReorder }: { boot: Booted; sb: SupabaseClient; locale: L; online: boolean; suppliers: Supplier[]; onReorder?: (supplierId: string | null, items: { id: string; qty: number }[]) => void }) {
  const [days, setDays] = useState('14'); const [cover, setCover] = useState('7');
  const [rows, setRows] = useState<Row[] | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({}); const [off, setOff] = useState<Set<string>>(new Set()); const [used, setUsed] = useState<{ days: number; cover: number } | null>(null);
  const load = async () => {
    if (busy) return; setBusy(true); setErr(null);
    const { data, error } = await sb.rpc('pos_order_suggest', { p_shop: boot.shop.id, p_days: Math.round(Number(days)) || 14, p_cover: Math.round(Number(cover)) || 7 });
    setBusy(false);
    if (error) { setErr(/PGRST202|schema cache|pos_order_suggest/i.test(error.message) ? pt('osOff', locale) : error.message); return; }
    const r = data as { days: number; cover: number; rows: Row[] } | null;
    setRows(r?.rows ?? []); setQty({}); setOff(new Set()); setUsed({ days: num(r?.days) || 14, cover: num(r?.cover) || 7 });
  };
  const q = (r: Row) => { const v = qty[r.id]; const n = v === undefined ? num(r.suggest) : Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
  const groups = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of rows ?? []) { if (off.has(r.id)) continue; const k = r.supplier_id ?? ''; m.set(k, [...(m.get(k) ?? []), r]); }
    return [...m.entries()].map(([id, items]) => ({ id: id || null, name: items[0].supplier, phone: suppliers.find(s => s.id === id)?.phone ?? null, items }))
      .sort((a, b) => (a.id ? 0 : 1) - (b.id ? 0 : 1) || (a.name ?? '').localeCompare(b.name ?? ''));
  }, [rows, off, suppliers]);
  const listText = (g: { name: string | null; items: Row[] }) => [`${pt('reorderRequest', locale)} — ${text(boot.shop.name, locale)}${g.name ? ` → ${g.name}` : ''} — ${new Date().toLocaleDateString('en-GB')}`,
    ...g.items.filter(r => q(r) > 0).map(r => `• ${text(r.name, locale)} × ${q(r)}${r.unit ? ' ' + r.unit : ''}`)].join('\n');
  const wa = (g: { name: string | null; phone: string | null; items: Row[] }) => window.open(`https://wa.me/${g.phone ? waDigits(g.phone) : ''}?text=${encodeURIComponent(listText(g))}`, '_blank');
  const shown = (rows ?? []).filter(r => !off.has(r.id)).length;

  return (
    <section className="card order-suggest">
      <div className="row spread" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <strong>✨ {pt('osTitle', locale)}{rows ? ` (${shown})` : ''}</strong>
        <span className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="muted" style={{ fontSize: 13 }}>{pt('osDays', locale)} <input className="input os-num" inputMode="numeric" value={days} onChange={e => setDays(e.target.value.replace(/\D/g, '').slice(0, 2))} /></label>
          <label className="muted" style={{ fontSize: 13 }}>{pt('osCover', locale)} <input className="input os-num" inputMode="numeric" value={cover} onChange={e => setCover(e.target.value.replace(/\D/g, '').slice(0, 2))} /></label>
          <button className="btn primary" disabled={!online || busy} onClick={load}>{busy ? '…' : rows ? pt('osAgain', locale) : pt('osGo', locale)}</button>
        </span>
      </div>
      {!rows && !err && <p className="muted" style={{ margin: '6px 0 0', fontSize: 13 }}>{online ? pt('osHint', locale) : pt('osOffline', locale)}</p>}
      {err && <p className="bad" style={{ margin: '6px 0 0' }}>{err}</p>}
      {rows && !rows.length && <p className="muted" style={{ margin: '6px 0 0' }}>{pt('osNone', locale)}</p>}
      {rows && !!rows.length && used && <p className="muted" style={{ margin: '6px 0 0', fontSize: 12 }}>{pt('osBasis', locale).replace('{d}', String(used.days)).replace('{c}', String(used.cover))}</p>}
      {groups.map(g => <div key={g.id ?? 'none'} className="reorder-group">
        <div className="row spread" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
          <strong>🚚 {g.name ?? pt('noSupplier', locale)} <span className="muted" style={{ fontWeight: 400 }}>· {g.items.length}</span></strong>
          <span className="row" style={{ gap: 6 }}>
            <button className="btn" onClick={() => wa(g)}>💬 {pt('askSupplier', locale)}</button>
            {onReorder && <button className="btn primary" onClick={() => onReorder(g.id, g.items.filter(r => q(r) > 0).map(r => ({ id: r.id, qty: q(r) })))}>🧾 {pt('newPurchase', locale)}</button>}
          </span>
        </div>
        <div className="os-scroll"><table className="table os-table"><thead><tr><th>{pt('item', locale)}</th><th className="num">{pt('osSold', locale)}</th><th className="num">{pt('available', locale)}</th><th className="num">{pt('osOrder', locale)}</th><th /></tr></thead><tbody>
          {g.items.map(r => <tr key={r.id}>
            <td>{text(r.name, locale)}{num(r.min_stock) > 0 && <span className="muted" style={{ fontSize: 12 }}> · {pt('minStock', locale)} {num(r.min_stock)}</span>}</td>
            <td className="num muted">{num(r.sold)}</td>
            <td className={`num ${num(r.free) <= 0 ? 'bad' : ''}`}>{num(r.free)}{r.unit ? ' ' + r.unit : ''}</td>
            <td className="num"><input className="input os-num" inputMode="decimal" value={qty[r.id] ?? String(num(r.suggest))} onChange={e => setQty(x => ({ ...x, [r.id]: e.target.value.replace(/[^\d.]/g, '').slice(0, 7) }))} /></td>
            <td><button className="btn icon" title={pt('osDrop', locale)} onClick={() => setOff(s => new Set(s).add(r.id))}>✕</button></td>
          </tr>)}
        </tbody></table></div>
      </div>)}
    </section>
  );
}
