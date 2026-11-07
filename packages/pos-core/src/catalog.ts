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
  private barcodesOf = new Map<string, Set<string>>();
  categories = new Map<string, Category>();
  quickButtons: QuickButton[] = [];
  private rows: IndexRow[] = [];
  private dirty = true;

  load(products: Product[], barcodes: Barcode[], categories: Category[], quickButtons: QuickButton[]): void {
    this.byId.clear(); this.byBarcode.clear(); this.barcodesOf.clear(); this.categories.clear();
    for (const p of products) if (p.is_active) this.byId.set(p.id, p);
    for (const b of barcodes) this.addBarcode(b);
    for (const c of categories) this.categories.set(c.id, c);
    this.quickButtons = [...quickButtons].sort((a, b) => a.sort_order - b.sort_order);
    this.dirty = true;
  }
  upsertProduct(p: Product): void { if (p.is_active) this.byId.set(p.id, p); else this.byId.delete(p.id); this.dirty = true; }
  removeProduct(id: string): void { this.byId.delete(id); for (const bc of this.barcodesOf.get(id) ?? []) this.byBarcode.delete(bc); this.barcodesOf.delete(id); this.dirty = true; }
  addBarcode(b: Barcode): void {
    const bc = normBarcode(b.barcode); this.byBarcode.set(bc, b.product_id);
    if (!this.barcodesOf.has(b.product_id)) this.barcodesOf.set(b.product_id, new Set());
    this.barcodesOf.get(b.product_id)!.add(bc);
  }
  removeBarcode(b: Pick<Barcode, 'product_id' | 'barcode'>): void { const bc = normBarcode(b.barcode); if (this.byBarcode.get(bc) === b.product_id) this.byBarcode.delete(bc); this.barcodesOf.get(b.product_id)?.delete(bc); }
  upsertCategory(c: Category): void { this.categories.set(c.id, c); }
  setQuickButtons(q: QuickButton[]): void { this.quickButtons = [...q].sort((a, b) => a.sort_order - b.sort_order); }
  barcodes(productId: string): string[] { return [...(this.barcodesOf.get(productId) ?? [])]; }

  /** Resolve a scan: exact barcode, else SKU, else null. */
  scan(code: string): Product | null {
    const bc = normBarcode(code);
    const id = this.byBarcode.get(bc);
    if (id) return this.byId.get(id) ?? null;
    for (const p of this.byId.values()) if (p.sku && normBarcode(p.sku) === bc) return p;
    return null;
  }

  private rebuild(): void {
    this.rows = [];
    for (const p of this.byId.values()) {
      this.rows.push({ id: p.id, norm: normalize(`${p.name?.ar ?? ''} ${p.name?.en ?? ''} ${p.sku ?? ''} ${p.description?.ar ?? ''} ${p.description?.en ?? ''}`) });
    }
    this.dirty = false;
  }

  /** Substring search over normalised AR/EN names + SKU, every word must match. Capped. */
  search(q: string, limit = 50, categoryId?: string | null): Product[] {
    if (this.dirty) this.rebuild();
    const words = normalize(q).split(' ').filter(Boolean);
    const out: Product[] = [];
    for (const r of this.rows) {
      const p = this.byId.get(r.id)!;
      if (categoryId && p.category_id !== categoryId) continue;
      if (words.length && !words.every(w => r.norm.includes(w))) continue;
      out.push(p);
      if (out.length >= limit) break;
    }
    return out;
  }

  byCategory(categoryId: string | null, limit = 200): Product[] {
    const out: Product[] = [];
    for (const p of this.byId.values()) { if ((categoryId ?? null) === (p.category_id ?? null)) { out.push(p); if (out.length >= limit) break; } }
    return out.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  }
  get size(): number { return this.byId.size; }
}

export const normBarcode = (s: string): string => (s ?? '').trim().toLowerCase().replace(AR_DIGITS, d => String(d.charCodeAt(0) - 0x660));
