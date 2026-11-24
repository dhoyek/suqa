import { describe, expect, it } from 'vitest';
import { parseCard, photoCost, runItemPhoto, PHOTO_MAX_BYTES } from './photo';
import type { Route } from './routes';

const route: Route = { task: 'photo_read', provider: 'google', model: 'm1', fallback_provider: 'google', fallback_model: 'm2', enabled: true, price_in_per_m: 1.5, price_out_per_m: 7.5, price_audio_per_m: null, price_per_image: null };
const cats = ['Hair Care', 'Soft Drinks'];
const good = '```json\n{"name_ar":"بانتين شامبو 360 مل","name_en":"Pantene  shampoo 360 ml","description_ar":"شامبو للشعر","description_en":"Hair shampoo","category":"hair care","barcode":"4084500 643888"}\n```';

describe('item photo → a suggested card', () => {
  it('reads the JSON out of a fenced answer, tidies the text, keeps only a listed category and a whole barcode', () => {
    expect(parseCard(good, cats)).toEqual({ name_ar: 'بانتين شامبو 360 مل', name_en: 'Pantene shampoo 360 ml', description_ar: 'شامبو للشعر', description_en: 'Hair shampoo', category: 'Hair Care', barcode: '4084500643888' });
    expect(parseCard('{"name_en":"X","category":"Toys","barcode":"12345"}', cats)).toMatchObject({ name_en: 'X', name_ar: '', category: '', barcode: '' });
    expect(parseCard('sorry, I cannot', cats)).toBeNull();
    expect(parseCard('{not json}', cats)).toBeNull();
  });
  it('costs what the route\'s prices say; a missing price is charged at the dearest', () => {
    expect(photoCost(route, { input_tokens: 1000, output_tokens: 200 })).toBeCloseTo((1000 * 1.5 + 200 * 7.5) / 1e6, 9);
    expect(photoCost({ price_in_per_m: null, price_out_per_m: 7.5, price_per_image: 0.002 }, { input_tokens: 1000, output_tokens: 0 })).toBeCloseTo(0.0075 + 0.002, 9);
  });
  it('ok, nothing to name, too big, and the fallback model when the first fails', async () => {
    const img = new Uint8Array(10); const usage = { input_tokens: 1000, output_tokens: 100 };
    const ok = await runItemPhoto(route, 'k', img, 'image/jpeg', cats, async () => ({ text: good, usage }));
    expect(ok.status === 'ok' && ok.card.name_en).toBe('Pantene shampoo 360 ml'); expect(ok.status === 'ok' && ok.cost_usd).toBeGreaterThan(0);
    const none = await runItemPhoto(route, 'k', img, 'image/jpeg', cats, async () => ({ text: '{"name_ar":"","name_en":""}', usage }));
    expect(none.status).toBe('nothing'); expect(none.status === 'nothing' && none.cost_usd).toBeGreaterThan(0);      // paid for, so it is counted
    expect((await runItemPhoto(route, 'k', new Uint8Array(PHOTO_MAX_BYTES + 1), 'image/jpeg')).status).toBe('too_big');
    const seen: string[] = [];
    const fb = await runItemPhoto(route, 'k', img, 'image/jpeg', cats, async o => { seen.push(o.model); if (o.model === 'm1') throw new Error('photo_http_500'); return { text: good, usage }; });
    expect(seen).toEqual(['m1', 'm2']); expect(fb.status === 'ok' && fb.model).toBe('m2');
    const bad = await runItemPhoto(route, 'k', img, 'image/jpeg', cats, async () => { throw new Error('photo_http_500'); });
    expect(bad).toEqual({ status: 'failed', error: 'photo_http_500' });
  });
});
