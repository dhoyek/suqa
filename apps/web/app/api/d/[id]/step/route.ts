import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/server/supabase-admin';

// POST /api/d/<order id>/step  (form fields "s" = picked | delivered, "pay" = JSON from the pay screen) — the driver's "📦 استلمت من المحل" / "🏠 سلّمت الطلب" buttons.
// Public by unguessable order id like the sheet; the database only records times on an open order with a shop driver (53_driver_steps).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params; const origin = `https://${req.headers.get('x-forwarded-host') ?? new URL(req.url).host}`;   // the host the visitor used, not the deploy's own
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'bad_id' }, { status: 400 });
  const form = await req.formData().catch(() => null);
  const step = String(form?.get('s') ?? '');
  if (!['picked', 'delivered'].includes(step)) return NextResponse.redirect(`${origin}/d/${id}`, 303);
  // "delivered" is final (81) and carries what the customer paid, from the driver's pay screen: whole, non-negative numbers only
  let pay: Record<string, number> | null = null;
  if (step === 'delivered') {
    try {
      const raw = JSON.parse(String(form?.get('pay') ?? 'null')) as Record<string, unknown> | null;
      if (raw && typeof raw === 'object') { pay = {}; for (const k of ['usd', 'lbp', 'change_usd', 'change_lbp', 'wallet', 'unpaid']) { const n = Math.round(Number(raw[k] ?? 0)); pay[k] = Number.isFinite(n) && n > 0 && n < 1e12 ? n : 0; } }
    } catch { pay = null; }
  }
  const admin = supabaseAdmin(); if (!admin) return NextResponse.json({ error: 'not_configured' }, { status: 500 });
  const { data, error } = await admin.rpc('driver_step', { p_order: id, p_step: step, p_pay: pay });
  if (error) console.error('[driver step]', id, step, error.message);
  const ok = !error && (data as { ok?: boolean } | null)?.ok !== false;
  const why = error ? (['pay_required', 'not_covered', 'too_much', 'bad_amount', 'over_credit_limit', 'debt_needs_customer'].find(c => error.message.includes(c)) ?? '') : '';
  return NextResponse.redirect(`${origin}/d/${id}${ok ? '' : `?ack=err${why ? `&why=${why}` : ''}`}`, 303);
}
