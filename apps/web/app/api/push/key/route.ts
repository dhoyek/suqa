import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** The site's public push key (safe to give out), read at run time so it can be set without a rebuild. Empty = push is off. */
export function GET() {
  return NextResponse.json({ key: process.env.VAPID_PUBLIC_KEY ?? null }, { headers: { 'cache-control': 'no-store' } });
}
