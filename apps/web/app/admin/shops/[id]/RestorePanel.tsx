'use client';
import { useMemo, useRef, useState } from 'react';
import { useConfirm } from '@/components/ConfirmProvider';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { readBackup, restoreBackup, type BackupFile } from '@/lib/shop-backup';
import type { Locale } from '@suqa/shared';

const T = {
  title: { ar: 'استرجاع نسخة احتياطية', en: 'Restore from a backup' },
  desc: { ar: 'يعيد ما هو ناقص فقط من ملف النسخة (طلبات، أصناف، زبائن، موردون، حركات…). لا يستبدل ولا يحذف أي شيء موجود حالياً. بعدها تأخذ كل الصناديق نسخة جديدة عند أول مزامنة.', en: 'Puts back only what is missing from the backup file (orders, items, customers, suppliers, movements…). Nothing that exists now is overwritten or deleted. Every till then takes a fresh copy on its next sync.' },
  pick: { ar: 'اختر ملف النسخة', en: 'Choose backup file' }, run: { ar: 'استرجاع', en: 'Restore' },
  takenAt: { ar: 'تاريخ النسخة', en: 'Backup taken' }, rows: { ar: 'سجل', en: 'rows' },
  otherShop: { ar: 'هذا الملف لمحل آخر — لا يمكن استرجاعه هنا.', en: 'This file belongs to another shop — it cannot be restored here.' },
  bad: { ar: 'الملف ليس نسخة احتياطية صالحة.', en: 'This is not a valid backup file.' },
  ask: { ar: 'استرجاع السجلات الناقصة من هذه النسخة؟ أوقف البيع على الصناديق حتى ينتهي.', en: 'Restore the missing records from this backup? Stop selling at the tills until it finishes.' },
  done: { ar: 'تم — سجلات أُعيدت', en: 'Done — rows put back' }, of: { ar: 'من', en: 'of' },
  itemsOnly: { ar: 'الأصناف فقط (لبدء المتجر الإلكتروني)', en: 'Items only (to start the online shop)' },
  itemsOnlyHint: { ar: 'يُحمَّل من الملف الأصناف والباركود مع الأسعار والكلفة فقط — بدون مبيعات، مشتريات، موردين، زبائن أو مخزون. الكميات تبدأ من صفر وتتبّع المخزون يكون مطفأً، فلا يظهر صنف «غير متوفر» بسبب كمية قديمة.', en: 'Loads only the items and barcodes with their prices and costs — no sales, purchases, suppliers, customers or stock. Quantities start at zero and stock tracking is off, so no item shows as unavailable because of an old quantity.' },
  nothing: { ar: 'لا شيء ناقص — المحل مطابق للنسخة أو أحدث منها.', en: 'Nothing was missing — the shop already has everything in this backup.' },
} as const;

/** The same file reduced to the catalogue: items and their barcodes, with prices and costs. The supplier link is dropped (the
 *  suppliers are not loaded), quantities start at zero and stock tracking is off — the shop's real stock lives elsewhere for now. */
function onlyItems(f: BackupFile): BackupFile {
  const products = (f.tables.products ?? []).map(r => ({ ...r, supplier_id: null, track_stock: false, on_hand: 0, reserved: 0 }));
  const tables: BackupFile['tables'] = { products, product_barcodes: f.tables.product_barcodes ?? [] };
  return { ...f, tables, counts: [{ table: 'products', rows: products.length }, { table: 'product_barcodes', rows: tables.product_barcodes.length }] };
}

export default function RestorePanel({ shopId, locale }: { shopId: string; locale: Locale }) {
  const tx = (k: keyof typeof T) => (T[k] as Record<string, string>)[locale] ?? T[k].en;
  const sb = useMemo(() => supabaseBrowser(), []);
  const ask = useConfirm();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; data: BackupFile; rows: number } | null>(null);
  const [itemsOnly, setItemsOnly] = useState(false);
  const [busy, setBusy] = useState(false); const [pct, setPct] = useState(0); const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const choose = async (f: File | undefined) => {
    setMsg(null); setFile(null); if (!f) return;
    try {
      const data = await readBackup(f);
      if (data.shop?.id !== shopId) { setMsg({ ok: false, text: tx('otherShop') }); return; }
      setFile({ name: f.name, data, rows: Object.values(data.tables).reduce((s, r) => s + (Array.isArray(r) ? r.length : 0), 0) });
    } catch { setMsg({ ok: false, text: tx('bad') }); }
  };
  const run = async () => {
    if (!file || !(await ask(tx('ask'), { danger: true, confirmLabel: tx('run') }))) return;
    setBusy(true); setMsg(null); setPct(0);
    try {
      const r = await restoreBackup(sb, shopId, itemsOnly ? onlyItems(file.data) : file.data, file.name + (itemsOnly ? ' (items only)' : ''), p => setPct(p.total ? Math.round(p.done / p.total * 100) : 0));
      setMsg({ ok: true, text: r.inserted ? `${tx('done')}: ${r.inserted.toLocaleString('en-US')} ${tx('of')} ${r.received.toLocaleString('en-US')}` : tx('nothing') });
      setFile(null); if (input.current) input.current.value = '';
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    setBusy(false);
  };
  return (
    <section className="card stack">
      <strong>💾 {tx('title')}</strong>
      <span className="muted" style={{ fontSize: 13 }}>{tx('desc')}</span>
      <input ref={input} type="file" accept=".gz,.json,application/gzip,application/json" aria-label={tx('pick')} disabled={busy} onChange={e => void choose(e.target.files?.[0])} />
      <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
        <input type="checkbox" checked={itemsOnly} disabled={busy} onChange={e => setItemsOnly(e.target.checked)} style={{ marginTop: 4 }} />
        <span><b style={{ fontSize: 14 }}>{tx('itemsOnly')}</b><br /><span className="muted" style={{ fontSize: 13 }}>{tx('itemsOnlyHint')}</span></span>
      </label>
      {file && <div className="row spread">
        <span className="muted" style={{ fontSize: 13 }}>{tx('takenAt')}: <span dir="ltr">{new Date(file.data.at).toLocaleString('en-GB')}</span> · {file.rows.toLocaleString('en-US')} {tx('rows')}</span>
        <button className="btn primary" disabled={busy} onClick={run}>{busy ? `${pct}%` : tx('run')}</button>
      </div>}
      {msg && <div className={msg.ok ? 'muted' : 'error'}>{msg.ok ? '✓ ' : ''}{msg.text}</div>}
    </section>
  );
}
