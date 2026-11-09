export interface ScaleConfig { prefix: string | null; code_len?: number; value_kind?: 'weight' | 'price_lbp' | 'price_usd'; value_divisor?: number }
export interface ScanHit { product: Product; qty: number; pack?: { qty: number; barcode: string }; unit_price_cents?: number; unit_price_lbp?: number; fixed_total_cents?: number; fixed_total_lbp?: number; scale?: boolean }
import type { Barcode, Category, Localized, Product, QuickButton } from './types';

// Arabic/Latin normalisation shared with the store's menu search: strip tashkeel, unify alef forms, ta marbuta → ha, alef maqsura → ya,
// Arabic-Indic digits → Western, lower-case Latin, collapse whitespace.
const AR_DIGITS = /[٠-٩]/g;
export function normalize(v: string): string {
  return (v ?? '')
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[إأآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(AR_DIGITS, d => String(d.charCodeAt(0) - 0x660))
    .replace(/\s+/g, ' ').trim();
}
export const text = (t: Localized | undefined, locale: 'ar' | 'en'): string => (t?.[locale] || t?.ar || t?.en || '');

interface IndexRow { id: string; norm: string }

/**
 * In-memory catalog for the sale screen. Built once from IndexedDB, patched by the feed.
 * Hot paths: byBarcode.get() for scans, search() for typing. Never touches IndexedDB.
 */
export class CatalogIndex {
  byId = new Map<string, Product>();
  byBarcode = new Map<string, string>();        // barcode → product id
  barcodeRows = new Map<string, Barcode>();     // barcode → row (pack qty / pack price)
  private barcodesOf = new Map<string, Set<string>>();
  categories = new Map<string, Category>();
  quickButtons: QuickButton[] = [];
  private rows: IndexRow[] = [];
  private dirty = true;

  load(products: Product[], barcodes: Barcode[], _categories: Category[], quickButtons: QuickButton[]): void {
    this.byId.clear(); this.byBarcode.clear(); this.barcodeRows.clear(); this.barcodesOf.clear(); this.categories.clear();
    for (const p of products) if (p.is_active) this.byId.set(p.id, p);
    for (const b of barcodes) this.addBarcode(b);
    this.rebuildSections();
    this.quickButtons = [...quickButtons].sort((a, b) => a.sort_order - b.sort_order);
    this.dirty = true;
  }
  upsertProduct(p: Product): void { if (p.is_active) this.byId.set(p.id, p); else this.byId.delete(p.id); this.dirty = true; this.rebuildSections(); }
  /** Products group by their free-text `section` (the storefront's menu groups); the POS shows them as category chips. */
  private rebuildSections(): void {
    this.categories.clear();
    const order = new Map<string, number>();
    for (const p of this.byId.values()) { const sct = (p.section ?? '').trim(); if (!sct) continue; if (!order.has(sct)) order.set(sct, p.sort_order ?? order.size); }
    let i = 0; for (const [sct] of [...order.entries()].sort((a, b) => a[1] - b[1])) this.categories.set(sct, { id: sct, tenant_id: '', name: { ar: sct, en: sct }, sort_order: i++ });
  }
  removeProduct(id: string): void { this.byId.delete(id); for (const bc of this.barcodesOf.get(id) ?? []) this.byBarcode.delete(bc); this.barcodesOf.delete(id); this.dirty = true; }
  addBarcode(b: Barcode): void {
    const bc = normBarcode(b.barcode); this.byBarcode.set(bc, b.product_id); this.barcodeRows.set(bc, b);
    if (!this.barcodesOf.has(b.product_id)) this.barcodesOf.set(b.product_id, new Set());
    this.barcodesOf.get(b.product_id)!.add(bc);
  }
  removeBarcode(b: Pick<Barcode, 'product_id' | 'barcode'>): void { const bc = normBarcode(b.barcode); if (this.byBarcode.get(bc) === b.product_id) { this.byBarcode.delete(bc); this.barcodeRows.delete(bc); } this.barcodesOf.get(b.product_id)?.delete(bc); }
  upsertCategory(c: Category): void { this.categories.set(c.id, c); }
  setQuickButtons(q: QuickButton[]): void { this.quickButtons = [...q].sort((a, b) => a.sort_order - b.sort_order); }
  barcodes(productId: string): string[] { return [...(this.barcodesOf.get(productId) ?? [])]; }

  /** Resolve a scan: exact barcode, else a GTIN variant of it (see barcodeVariants), else SKU, else null. */
  scan(code: string): Product | null {
    const bc = normBarcode(code);
    for (const v of barcodeVariants(bc)) { const id = this.byBarcode.get(v); if (id) return this.byId.get(id) ?? null; }
    for (const p of this.byId.values()) if (p.sku && normBarcode(p.sku) === bc) return p;
    return null;
  }
  /** The stored barcode a scan resolved to (needed to read pack info off the right row). */
  private storedBarcode(bc: string): string | null { for (const v of barcodeVariants(bc)) if (this.byBarcode.has(v)) return v; return null; }

  /**
   * Scan with pack and scale support. Pack barcode → qty = pack_qty at the pack price. Scale label (prefix + item code + value + check)
   * → the item by code (sku or barcode) with the weight as quantity or the embedded price. Falls back to scan().
   */
  scanEx(code: string, scales?: ScaleConfig | ScaleConfig[] | null): ScanHit | null {
    const bc = normBarcode(code);
    const p = this.scan(bc);
    const list = Array.isArray(scales) ? scales : scales ? [scales] : [];
    if (p) {
      const row = this.barcodeRows.get(this.storedBarcode(bc) ?? bc); const pq = Number(row?.pack_qty ?? 1) || 1;
      if (row && pq !== 1) {
        const ppu = row.pack_price_usd != null && row.pack_price_usd !== '' ? Number(row.pack_price_usd) : null; const ppl = row.pack_price_lbp != null && row.pack_price_lbp !== '' ? Number(row.pack_price_lbp) : null;
        return { product: p, qty: pq, pack: { qty: pq, barcode: bc }, unit_price_cents: ppu != null ? Math.round((ppu * 100) / pq) : undefined, unit_price_lbp: ppl != null ? Math.round(ppl / pq) : undefined };
      }
      return { product: p, qty: 1 };
    }
    for (const scale of list) {
    if (scale?.prefix && bc.startsWith(scale.prefix) && /^\d{12,14}$/.test(bc)) {
      const codeLen = scale.code_len || 5; const start = scale.prefix.length; const item = bc.slice(start, start + codeLen);
      const value = Number(bc.slice(start + codeLen, bc.length - 1)); const div = scale.value_divisor || 1000;
      const target = this.scan(item) ?? this.scan(item.replace(/^0+/, '')) ?? [...this.byId.values()].find(x => x.sku && normBarcode(x.sku).padStart(codeLen, '0') === item) ?? null;
      if (target && Number.isFinite(value)) {
        if (scale.value_kind === 'weight') return { product: target, qty: Math.round((value / div) * 1000) / 1000, scale: true };
        if (scale.value_kind === 'price_usd') return { product: target, qty: 1, fixed_total_cents: Math.round((value / div) * 100), scale: true };
        return { product: target, qty: 1, fixed_total_lbp: Math.round(value / div), scale: true };
      }
    }
    }
    return null;
  }

  private rebuild(): void {
    this.rows = [];
    for (const p of this.byId.values()) {
      this.rows.push({ id: p.id, norm: normalize(`${p.name?.ar ?? ''} ${p.name?.en ?? ''} ${p.sku ?? ''} ${[...(this.barcodesOf.get(p.id) ?? [])].join(' ')} ${p.description?.ar ?? ''} ${p.description?.en ?? ''}`) });
    }
    this.dirty = false;
  }

  /** Substring search over normalised AR/EN names + SKU, every word must match. Capped. */
  /** `categoryId` may be one category, a set of several (any of them), or null/empty = all. */
  search(q: string, limit = 50, categoryId?: string | null | Iterable<string>): Product[] {
    if (this.dirty) this.rebuild();
    const words = normalize(q).split(' ').filter(Boolean);
    const cats = catSet(categoryId);
    const out: Product[] = [];
    for (const r of this.rows) {
      const p = this.byId.get(r.id)!;
      if (cats && !cats.has(p.section ?? '')) continue;
      if (words.length && !words.every(w => r.norm.includes(w))) continue;
      out.push(p);
      if (out.length >= limit) break;
    }
    return out;
  }

  byCategory(categoryId: string | null | Iterable<string>, limit = 200): Product[] {
    const cats = catSet(categoryId);
    const out: Product[] = [];
    for (const p of this.byId.values()) { if (!cats || cats.has(p.section ?? '')) { out.push(p); if (out.length >= limit) break; } }
    return out.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  }
  get size(): number { return this.byId.size; }
}

/** GTIN check digit (EAN-8/UPC-A/EAN-13/GTIN-14) for the digits before the last position. */
export function gtinCheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += Number(body[body.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}
/**
 * Equivalent spellings of one barcode, most exact first. Many legacy POS databases (and scanners configured that way)
 * store EAN/UPC codes WITHOUT the check digit, and some add or drop the leading zero (UPC-A ⇄ EAN-13). A camera or a
 * fresh scanner reads the full symbol, so the lookup must accept all of these as the same code.
 */
export function barcodeVariants(code: string): string[] {
  const out = [code];
  if (!/^\d{7,14}$/.test(code)) return out;
  const push = (v: string) => { if (v && !out.includes(v)) out.push(v); };
  const n = code.length;
  if ((n === 8 || n === 12 || n === 13 || n === 14) && gtinCheckDigit(code.slice(0, -1)) === Number(code[n - 1])) {
    push(code.slice(0, -1));                                   // stored without the check digit
    if (n === 13 && code.startsWith('0')) { push(code.slice(1)); push(code.slice(1, -1)); }   // EAN-13 that is really a UPC-A
  }
  if (n === 12) { push('0' + code); push(code + gtinCheckDigit(code)); }   // UPC-A read as EAN-13 / stored with check digit
  if (n === 7 || n === 11 || n === 13) push(code + gtinCheckDigit(code));   // stored stripped, scanner delivers full
  if (code.startsWith('0')) push(code.replace(/^0+/, ''));
  return out;
}
export const normBarcode = (s: string): string => (s ?? '').trim().toLowerCase().replace(AR_DIGITS, d => String(d.charCodeAt(0) - 0x660));

/** null / '' / empty set → no category filter; a string → that one; an iterable → any of them. */
function catSet(c: string | null | undefined | Iterable<string>): Set<string> | null {
  if (c == null || c === '') return null;
  const s = typeof c === 'string' ? new Set([c]) : new Set(c);
  return s.size ? s : null;
}

/** All scale-label formats of a shop: the primary scale_* columns plus scale_formats. */
export function scaleConfigs(shop: { scale_prefix?: string | null; scale_code_len?: number; scale_value_kind?: ScaleConfig['value_kind']; scale_value_divisor?: number; scale_formats?: { prefix: string; code_len?: number; value_kind?: ScaleConfig['value_kind']; value_divisor?: number }[] }): ScaleConfig[] {
  const out: ScaleConfig[] = [];
  if (shop.scale_prefix) out.push({ prefix: shop.scale_prefix, code_len: shop.scale_code_len, value_kind: shop.scale_value_kind, value_divisor: shop.scale_value_divisor });
  for (const f of shop.scale_formats ?? []) if (f?.prefix) out.push({ prefix: String(f.prefix), code_len: f.code_len, value_kind: f.value_kind, value_divisor: f.value_divisor });
  return out;
}
