import { createClient, type SupabaseClient } from '@supabase/supabase-js';
/** A Supabase client pinned to the `suqa` schema (schema generics left loose until db:types is generated). */
export type SuqaClient = SupabaseClient<any, any, any>;
/** All tables live in schema `suqa`; the client is pinned to it so queries read `.from('shops')`. */
export function createSuqaClient(url: string, anonKey: string, opts?: { storage?: any; persistSession?: boolean }): SuqaClient {
  return createClient(url, anonKey, {
    db: { schema: 'suqa' },
    auth: { persistSession: opts?.persistSession ?? true, storage: opts?.storage, autoRefreshToken: true },
  }) as SuqaClient;
}
