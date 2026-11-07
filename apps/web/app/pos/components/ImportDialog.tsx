'use client';
import { useState } from 'react';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import Modal from './Modal';

type Field = 'name_ar' | 'name_en' | 'sku' | 'barcode' | 'barcode2' | 'price' | 'currency' | 'cost' | 'category' | 'unit' | 'track_stock' | 'min_stock' | 'on_hand' | 'visible_online';
const FIELDS: Field[] = ['name_ar', 'name_en', 'sku', 'barcode', 'barcode2', 'price', 'currency', 'cost', 'category', 'unit', 'track_stock', 'min_stock', 'on_hand', 'visible_online'];
const LABEL: Record<Field, { ar: string; en: string }> = {
  name_ar: { ar: 'الاسم بالعربي *', en: 'Name AR *' }, name_en: { ar: 'الاسم بالإنجليزي', en: 'Name EN' }, sku: { ar: 'رمز الصنف', en: 'SKU' }, barcode: { ar: 'باركود', en: 'Barcode' }, barcode2: { ar: 'باركود 2', en: 'Barcode 2' },
  price: { ar: 'سعر البيع *', en: 'Sell price *' }, currency: { ar: 'عملة السعر (usd/lbp)', en: 'Currency (usd/lbp)' }, cost: { ar: 'الكلفة', en: 'Cost' }, category: { ar: 'الفئة / القسم', en: 'Category / section' },
  unit: { ar: 'الوحدة', en: 'Unit' }, track_stock: { ar: 'تتبّع المخزون', en: 'Track stock' }, min_stock: { ar: 'الحد الأدنى', en: 'Min stock' }, on_hand: { ar: 'الكمية الحالية', en: 'Stock on hand' }, visible_online: { ar: 'يظهر أونلاين', en: 'Visible online' },
};
type Parsed = { headers: string[]; rows: Record<string, unknown>[]; total: number; sheet: string; adapter: string; mapping: Partial<Record<Field, string>>; adapters: { id: string; label: string }[] };
type Result = { rows: Array<{ i: number; action: string; message?: string | null }>; created: number; updated: number; errors: number; dry_run: boolean; skipped: number };

/** Excel/CSV import: upload → map columns → dry run (per-row report) → commit. Online, owner only. */
export default function ImportDialog({ boot, locale, onDone, onClose }: { boot: Booted; locale: L; onDone: () => void; onClose: () => void }) {
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [mapping, setMapping] = useState<Partial<Record<Field, string>>>({});
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const t = (k: Field) => LABEL[k][locale];

  const upload = async (f: File) => {
    setBusy(true); setErr(null);
    try {
      const fd = new FormData(); fd.append('file', f); fd.append('shop_id', boot.shop.id);
      const r = await fetch('/api/pos/import', { method: 'POST', body: fd }); const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? r.statusText);
      setParsed(j); setMapping(j.mapping ?? {}); setResult(null);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const run = async (dry: boolean) => {
    if (!parsed) return; setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/pos/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shop_id: boot.shop.id, adapter: parsed.adapter, mapping, rows: parsed.rows, dry_run: dry }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error ?? r.statusText);
      setResult(j); if (!dry) { boot.engine.poke(); onDone(); }
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const ar = locale === 'ar';
  return (
    <Modal open onClose={onClose} title={ar ? 'استيراد الأصناف من Excel / CSV' : 'Import items from Excel / CSV'} wide
      footer={<>
        <button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} />
        {parsed && <button className="btn" disabled={busy || !mapping.price || !(mapping.name_ar || mapping.name_en)} onClick={() => run(true)}>{ar ? 'تجربة (بدون حفظ)' : 'Dry run'}</button>}
        {parsed && result?.dry_run && result.errors === 0 && <button className="btn primary" disabled={busy} onClick={() => run(false)}>{ar ? `استيراد ${result.created + result.updated} صنفاً` : `Import ${result.created + result.updated} items`}</button>}
      </>}>
      {!parsed ? (
        <div className="stack">
          <p className="muted">{ar ? 'الصف الأول = عناوين الأعمدة. الحقول المطلوبة: الاسم وسعر البيع. التطابق مع الأصناف الموجودة: الباركود ثم رمز الصنف ثم الاسم.' : 'First row = column headers. Required: name and sell price. Existing items are matched by barcode, then SKU, then exact name.'}</p>
          <input type="file" accept=".xlsx,.xls,.csv" className="input" onChange={e => { const f = e.target.files?.[0]; if (f) void upload(f); }} disabled={busy} />
        </div>
      ) : (
        <div className="stack">
          <div className="muted" style={{ fontSize: 13 }}>{parsed.sheet} · {parsed.total} {ar ? 'صف' : 'rows'}{parsed.total > parsed.rows.length ? ` (${ar ? 'أول' : 'first'} ${parsed.rows.length})` : ''}</div>
          <div className="map-grid">
            {FIELDS.map(f => <label key={f} className="label">{t(f)}<select className="input" value={mapping[f] ?? ''} onChange={e => setMapping(m => ({ ...m, [f]: e.target.value || undefined }))}><option value="">—</option>{parsed.headers.map(h => <option key={h} value={h}>{h}</option>)}</select></label>)}
          </div>
          <div style={{ overflow: 'auto', maxHeight: 180 }}>
            <table className="table" style={{ fontSize: 12 }}><thead><tr>{parsed.headers.map(h => <th key={h} style={{ textAlign: 'start', whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
              <tbody>{parsed.rows.slice(0, 5).map((r, i) => <tr key={i}>{parsed.headers.map(h => <td key={h} style={{ whiteSpace: 'nowrap' }}>{String(r[h] ?? '')}</td>)}</tr>)}</tbody></table>
          </div>
          {result && (
            <div className={`card ${result.errors ? 'bad' : ''}`} style={{ padding: 10 }}>
              <strong>{result.dry_run ? (ar ? 'نتيجة التجربة' : 'Dry run') : (ar ? 'تم الاستيراد' : 'Imported')}:</strong> {ar ? 'جديد' : 'create'} {result.created} · {ar ? 'تحديث' : 'update'} {result.updated} · {ar ? 'أخطاء' : 'errors'} {result.errors}{result.skipped ? ` · ${ar ? 'تجاهل' : 'skipped'} ${result.skipped}` : ''}
              {!!result.errors && <ul style={{ margin: '6px 0 0', paddingInlineStart: 18, fontSize: 13 }}>{result.rows.filter(r => r.action === 'error').slice(0, 30).map(r => <li key={r.i}>{ar ? 'صف' : 'row'} {r.i}: {r.message}</li>)}</ul>}
              {!result.errors && !!result.rows.filter(r => r.message).length && <div className="muted" style={{ fontSize: 12 }}>{result.rows.filter(r => r.message).length} {ar ? 'ملاحظات' : 'notes'}</div>}
            </div>
          )}
          {err && <p className="bad">{err}</p>}
        </div>
      )}
      {busy && <p className="muted">…</p>}
    </Modal>
  );
}
