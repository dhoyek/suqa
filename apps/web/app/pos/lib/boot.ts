'use client';
import type { SupabaseClient } from '@supabase/supabase-js';
import { v7 as uuidv7 } from 'uuid';
import { META, PosDb, SupabaseTransport, SyncEngine, SyncError, getMeta, openPosDb, setMeta, type Shop, type SyncEvent } from '@suqa/pos-core';

// Boot sequence for a POS tab (PLAN §1.8):
//   session (cookie, works offline) → shop (localStorage) → device id (localStorage + meta) → open IndexedDB → engine.bootstrap (snapshot on first run)
// Everything that needs the network is attempted and, if it fails while local data exists, the POS still opens.

export const LS_SHOP = 'suqa-pos-shop';
export const lsDeviceKey = (shopId: string) => `suqa-pos-device-${shopId}`;
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev';

export type Membership = { shop_id: string; role: string; shop: { id: string; name: Record<string, string>; pos_enabled: boolean; tenant_id: string } };

export async function myMemberships(sb: SupabaseClient): Promise<Membership[]> {
  // memberships + (for platform admins / tenant members) every POS-enabled shop they administer — 25_pos_m6
  const { data, error } = await sb.rpc('pos_my_shops');
  if (error) throw new SyncError(/fetch|network/i.test(error.message) ? 'network' : 'server', error.message);
  return ((data as unknown as Membership[]) ?? []).filter(m => m.shop && m.shop.pos_enabled);
}

export type Booted = { db: PosDb; engine: SyncEngine; deviceId: string; shop: Shop; role: string; userId: string; firstRun: boolean };

export async function bootDevice(sb: SupabaseClient, shopId: string, userId: string, onEvent: (e: SyncEvent) => void, askDeviceName: () => Promise<string>): Promise<Booted> {
  const transport = new SupabaseTransport(sb);
  // ask the browser never to evict this origin's storage (unsynced sales live in IndexedDB until they reach the server)
  try { if (typeof navigator !== 'undefined' && navigator.storage?.persist) void navigator.storage.persist(); } catch { /* unsupported */ }
  const db = openPosDb(shopId);
  await db.open();
  let deviceId = localStorage.getItem(lsDeviceKey(shopId)) ?? (await getMeta<string>(db, META.deviceId)) ?? null;
  let firstRun = false;
  if (!deviceId) {
    // first time on this device: register online (name chosen by the user)
    deviceId = uuidv7();
    const name = await askDeviceName();
    const dev = await transport.register({ id: deviceId, shop_id: shopId, name, user_agent: navigator.userAgent.slice(0, 200), app_version: APP_VERSION });
    await setMeta(db, META.deviceId, deviceId); await setMeta(db, META.devicePrefix, dev.prefix); await setMeta(db, META.deviceName, dev.name);
    localStorage.setItem(lsDeviceKey(shopId), deviceId);
    firstRun = true;
  } else {
    await setMeta(db, META.deviceId, deviceId);
    localStorage.setItem(lsDeviceKey(shopId), deviceId);
  }
  await setMeta(db, META.userId, userId);
  const engine = new SyncEngine({ db, transport, deviceId, onEvent });
  const snap = await engine.bootstrap();          // throws SyncError('network') on first run offline → caller shows "needs internet"
  const shop = (await getMeta<Shop>(db, META.shop))!;
  const role = (await getMeta<string>(db, META.role)) ?? 'cashier';
  try { await navigator.storage?.persist?.(); } catch { /* ignore */ }
  return { db, engine, deviceId, shop, role, userId, firstRun: firstRun || snap };
}

/** Realtime poke: any sync_log insert for this shop wakes the engine (data always comes through pos_pull). */
export function subscribePoke(sb: SupabaseClient, shopId: string, engine: SyncEngine): () => void {
  const ch = sb.channel(`pos-sync-${shopId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'suqa', table: 'sync_log', filter: `shop_id=eq.${shopId}` }, () => engine.poke())
    .subscribe();
  return () => { void sb.removeChannel(ch); };
}

/** Save the unsynced outbox as a file when a device is revoked (nothing is silently lost). */
export function downloadJson(name: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
}

export const fmtTime = (iso: string | null | undefined, locale: 'ar' | 'en'): string =>
  iso ? new Intl.DateTimeFormat(locale === 'ar' ? 'ar-LB-u-nu-latn' : 'en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }).format(new Date(iso)) : '—';
