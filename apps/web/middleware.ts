import { NextResponse, type NextRequest } from 'next/server';
// Tenant resolution happens per request from the Host header. We pass the host down as a
// header so server components can resolve the tenant (cached) without re-reading the request.
export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  res.headers.set('x-suqa-host', req.headers.get('host') ?? '');
  return res;
}
export const config = { matcher: ['/((?!_next|favicon.ico|icons|manifest.webmanifest).*)'] };
