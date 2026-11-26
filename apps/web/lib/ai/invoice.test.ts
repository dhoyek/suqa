import { describe, expect, it } from 'vitest';
import { parseInvoice, readNumber, runInvoicePhoto } from './invoice';
import type { Route } from './routes';

const route = { task: 'photo_read', provider: 'google', model: 'm1', fallback_provider: 'google', fallback_model: 'm2', enabled: true, price_in_per_m: 1.5, price_out_per_m: 7.5, price_per_image: null } as unknown as Route;

describe('supplier invoice from a photo', () => {
  it('reads printed numbers however they are written', () => {
    expect(readNumber('1,250.50')).toBe(1250.5); expect(readNumber('1.250,50')).toBe(1250.5); expect(readNumber('12 500')).toBe(12500);
    expect(readNumber('3,5')).toBe(3.5); expect(readNumber('1,250')).toBe(1250); expect(readNumber('٣٫٥')).toBe(3.5); expect(readNumber('$ 2.00')).toBe(2);
    expect(readNumber('1.250.000')).toBe(1250000); expect(readNumber('abc')).toBeNull(); expect(readNumber(null)).toBeNull();
  });

  it('keeps what is on the invoice and drops what cannot be used', () => {
    const inv = parseInvoice('```json\n' + JSON.stringify({ supplier: ' Rico  SAL ', invoice_no: 4471, date: '2026-11-25', currency: 'USD', subtotal: '220.00', discount: null, total: '198',
      lines: [
        { name: 'Siblou White Tuna With Red Chili 185 g', barcode: '5 281 001 123 456', qty: '110', unit_cost: '2.00', discount: null, discount_pct: 10, total: 198 },
        { name: 'Pepsi 330', barcode: '123', qty: 24, unit_cost: 0.5, discount: 1, discount_pct: 0, total: 11 },
        { name: '', qty: 3, unit_cost: 1 }, { name: 'no quantity', qty: 0, unit_cost: 1 }, { name: 'negative', qty: -2, unit_cost: 1 }, 'junk',
      ] }) + '\n```')!;
    expect(inv).toMatchObject({ supplier: 'Rico SAL', invoice_no: '4471', date: '2026-11-25', currency: 'usd', subtotal: 220, discount: null, total: 198 });
    expect(inv.lines).toEqual([
      { name: 'Siblou White Tuna With Red Chili 185 g', barcode: '5281001123456', qty: 110, unit_cost: 2, discount: null, discount_pct: 10, total: 198 },
      { name: 'Pepsi 330', barcode: '', qty: 24, unit_cost: 0.5, discount: 1, discount_pct: null, total: 11 },
    ]);
  });

  it('is nothing when there is no item line, a bad date or currency is left empty, and it never returns more than 80 lines', () => {
    expect(parseInvoice('{"lines":[]}')).toBeNull(); expect(parseInvoice('sorry, not an invoice')).toBeNull();
    const inv = parseInvoice(JSON.stringify({ date: '25/11/2026', currency: 'eur', lines: Array.from({ length: 120 }, (_, i) => ({ name: 'item ' + i, qty: 1, unit_cost: 1 })) }))!;
    expect(inv.date).toBe(''); expect(inv.currency).toBeNull(); expect(inv.lines).toHaveLength(80);
  });

  it('asks the model with the invoice instruction, counts the cost, falls back once, and refuses a file that is too big', async () => {
    const seen: string[] = [];
    const read = (async (o: { model: string; system?: string }) => { seen.push(o.model + ':' + (o.system?.includes('SUPPLIER') ? 'invoice' : 'item')); if (o.model === 'm1') throw new Error('photo_http_503');
      return { text: '{"supplier":"X","lines":[{"name":"a","qty":2,"unit_cost":3}]}', usage: { input_tokens: 1000, output_tokens: 200 } }; }) as never;
    const r = await runInvoicePhoto(route, 'k', new Uint8Array(10), 'image/jpeg', read, () => 5);
    expect(seen).toEqual(['m1:invoice', 'm2:invoice']);
    expect(r).toMatchObject({ status: 'ok', model: 'm2', cost_usd: 0.003, invoice: { supplier: 'X', lines: [{ name: 'a', qty: 2, unit_cost: 3 }] } });
    expect(await runInvoicePhoto(route, 'k', new Uint8Array(4 * 1024 * 1024), 'image/jpeg', read)).toEqual({ status: 'too_big' });
    const none = await runInvoicePhoto(route, 'k', new Uint8Array(10), 'image/jpeg', (async () => ({ text: '{"lines":[]}', usage: { input_tokens: 10, output_tokens: 5 } })) as never);
    expect(none.status).toBe('nothing');
  });
});
