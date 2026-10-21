import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Service-role client for server-only paths (webhooks). Bypasses RLS — never import from client components.
let cached: SupabaseClient<any, 'suqa', any> | null = null;
export function supabaseAdmin(): SupabaseClient<any, 'suqa', any> | null {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  if (!cached) cached = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, { db: { schema: 'suqa' }, auth: { persistSession: false, autoRefreshToken: false } });
  return cached;
}
