import 'server-only';

// Catalog import (PLAN §M4). A file is parsed into rows of raw columns; an adapter turns those into ImportRow objects the
// pos_import_products RPC understands. The generic adapter uses a column mapping chosen in the UI; one adapter per source
// POS system is added here once a sample sits in samples/ (git-ignored). Adapters are pure functions: no I/O, easy to test.

export interface ImportRow {
  name_ar?: string; name_en?: string; sku?: string; barcodes?: string[]; price: number; currency?: 'usd' | 'lbp'; cost?: number;
  category?: string; unit?: 'piece' | 'kg' | 'g' | 'l' | 'ml' | 'pack'; decimal_qty?: boolean; track_stock?: boolean; min_stock?: number; on_hand?: number; visible_online?: boolean;
}
export type RawRow = Record<string, string | number | null | undefined>;
export const FIELDS = ['name_ar', 'name_en', 'sku', 'barcode', 'barcode2', 'price', 'currency', 'cost', 'category', 'unit', 'track_stock', 'min_stock', 'on_hand', 'visible_online'] as const;
export type Field = (typeof FIELDS)[number];
export type Mapping = Partial<Record<Field, string>>;   // field → source column header

export interface ImportAdapter {
  id: string; label: string;
  /** Confidence 0..1 that this adapter understands a file with these headers. */
  detect(headers: string[]): number;
  /** Suggested column mapping for the generic path (used to pre-fill the UI). */
  suggest(headers: string[]): Mapping;
  /** Convert one raw row with the (possibly user-adjusted) mapping. Return null to skip the row (blank lines, totals…). */
  convert(row: RawRow, mapping: Mapping): ImportRow | null;
}

const str = (v: unknown) => (v == null ? '' : String(v).trim());
const num = (v: unknown) => { if (v == null || v === '') return undefined; const n = Number(String(v).replace(/[^\d.,-]/g, '').replace(/,/g, '')); return isNaN(n) ? undefined : n; };
const bool = (v: unknown) => { const s = str(v).toLowerCase(); if (!s) return undefined; return ['1', 'true', 'yes', 'y', 'نعم', 'x', '✓'].includes(s); };
const UNIT: Record<string, ImportRow['unit']> = { piece: 'piece', pc: 'piece', pcs: 'piece', قطعة: 'piece', kg: 'kg', كغ: 'kg', كيلو: 'kg', g: 'g', gr: 'g', غ: 'g', l: 'l', lt: 'l', لتر: 'l', ml: 'ml', pack: 'pack', pk: 'pack', عبوة: 'pack' };

/** Column-mapping adapter for any Excel/CSV: the UI maps headers to fields. Heuristic suggestions cover the common AR/EN headers. */
export const genericAdapter: ImportAdapter = {
  id: 'generic', label: 'Excel / CSV (column mapping)',
  detect: () => 0.1,
  suggest(headers) {
    const m: Mapping = {};
    const find = (...pats: RegExp[]) => headers.find(h => pats.some(p => p.test(h.toLowerCase())));
    m.name_ar = find(/arabic|name_ar|الاسم|اسم|صنف/) ?? find(/^name$|item|description|product/);
    m.name_en = find(/english|name_en|name \(en|en$/) ?? (m.name_ar && /name|item|product/.test(m.name_ar.toLowerCase()) ? undefined : find(/^name$|item|product/));
    m.sku = find(/sku|code|ref|رمز|كود/);
    m.barcode = find(/barcode|ean|upc|باركود/);
    m.price = find(/sell|price|سعر|retail/);
    m.cost = find(/cost|purchase|كلفة|شراء/);
    m.category = find(/categor|section|group|فئة|قسم|مجموعة/);
    m.unit = find(/unit|وحدة/);
    m.on_hand = find(/stock|qty|quantity|on hand|كمية|مخزون/);
    m.min_stock = find(/min|reorder|حد/);
    m.currency = find(/currency|عملة/);
    for (const k of Object.keys(m) as Field[]) if (!m[k]) delete m[k];
    return m;
  },
  convert(row, m) {
    const g = (f: Field) => (m[f] ? row[m[f]!] : undefined);
    const price = num(g('price'));
    if (!str(g('name_ar')) && !str(g('name_en')) && price === undefined) return null;    // blank line
    const cur = str(g('currency')).toLowerCase();
    const barcodes = [str(g('barcode')), str(g('barcode2'))].flatMap(b => b.split(/[;,/\s]+/)).map(b => b.trim()).filter(b => /^\d{4,}$/.test(b));
    return {
      name_ar: str(g('name_ar')) || undefined, name_en: str(g('name_en')) || undefined, sku: str(g('sku')) || undefined, barcodes: barcodes.length ? barcodes : undefined,
      price: price ?? 0, currency: cur.includes('l') ? 'lbp' : cur ? 'usd' : undefined, cost: num(g('cost')), category: str(g('category')) || undefined,
      unit: UNIT[str(g('unit')).toLowerCase()], track_stock: bool(g('track_stock')), min_stock: num(g('min_stock')), on_hand: num(g('on_hand')), visible_online: bool(g('visible_online')),
    };
  },
};

export const ADAPTERS: ImportAdapter[] = [genericAdapter];
export const pickAdapter = (headers: string[]): ImportAdapter => ADAPTERS.map(a => ({ a, s: a.detect(headers) })).sort((x, y) => y.s - x.s)[0].a;
