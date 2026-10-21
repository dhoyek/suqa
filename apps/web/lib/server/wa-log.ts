import 'server-only';
import { supabaseAdmin } from './supabase-admin';

export type Party = 'customer' | 'shop' | 'courier' | 'unknown';

/** Record a message in suqa.wa_messages (no-op without the service role key). */
export async function logWaMessage(row: { wamid: string; order_id?: string | null; tenant_id?: string | null; direction: 'in' | 'out'; party: Party; phone: string; phone_number_id?: string | null; body?: string | null; status?: string | null; error?: string | null }) {
  const sb = supabaseAdmin(); if (!sb) return;
  const { error } = await sb.from('wa_messages').upsert(row, { onConflict: 'wamid' });
  if (error) console.error('[wa log]', error.message);
}
