import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/server/supabase-admin';

// POST /api/d/<order id>/ack — the "✅ استلمت الطلب" button on the driver's sheet. Public by unguessable order id, like the sheet itself;
// the database only accepts it for an order that has a shop driver and is still open (52_driver_ack). Back to the sheet afterwards.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params; const origin = new URL(req.url).origin;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'bad_id' }, { status: 400 });
  const admin = supabaseAdmin(); if (!admin) return NextResponse.json({ error: 'not_configured' }, { status: 500 });
  const { error } = await admin.rpc('driver_ack', { p_order: id, p_via: 'sheet' });
  if (error) console.error('[driver ack]', id, error.message);
  return NextResponse.redirect(`${origin}/d/${id}${error ? '?ack=err' : '?ack=1'}`, 303);
}
