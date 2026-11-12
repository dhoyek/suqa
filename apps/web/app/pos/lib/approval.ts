import type { SupabaseClient } from '@supabase/supabase-js';
import { getMeta, setMeta, META, type ApprovalPin, type PosDb } from '@suqa/pos-core';

// The shop's approval PIN (hash + salt) on this device. Kept in the local database so approvals work offline, and re-read from
// the server whenever the till is online (start, back online, and right before an approval prompt checks a PIN) so a change
// made on another device takes effect at once. null = the shop has none → the owner's login PIN approves, as before.
let ctx: { sb: SupabaseClient; db: PosDb; shopId: string } | null = null;
let current: ApprovalPin = null;
const subs = new Set<() => void>();
const set = (v: ApprovalPin) => { current = v; subs.forEach(f => f()); };

export function onApprovalChange(f: () => void): () => void { subs.add(f); return () => { subs.delete(f); }; }
export const getApproval = (): ApprovalPin => current;

export async function initApproval(sb: SupabaseClient, db: PosDb, shopId: string): Promise<void> {
  ctx = { sb, db, shopId };
  set(((await getMeta<ApprovalPin>(db, META.approvalPin)) ?? null));
  void refreshApproval();
}

/** Ask the server; on any failure (offline, not installed yet) keep what the device already has. */
export async function refreshApproval(): Promise<ApprovalPin> {
  if (!ctx) return current;
  try {
    const { data, error } = await ctx.sb.rpc('pos_approval_pin', { p_shop: ctx.shopId });
    if (error) return current;
    const v = (data && (data as { hash?: string }).hash ? data : null) as ApprovalPin;
    await setMeta(ctx.db, META.approvalPin, v);
    set(v);
  } catch { /* offline */ }
  return current;
}

/** The freshest copy available within `ms` — a prompt must not hang on a slow connection. */
export function freshApproval(ms = 1500): Promise<ApprovalPin> {
  return Promise.race([refreshApproval(), new Promise<ApprovalPin>(r => setTimeout(() => r(current), ms))]);
}

/** After the owner sets / removes it on this device. */
export async function storeApproval(v: ApprovalPin): Promise<void> { if (ctx) await setMeta(ctx.db, META.approvalPin, v); set(v); }
