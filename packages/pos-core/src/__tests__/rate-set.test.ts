import { afterEach, describe, expect, it } from 'vitest';
import { FakeServer } from '../sync/fake-server';
import { makeDevice, wipeAll } from './helpers';
import { setShopRate } from '../sale';

afterEach(wipeAll);

describe('the shop sets its own exchange rate', () => {
  it('adds a dated rate that becomes the latest, with one op', async () => {
    const server = new FakeServer(); const a = await makeDevice(server, 'A');
    const before = await a.db.rates.count();
    const r = await setShopRate(a.db, 's1', 90000.4);
    expect(r.lbp_per_usd).toBe(90000);
    expect(await a.db.rates.count()).toBe(before + 1);
    expect((await a.db.rates.orderBy('effective_at').reverse().first())!.lbp_per_usd).toBe(90000);
    const ops = (await a.db.outbox.toArray()).filter(o => o.kind === 'rate.set');
    expect(ops).toHaveLength(1); expect(ops[0].payload).toMatchObject({ id: r.id, lbp_per_usd: 90000 });
  });
  it('refuses a rate that is clearly a typo', async () => {
    const server = new FakeServer(); const a = await makeDevice(server, 'A');
    await expect(setShopRate(a.db, 's1', 90)).rejects.toThrow('bad_rate');
    await expect(setShopRate(a.db, 's1', 900000000)).rejects.toThrow('bad_rate');
    expect((await a.db.outbox.toArray()).filter(o => o.kind === 'rate.set')).toHaveLength(0);
  });
});
