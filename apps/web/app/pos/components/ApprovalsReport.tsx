'use client';
import { useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fmtLbp, fmtUsd, num, text, type CatalogIndex, type Staff } from '@suqa/pos-core';
import { pt, type L, type Key } from '../i18n';
import type { Booted } from '../lib/boot';
import { fmtTime } from '../lib/boot';

type Row = { id: number; at: string; user_id: string | null; action: string; ref_id: string | null; after: Record<string, unknown> | null };
type Item = { key: string; at: string; who: string | null; by: string; action: string; detail: string };

/**
 * Reports → approvals: every action that needed an approval in the period — who was at the till, what it was, who approved.
 * Read from the audit log (owner, online). "Approved for staff" hides what an owner did under their own tile.
 */
export default function ApprovalsReport({ boot, sb, locale, index, from, to }: { boot: Booted; sb: SupabaseClient; locale: L; index: CatalogIndex; from: string; to: string }) {
  const [rows, setRows] = useState<Row[] | null>(null); const [err, setErr] = useState<string | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]); const [all, setAll] = useState(false); const [who, setWho] = useState('');
  useEffect(() => { boot.db.staff.toArray().then(setStaff); }, [boot]);
  useEffect(() => {
    let on = true; setRows(null); setErr(null);
    const start = new Date(`${from}T00:00:00`).toISOString(); const end = new Date(new Date(`${to}T00:00:00`).getTime() + 86400000).toISOString();
    const base = () => sb.from('audit_log').select('id, at, user_id, action, ref_id, after').eq('shop_id', boot.shop.id).gte('at', start).lt('at', end).order('at', { ascending: false }).limit(500);
    // two lookups: an approval on the operation itself, and one on a single line of a sale (changed price / line discount)
    Promise.all([base().not('after->>approved_by', 'is', null), base().eq('action', 'sale.commit').like('after->>lines', '%"approved_by": "%')]).then(([a, b]) => {
      if (!on) return;
      if (a.error || b.error) { setErr((a.error ?? b.error)!.message); setRows([]); return; }
      const m = new Map<number, Row>(); for (const r of [...((a.data as Row[]) ?? []), ...((b.data as Row[]) ?? [])]) m.set(r.id, r);
      setRows([...m.values()].sort((x, y) => y.at.localeCompare(x.at)));
    });
    return () => { on = false; };
  }, [sb, boot, from, to]);

  const nameOf = (id: string | null) => { const s = staff.find(x => x.user_id === id); return s?.display_name || s?.full_name || (id ? id.slice(0, 8) : '—'); };
  const actionLabel = (a: string) => { const k = `a_${a.replace('.', '_')}` as Key; const t = pt(k, locale); return !t || t === k ? a : t; };
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const r of rows ?? []) {
      const a = r.after ?? {}; const top = (a.approved_by as string | null) ?? null;
      const usd = (k: string) => fmtUsd(num(a[k] as number));
      if (top) {
        let detail = '';
        if (r.action === 'sale.commit') detail = `${a.local_number ?? ''} · ${pt('discount', locale)} ${usd('discount_cents')}${a.discount_reason ? ` (${a.discount_reason})` : ''} · ${pt('total', locale)} ${usd('total_cents')}`;
        else if (r.action === 'return.commit') detail = `${num(a.refund_lbp as number) ? fmtLbp(num(a.refund_lbp as number), locale) : usd('refund_usd_cents')}${a.reason ? ` · ${a.reason}` : ''}`;
        else if (r.action === 'stock.move') { const p = index.byId.get(String(a.product_id ?? '')); detail = `${p ? text(p.name, locale) : ''} · ${a.kind ?? ''} ${a.qty ?? ''}${a.note ? ` · ${a.note}` : ''}`; }
        else if (r.action === 'product.patch') { const p = index.byId.get(String(a.id ?? r.ref_id ?? '')); detail = `${p ? text(p.name, locale) : ''} · ${Object.keys((a.fields as Record<string, unknown>) ?? {}).join(', ')}`; }
        else if (r.action === 'purchase.commit') detail = `${a.invoice_no ?? ''} · ${usd('total_cents')}`;
        else detail = String(a.reason ?? a.note ?? '');
        out.push({ key: `${r.id}`, at: r.at, who: r.user_id, by: top, action: actionLabel(r.action), detail });
      }
      if (r.action === 'sale.commit') for (const l of ((a.lines as Record<string, unknown>[]) ?? [])) {
        if (!l.approved_by) continue;
        const p = l.product_id ? index.byId.get(String(l.product_id)) : undefined; const list = p ? Math.round(num(p.price_usd) * 100) : null;
        const price = l.price_currency === 'lbp' ? fmtLbp(num(l.unit_price_lbp as number), locale) : fmtUsd(num(l.unit_price_cents as number));
        out.push({ key: `${r.id}:${l.id}`, at: r.at, who: r.user_id, by: String(l.approved_by), action: num(l.discount_cents as number) ? pt('discount', locale) : pt('price', locale),
          detail: `${a.local_number ?? ''} · ${text(l.name as never, locale)} × ${l.qty} · ${price}${list != null && l.price_currency !== 'lbp' && list !== num(l.unit_price_cents as number) ? ` (${pt('currentPrice', locale)} ${fmtUsd(list)})` : ''}${num(l.discount_cents as number) ? ` · −${fmtUsd(num(l.discount_cents as number))}` : ''}` });
      }
    }
    return out;
  }, [rows, index, locale]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = items.filter(i => (all || i.who !== i.by) && (!who || i.who === who));
  const byWho = useMemo(() => { const m = new Map<string, number>(); for (const i of items) if (all || i.who !== i.by) m.set(i.who ?? '', (m.get(i.who ?? '') ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]); }, [items, all]);

  if (rows == null) return <p className="muted">…</p>;
  return (
    <div className="stack" style={{ gap: 10 }}>
      {err && <p className="bad">{err}</p>}
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className={`chip ${!who ? 'active' : ''}`} onClick={() => setWho('')}>{pt('all', locale)} · {byWho.reduce((s, x) => s + x[1], 0)}</button>
        {byWho.map(([id, n]) => <button key={id} className={`chip ${who === id ? 'active' : ''}`} onClick={() => setWho(who === id ? '' : id)}>{nameOf(id || null)} · {n}</button>)}
        <span style={{ flex: 1 }} />
        <label className="row" style={{ gap: 6, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> {pt('approvalsIncludeOwner', locale)}</label>
      </div>
      <table className="table"><tbody>
        <tr><th style={{ textAlign: 'start' }}>{pt('when', locale)}</th><th style={{ textAlign: 'start' }}>{pt('atTill', locale)}</th><th style={{ textAlign: 'start' }}>{pt('what', locale)}</th><th style={{ textAlign: 'start' }}>{pt('details', locale)}</th><th style={{ textAlign: 'start' }}>{pt('approvedBy', locale)}</th></tr>
        {shown.map(i => <tr key={i.key}><td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtTime(i.at, locale)}</td><td>{nameOf(i.who)}</td><td>{i.action}</td><td className="muted" style={{ fontSize: 13 }}>{i.detail}</td><td>{i.who === i.by ? '—' : nameOf(i.by)}</td></tr>)}
        {!shown.length && <tr><td className="muted" colSpan={5}>{pt('approvalsNone', locale)}</td></tr>}
      </tbody></table>
      {rows.length >= 500 && <p className="muted" style={{ fontSize: 12 }}>{pt('approvalsCapped', locale)}</p>}
    </div>
  );
}
