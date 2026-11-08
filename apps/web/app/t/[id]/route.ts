import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/server/supabase-admin';

// /t/<basket or order id> — tracking link used by WhatsApp template buttons: a basket goes to the customer's order page,
// a single (POS-typed) order to its public receipt.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params; const origin = new URL(_req.url).origin;
  const admin = supabaseAdmin();
  if (admin && /^[0-9a-f-]{36}$/i.test(id)) {
    const { data } = await admin.from('orders').select('id, basket_id').or(`id.eq.${id},basket_id.eq.${id}`).limit(1).maybeSingle();
    if (data?.basket_id) return NextResponse.redirect(`${origin}/orders/b/${data.basket_id}`, 302);
    if (data?.id) return NextResponse.redirect(`${origin}/r/${data.id}`, 302);
  }
  return NextResponse.redirect(`${origin}/orders`, 302);
}
