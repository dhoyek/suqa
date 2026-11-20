'use client';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * 🔔 This device gets a notification for every new online order of the shop, even with the POS closed (85_push_notifications).
 * Uses the POS service worker (/pos scope). iPhone: only once the POS is added to the home screen (iOS 16.4+).
 */
export type PushState = 'unsupported' | 'off' | 'on' | 'blocked' | 'not_set_up' | 'ios_home';

const b64 = (s: string) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...raw].map(c => c.charCodeAt(0))); };
const reg = async () => (await navigator.serviceWorker.getRegistration('/pos')) ?? null;

export async function pushState(): Promise<PushState> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) && !(navigator as unknown as { standalone?: boolean }).standalone;
    return ios ? 'ios_home' : 'unsupported';
  }
  if (Notification.permission === 'denied') return 'blocked';
  const r = await reg(); const sub = await r?.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}

export async function pushEnable(sb: SupabaseClient, shopId: string, label: string): Promise<PushState> {
  const { key } = await fetch('/api/push/key', { cache: 'no-store' }).then(r => r.json()) as { key: string | null };
  if (!key) return 'not_set_up';
  const perm = await Notification.requestPermission(); if (perm !== 'granted') return perm === 'denied' ? 'blocked' : 'off';
  const r = await reg(); if (!r) return 'unsupported';
  const sub = (await r.pushManager.getSubscription()) ?? await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
  const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  const { error } = await sb.rpc('push_subscribe', { p_shop: shopId, p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_label: label });
  if (error) { await sub.unsubscribe().catch(() => {}); throw new Error(error.message); }
  return 'on';
}

export async function pushDisable(sb: SupabaseClient): Promise<PushState> {
  const r = await reg(); const sub = await r?.pushManager.getSubscription();
  if (sub) { await sb.rpc('push_unsubscribe', { p_endpoint: sub.endpoint }); await sub.unsubscribe().catch(() => {}); }
  return 'off';
}
