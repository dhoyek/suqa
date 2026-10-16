import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

// 1) Pass the Host down to server components (tenant resolution).
// 2) Refresh the Supabase session cookie on every request (required by @supabase/ssr).
export async function middleware(req: NextRequest) {
  let res = NextResponse.next({ request: req });
  res.headers.set('x-suqa-host', req.headers.get('host') ?? '');

  const sb = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    db: { schema: 'suqa' },
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (all: { name: string; value: string; options: CookieOptions }[]) => {
        all.forEach(({ name, value }) => req.cookies.set(name, value));
        res = NextResponse.next({ request: req });
        res.headers.set('x-suqa-host', req.headers.get('host') ?? '');
        all.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
      },
    },
  });
  // Touch the session so expired access tokens get refreshed.
  await sb.auth.getUser();
  return res;
}

export const config = { matcher: ['/((?!_next|favicon.ico|icons|manifest.webmanifest).*)'] };
