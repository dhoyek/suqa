import Dexie from 'dexie';
import { v7 as uuidv7 } from 'uuid';
import { META, PosDb, setMeta } from '../db';
import { FakeServer, type FakeTransport } from '../sync/fake-server';
import { SyncEngine, type SyncEvent } from '../sync/engine';
import { commitSale, newDraft, addToDraft, type Draft } from '../sale';
import type { Product } from '../types';

export const RATE = 89500;

/** A device = its own IndexedDB + engine against the shared fake server. */
export async function makeDevice(server: FakeServer, name: string, opts: { events?: SyncEvent[] } = {}) {
  const id = uuidv7();
  const transport = server.transport() as FakeTransport;
  const db = new PosDb(`suqa-pos-test-${server.shop.id}-${id}`);
  await db.open();
  const dev = await transport.register({ id, shop_id: server.shop.id, name });
  await setMeta(db, META.deviceId, id); await setMeta(db, META.devicePrefix, dev.prefix); await setMeta(db, META.deviceName, dev.name);
  const events: SyncEvent[] = opts.events ?? [];
  const engine = new SyncEngine({ db, transport, deviceId: id, onEvent: e => events.push(e), backoff: () => 0 });
  await engine.bootstrap();
  return { id, db, transport, engine, events, prefix: dev.prefix };
}

export async function sell(db: PosDb, product: Product, qty = 1, extra: Partial<Draft> = {}) {
  let d = newDraft('walkin'); d = addToDraft(d, product, qty); d = { ...d, ...extra };
  const total = Math.round(Number(product.price_usd) * 100 * qty);
  return commitSale(db, { draft: d, rate: RATE, lbpStep: 5000, changeIn: 'usd', payments: [{ tender: 'cash_usd', amount: total, currency: 'usd' }] });
}

export async function wipeAll() { for (const n of await Dexie.getDatabaseNames()) await Dexie.delete(n); }
