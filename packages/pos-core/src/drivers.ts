import type { PosDb } from './db';
import { normPhone } from './customers';
import { enqueue, newId } from './sale';
import type { Driver } from './types';

/** Drivers the shop can send out right now: active and available, most recently used first. */
export async function availableDrivers(db: PosDb): Promise<Driver[]> {
  return (await db.drivers.toArray()).filter(d => d.active && d.available).sort((a, b) => (b.last_used_at ?? '').localeCompare(a.last_used_at ?? '') || a.name.localeCompare(b.name));
}

export async function upsertDriver(db: PosDb, shopId: string, input: { id?: string; name: string; phone: string; vehicle?: string | null; active?: boolean; available?: boolean; notes?: string | null }): Promise<Driver> {
  const key = normPhone(input.phone); if (key.length < 6) throw new Error('bad_phone');
  if (!input.name.trim()) throw new Error('bad_name');
  const existing = input.id ? await db.drivers.get(input.id) : await db.drivers.where('phone_key').equals(key).first();
  const row: Driver = { id: existing?.id ?? newId(), shop_id: shopId, name: input.name.trim(), phone: input.phone.trim(), phone_key: key, vehicle: input.vehicle ?? existing?.vehicle ?? null,
    active: input.active ?? existing?.active ?? true, available: input.available ?? existing?.available ?? true, notes: input.notes ?? existing?.notes ?? null, user_id: existing?.user_id ?? null,
    last_used_at: existing?.last_used_at ?? null, updated_at: new Date().toISOString() };
  await db.transaction('rw', [db.drivers, db.outbox], async () => {
    await db.drivers.put(row);
    await enqueue(db, 'driver.upsert', { id: row.id, name: row.name, phone: row.phone, vehicle: row.vehicle, notes: row.notes, ...(input.active !== undefined ? { active: row.active } : {}), ...(input.available !== undefined ? { available: row.available } : {}) });
  });
  return row;
}

/** International digits for wa.me / tel: links. */
export const waDigits = (p: string) => { const k = (p ?? '').replace(/\D/g, '').replace(/^00/, ''); return k.startsWith('961') ? k : '961' + k.replace(/^0/, ''); };
