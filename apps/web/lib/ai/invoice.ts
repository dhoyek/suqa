// Task 'photo_read', second job: a photo of a SUPPLIER'S INVOICE in, the invoice as data out (supplier, number, date, currency,
// lines with quantity, unit price, discount). A DRAFT only: the till matches the lines to the shop's own items, the person
// checks every row and posts the purchase themselves. Nothing is written from here; the photo is not stored.
// Pure: the provider call and the key are passed in, so it is tested as is.
import { googleReadPhoto, type PhotoUsage } from './google';
import { photoCost, PHOTO_MAX_BYTES } from './photo';
import type { Route } from './routes';

export type InvoiceLine = { name: string; barcode: string; qty: number; unit_cost: number; discount: number | null; discount_pct: number | null; total: number | null };
export type InvoiceDraft = { supplier: string; invoice_no: string; date: string; currency: 'usd' | 'lbp' | null; subtotal: number | null; discount: number | null; total: number | null; lines: InvoiceLine[] };
export type InvoiceResult =
  | { status: 'ok'; invoice: InvoiceDraft; model: string; cost_usd: number; input_tokens: number; output_tokens: number; ms: number }
  | { status: 'nothing'; model: string; cost_usd: number; input_tokens: number; output_tokens: number; ms: number }
  | { status: 'too_big' }
  | { status: 'failed'; error: string };

export const INVOICE_SYSTEM = [
  'You read a photo of a SUPPLIER\'S INVOICE or delivery note given to a small shop in Lebanon and return it as data. Arabic, English and French appear, printed or handwritten.',
  'Return ONLY one JSON object, no other text:',
  '{"supplier":"","invoice_no":"","date":"YYYY-MM-DD","currency":"usd|lbp|","subtotal":null,"discount":null,"total":null,"lines":[{"name":"","barcode":"","qty":0,"unit_cost":0,"discount":null,"discount_pct":null,"total":null}]}',
  'Rules:',
  '- One entry in lines per item line, in the order printed. name = the item as written on the invoice (keep brand, size, flavour); do not translate or tidy it.',
  '- qty = the number of units bought. If the invoice counts cartons / boxes AND gives the pieces per carton, qty = total pieces and unit_cost = price of ONE piece; otherwise keep the invoice\'s own unit and its price.',
  '- unit_cost = the price of one unit BEFORE the line\'s discount, without currency sign or thousands separators. total = the line\'s amount as printed (after its discount), or null.',
  '- discount = the line\'s discount as an amount, discount_pct = as a percent, when one is printed on that line; otherwise null. Never both.',
  '- barcode = digits only, when a whole barcode is printed on the line; otherwise "".',
  '- currency: "usd" when amounts are in dollars ($, USD), "lbp" when in Lebanese pounds (ل.ل, LBP, LL, amounts in the hundreds of thousands), "" when it cannot be told.',
  '- subtotal / discount / total: the invoice\'s own printed figures (discount = the discount on the whole invoice, as an amount), or null when not printed. Do not compute them.',
  '- date: the invoice date as YYYY-MM-DD, or "" when unreadable. invoice_no: the invoice / bill number, or "".',
  '- Never invent a line, a number or a name. A value you cannot read is null (or "" for text); a line whose name you cannot read is left out.',
  '- If the photo is not an invoice or has no readable item line, return {"lines":[]}.',
].join('\n');

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : typeof v === 'number' ? String(v) : '');
/** A printed number → a number: "1,250.50", "1.250,50", "12 500", "٣٫٥" are all read; anything else is null. */
export function readNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[٫]/g, '.').replace(/[٬\s]/g, '').replace(/[^\d.,-]/g, '');
  if (!s || !/\d/.test(s)) return null;
  const c = s.lastIndexOf(','), d = s.lastIndexOf('.');
  if (c >= 0 && d >= 0) s = c > d ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (c >= 0) s = /,\d{1,2}$/.test(s) && (s.match(/,/g) ?? []).length === 1 ? s.replace(',', '.') : s.replace(/,/g, '');
  else if ((s.match(/\./g) ?? []).length > 1) s = s.replace(/\./g, '');
  const n = Number(s); return Number.isFinite(n) ? n : null;
}
const pos = (v: unknown) => { const n = readNumber(v); return n != null && n >= 0 ? n : null; };

/** The model's answer → an invoice draft. null = not an invoice we can use. Never more than 80 lines; nothing negative. */
export function parseInvoice(raw: string): InvoiceDraft | null {
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let j: Record<string, unknown>; try { j = JSON.parse(raw.slice(a, b + 1)) as Record<string, unknown>; } catch { return null; }
  const lines: InvoiceLine[] = [];
  for (const x of Array.isArray(j.lines) ? j.lines.slice(0, 80) : []) {
    if (!x || typeof x !== 'object') continue; const l = x as Record<string, unknown>;
    const name = text(l.name, 160); const qty = pos(l.qty); if (!name || qty == null || qty <= 0) continue;
    const digits = text(l.barcode, 20).replace(/\D/g, '');
    const pct = pos(l.discount_pct); const disc = pct != null && pct > 0 ? null : pos(l.discount);
    lines.push({ name, barcode: [8, 12, 13, 14].includes(digits.length) ? digits : '', qty: Math.round(qty * 1000) / 1000, unit_cost: pos(l.unit_cost) ?? 0,
      discount: disc && disc > 0 ? disc : null, discount_pct: pct != null && pct > 0 && pct <= 100 ? pct : null, total: pos(l.total) });
  }
  if (!lines.length) return null;
  const cur = text(j.currency, 5).toLowerCase(); const date = text(j.date, 10);
  return { supplier: text(j.supplier, 120), invoice_no: text(j.invoice_no, 40), date: /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) ? date : '',
    currency: cur === 'usd' || cur === 'lbp' ? cur : null, subtotal: pos(j.subtotal), discount: pos(j.discount), total: pos(j.total), lines };
}

type Read = typeof googleReadPhoto;
export async function runInvoicePhoto(route: Route, key: string, image: Uint8Array, mime: string, read: Read = googleReadPhoto, now: () => number = Date.now): Promise<InvoiceResult> {
  if (image.length > PHOTO_MAX_BYTES) return { status: 'too_big' };
  const tries = [{ provider: route.provider, model: route.model }, ...(route.fallback_provider && route.fallback_model ? [{ provider: route.fallback_provider, model: route.fallback_model }] : [])].filter(t => t.provider === 'google');
  if (!tries.length) return { status: 'failed', error: 'no_photo_provider' };
  let last = 'photo_failed'; const t0 = now();
  for (const t of tries) {
    try {
      const r = await read({ key, model: t.model, image, mime, system: INVOICE_SYSTEM, prompt: 'Read this supplier invoice and return the JSON.', maxTokens: 8000, timeoutMs: 55_000 });
      const base = { model: t.model, cost_usd: photoCost(route, r.usage as PhotoUsage), ...r.usage, ms: now() - t0 };
      const invoice = parseInvoice(r.text);
      if (!invoice) return { status: 'nothing', ...base };
      return { status: 'ok', invoice, ...base };
    } catch (e) { last = String((e as Error).message ?? e).slice(0, 200); }
  }
  return { status: 'failed', error: last };
}
