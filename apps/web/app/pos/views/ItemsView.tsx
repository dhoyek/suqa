'use client';
import { useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fmtLbp, fmtUsd, num, text, type CatalogIndex, type Conflict, type Product, type QuickButton, type Staff } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import ItemEditor from '../components/ItemEditor';
import { CategoryChips, CategoryFilter } from '../components/CategoryFilter';
import { can, roleOf } from '../lib/perm';
import Modal from '../components/Modal';
import ImportDialog from '../components/ImportDialog';
import BulkDialog from '../components/BulkDialog';

/** Catalog: list + editor, quick buttons (owner, online), conflict review (owner). Bulk tools + import live in a separate dialog (M4-c). */
export default function ItemsView({ boot, sb, locale, index, tick, staff, reindex }: { boot: Booted; sb: SupabaseClient; locale: L; index: CatalogIndex; tick: number; staff: Staff; reindex: () => void }) {
  const [q, setQ] = useState(''); const [cat, setCat] = useState<Set<string>>(new Set()); const [showArchived, setShowArchived] = useState(false);
  const [edit, setEdit] = useState<{ p: Product | null } | null>(null);
  const [members, setMembers] = useState<Staff[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [archived, setArchived] = useState<Product[]>([]);
  const [quickOpen, setQuickOpen] = useState(false); const [importOpen, setImportOpen] = useState(false); const [bulkOpen, setBulkOpen] = useState(false);
  const role = roleOf(staff); const canEdit = can(role, 'items.edit'); const showCost = can(role, 'items.cost'); const tools = can(role, 'items.tools');
  useEffect(() => { boot.db.staff.toArray().then(setMembers); boot.db.conflicts.where('seen').equals(0 as never).toArray().catch(() => []).then(c => setConflicts(c.filter(x => !x.seen))); boot.db.products.filter(p => !p.is_active).toArray().then(setArchived); }, [boot, tick]);
  const list = useMemo(() => (showArchived ? archived.filter(p => !q || text(p.name, locale).includes(q)) : q.trim() ? index.search(q, 200, cat) : index.byCategory(cat, 500)), [q, cat, index, tick, showArchived, archived, locale]);
  const cats = useMemo(() => [...index.categories.values()].sort((a, b) => a.sort_order - b.sort_order), [index, tick]);

  return (
    <div className="stack" style={{ padding: 16 }}>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input className="input" style={{ flex: 1, minWidth: 220 }} placeholder={pt('searchItems', locale)} value={q} onChange={e => setQ(e.target.value)} />
        <CategoryFilter cats={cats} selected={cat} onChange={setCat} locale={locale} />
        {canEdit && <button className="btn primary" onClick={() => setEdit({ p: null })}>＋ {pt('newItem', locale)}</button>}
        {tools && <button className="btn" onClick={() => setQuickOpen(true)}>⚡ {pt('quickButtons', locale)}</button>}
        {tools && <button className="btn" onClick={() => setBulkOpen(true)}>％ {locale === 'ar' ? 'تعديل جماعي' : 'Bulk'}</button>}
        {tools && <button className="btn" onClick={() => setImportOpen(true)}>📥 {locale === 'ar' ? 'استيراد' : 'Import'}</button>}
        <label className="muted" style={{ fontSize: 13 }}><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> {pt('archived', locale)} ({archived.length})</label>
      </div>
      {!canEdit && <p className="muted" style={{ margin: 0 }}>{pt('readOnly', locale)}</p>}
      <CategoryChips cats={cats} selected={cat} onChange={setCat} locale={locale} />
      {!!conflicts.length && tools && (
        <section className="card" style={{ borderColor: '#fcd34d', background: '#fffbeb' }}>
          <strong>⚠ {pt('conflicts', locale)} ({conflicts.length})</strong><p className="muted" style={{ fontSize: 12 }}>{pt('conflictHint', locale)}</p>
          <table className="table"><tbody>{conflicts.slice(0, 20).map(c => <tr key={c.id}><td>{text(index.byId.get(c.row_id)?.name, locale) || c.row_id.slice(0, 8)}</td><td className="muted">{c.field}</td><td dir="ltr">{JSON.stringify(c.old_value)} → {JSON.stringify(c.new_value)}</td>
            <td><button className="btn" onClick={async () => { await boot.db.conflicts.update(c.id, { seen: true }); await sb.from('conflict_log').update({ seen: true }).eq('id', c.id); setConflicts(x => x.filter(y => y.id !== c.id)); }}>{pt('markSeen', locale)}</button></td></tr>)}</tbody></table>
        </section>
      )}
      <table className="table items-table"><tbody>
        {list.map(p => {
          const avail = num(p.on_hand) - num(p.reserved);
          return (
            <tr key={p.id} onClick={() => canEdit && setEdit({ p })} style={{ cursor: canEdit ? 'pointer' : 'default', opacity: p.is_active ? 1 : .6 }}>
              <td><strong>{text(p.name, locale)}</strong><div className="muted" style={{ fontSize: 12 }}>{p.sku ? <span dir="ltr">{p.sku} · </span> : ''}{index.barcodes(p.id).slice(0, 2).map(b => <span key={b} dir="ltr">{b} </span>)}{!p.visible_online && <span>· 🚫 {pt('visibleOnline', locale)}</span>}{!p.is_available && <span> · ⏸</span>}</div></td>
              <td className="num">{p.price_currency === 'lbp' ? fmtLbp(num(p.price_lbp), locale) : fmtUsd(Math.round(num(p.price_usd) * 100))}</td>
              <td className={`num ${p.track_stock && avail <= num(p.min_stock) ? 'bad' : 'muted'}`}>{p.track_stock ? `${avail}${p.unit ? ' ' + p.unit : ''}` : '—'}</td>
              {showCost && <td className="num muted">{p.cost_cents != null ? fmtUsd(p.cost_cents) : ''}</td>}
            </tr>
          );
        })}
        {!list.length && <tr><td className="muted">{pt('noResults', locale)}</td></tr>}
      </tbody></table>
      {edit && <ItemEditor boot={boot} locale={locale} index={index} product={edit.p} staff={members} me={staff} onDone={() => { setEdit(null); reindex(); }} onClose={() => setEdit(null)} />}
      {importOpen && <ImportDialog boot={boot} locale={locale} onDone={reindex} onClose={() => setImportOpen(false)} />}
      {bulkOpen && <BulkDialog boot={boot} sb={sb} locale={locale} index={index} onDone={reindex} onClose={() => setBulkOpen(false)} />}
      {quickOpen && <QuickButtonsEditor boot={boot} sb={sb} locale={locale} index={index} onClose={() => { setQuickOpen(false); boot.engine.poke(); }} />}
    </div>
  );
}

/** Quick buttons are shop config: owner edits them online (RLS allows); the feed brings them to every device. */
function QuickButtonsEditor({ boot, sb, locale, index, onClose }: { boot: Booted; sb: SupabaseClient; locale: L; index: CatalogIndex; onClose: () => void }) {
  const [rows, setRows] = useState<QuickButton[]>(index.quickButtons);
  const [q, setQ] = useState(''); const [err, setErr] = useState<string | null>(null);
  const online = boot.engine.status.online;
  const add = async (p: Product) => {
    const { data, error } = await sb.from('quick_buttons').insert({ shop_id: boot.shop.id, tenant_id: boot.shop.tenant_id, product_id: p.id, sort_order: rows.length }).select().single();
    if (error) { setErr(error.message); return; }
    setRows(r => [...r, data as QuickButton]); await boot.db.quickButtons.put(data as QuickButton);
  };
  const remove = async (b: QuickButton) => { const { error } = await sb.from('quick_buttons').delete().eq('id', b.id); if (error) { setErr(error.message); return; } setRows(r => r.filter(x => x.id !== b.id)); await boot.db.quickButtons.delete(b.id); };
  const results = q.trim() ? index.search(q, 20) : [];
  return (
    <Modal open onClose={onClose} title={pt('quickButtons', locale)} wide>
      {!online && <p className="bad">{pt('quickNeedsOnline', locale)}</p>}
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>{rows.map(b => <span key={b.id} className="quick" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{b.label || text(index.byId.get(b.product_id ?? '')?.name, locale)}<button className="btn icon" style={{ minHeight: 0 }} onClick={() => remove(b)} disabled={!online}>✕</button></span>)}</div>
      <input className="input" placeholder={pt('addQuick', locale)} value={q} onChange={e => setQ(e.target.value)} disabled={!online} />
      <ul className="tender-list" style={{ marginTop: 6 }}>{results.map(p => <li key={p.id}><span>{text(p.name, locale)}</span><button className="btn" onClick={() => add(p)}>＋</button></li>)}</ul>
      {err && <p className="bad">{err}</p>}
    </Modal>
  );
}
