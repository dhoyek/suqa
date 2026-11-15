import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/server/supabase-admin';

// POST /api/r/<order id>/coming — the "🚶 I'm on my way" button on a pickup customer's order page.
// Public by unguessable order id, like the page itself; the database only records it once, on an open pickup order
// (67_pickup_coming_driver_onroad), and tells the shop. The order status does not move. Back to the page afterwards.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params; const origin = `https://${req.headers.get('x-forwarded-host') ?? new URL(req.url).host}`;   // the host the visitor used, not the deploy's own
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'bad_id' }, { status: 400 });
  const admin = supabaseAdmin(); if (!admin) return NextResponse.json({ error: 'not_configured' }, { status: 500 });
  const { data, error } = await admin.rpc('customer_coming', { p_order: id });
  if (error) console.error('[customer coming]', id, error.message);
  const ok = !error && (data as { ok?: boolean } | null)?.ok !== false;
  return NextResponse.redirect(`${origin}/r/${id}${ok ? '' : '?coming=err'}`, 303);
}
