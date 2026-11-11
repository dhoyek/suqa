import { afterEach, describe, expect, it } from 'vitest';
import { FakeServer } from '../sync/fake-server';
import { makeDevice, wipeAll, RATE } from './helpers';
import { addToDraft, commitSale, dropDraft, loadCurrentDraft, newDraft, saveDraft } from '../sale';

afterEach(wipeAll);

describe('current cart after a sale', () => {
  it('a sold cart written back by a late autosave is not restored as the current cart', async () => {
    const server = new FakeServer();
    const p = server.addProduct({ id: 'p1', price_usd: 2.25, on_hand: 10 });
    const a = await makeDevice(server, 'A');
    const d = addToDraft(newDraft('walkin'), p, 3);
    await saveDraft(a.db, d);
    expect((await loadCurrentDraft(a.db))?.lines.length).toBe(1);

    await commitSale(a.db, { draft: d, rate: RATE, lbpStep: 5000, changeIn: 'usd', payments: [{ tender: 'unpaid', amount: 675, currency: 'usd', unpaid_name: 'x', unpaid_phone: '70000000' }] });
    await dropDraft(a.db, d.id);
    await saveDraft(a.db, d);                       // the debounced autosave that used to fire when the pay dialog closed

    expect(await loadCurrentDraft(a.db)).toBeNull();
    expect(await loadCurrentDraft(a.db)).toBeNull(); // and it was cleaned up, not just hidden
    expect(await a.db.drafts.get(d.id)).toBeUndefined();
  });
});
