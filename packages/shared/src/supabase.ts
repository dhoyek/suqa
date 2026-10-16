import { createClient, type SupabaseClient } from '@supabase/supabase-js';
/** All tables live in schema `suqa`; the client is pinned to it so queries read `.from('shops')`. */
export function createSuqaClient(url: string, anonKey: string, opts?: { storage?: any; persistSession?: boolean }): SupabaseClient {
  return createClient(url, anonKey, {
    db: { schema: 'suqa' },
    auth: { persistSession: opts?.persistSession ?? true, storage: opts?.storage, autoRefreshToken: true },
  });
}
