import { describe, expect, it } from 'vitest';
import { runImageCleanup, CLEAN_MAX_BYTES } from './clean';
import type { Route } from './routes';

const route: Route = { task: 'image_cleanup', provider: 'google', model: 'img-1', fallback_provider: 'google', fallback_model: 'img-2', enabled: true, price_in_per_m: 0.5, price_out_per_m: 60, price_audio_per_m: null, price_per_image: null };
const out = { image: new Uint8Array([1, 2, 3]), mime: 'image/jpeg', usage: { input_tokens: 1248, output_tokens: 1400 } };
describe('item photo → cleaned picture', () => {
  it('returns the picture with what it cost at the route\'s prices', async () => {
    const r = await runImageCleanup(route, 'k', new Uint8Array(10), 'image/jpeg', async () => out);
    expect(r.status === 'ok' && r.model).toBe('img-1');
    expect(r.status === 'ok' && r.cost_usd).toBeCloseTo((1248 * 0.5 + 1400 * 60) / 1e6, 6);      // about 8.5 cents
    expect(r.status === 'ok' && r.image.length).toBe(3);
  });
  it('too big is refused before any call; the fallback model is tried once; a failure says why', async () => {
    let calls = 0;
    expect((await runImageCleanup(route, 'k', new Uint8Array(CLEAN_MAX_BYTES + 1), 'image/jpeg', async () => { calls++; return out; })).status).toBe('too_big');
    expect(calls).toBe(0);
    const seen: string[] = [];
    const fb = await runImageCleanup(route, 'k', new Uint8Array(10), 'image/jpeg', async o => { seen.push(o.model); if (o.model === 'img-1') throw new Error('clean_http_500'); return out; });
    expect(seen).toEqual(['img-1', 'img-2']); expect(fb.status === 'ok' && fb.model).toBe('img-2');
    expect(await runImageCleanup({ ...route, fallback_provider: null, fallback_model: null }, 'k', new Uint8Array(10), 'image/jpeg', async () => { throw new Error('clean_no_image'); })).toEqual({ status: 'failed', error: 'clean_no_image' });
  });
});
