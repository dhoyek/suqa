import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    db: { schema: 'suqa' },
    cookies: {
      getAll: () => store.getAll(),
      setAll: (all: { name: string; value: string; options: CookieOptions }[]) => { try { all.forEach(({ name, value, options }) => store.set(name, value, options)); } catch {} },
    },
  });
}
