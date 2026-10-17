import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

// 1) Pass the Host down to server components as a *request* header (tenant resolution).
// 2) Keep the Supabase session fresh. Fast paths: anonymous visitors (no auth cookie) skip Supabase
//    entirely; signed-in users get a local JWT check (getClaims) — it only talks to Supabase when the
//    access token has expired and needs a refresh.
export async function middleware(req: NextRequest) {
  const reqHeaders = new Headers(req.headers);
  reqHeaders.set('x-suqa-host', req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '');
  let res = NextResponse.next({ request: { headers: reqHeaders } });

  const hasAuthCookie = req.cookies.getAll().some(c => c.name.startsWith('sb-') && c.name.includes('-auth-token'));
  if (!hasAuthCookie) return res;

  const sb = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    db: { schema: 'suqa' },
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (all: { name: string; value: string; options: CookieOptions }[]) => {
        all.forEach(({ name, value }) => req.cookies.set(name, value));
        res = NextResponse.next({ request: { headers: reqHeaders } });
        all.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
      },
    },
  });
  await sb.auth.getClaims();   // refreshes the cookie if the token expired; otherwise verifies locally
  return res;
}

export const config = { matcher: ['/((?!_next|favicon.ico|icons|manifest.webmanifest).*)'] };
