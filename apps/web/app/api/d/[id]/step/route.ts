import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/server/supabase-admin';

// POST /api/d/<order id>/step  (form field "s" = picked | delivered) — the driver's "📦 استلمت من المحل" / "🏠 سلّمت الطلب" buttons.
// Public by unguessable order id like the sheet; the database only records times on an open order with a shop driver (53_driver_steps).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params; const origin = new URL(req.url).origin;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'bad_id' }, { status: 400 });
  const step = String((await req.formData().catch(() => null))?.get('s') ?? '');
  if (!['picked', 'delivered'].includes(step)) return NextResponse.redirect(`${origin}/d/${id}`, 303);
  const admin = supabaseAdmin(); if (!admin) return NextResponse.json({ error: 'not_configured' }, { status: 500 });
  const { data, error } = await admin.rpc('driver_step', { p_order: id, p_step: step });
  if (error) console.error('[driver step]', id, step, error.message);
  const ok = !error && (data as { ok?: boolean } | null)?.ok !== false;
  return NextResponse.redirect(`${origin}/d/${id}${ok ? '' : '?ack=err'}`, 303);
}
