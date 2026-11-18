import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

/** 👍 / 👎 on one of Yorgo's answers. Runs as the person: the database only accepts it for an answer in their own conversation. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { message_id?: number; value?: number | null; note?: string } | null;
  if (!body || !Number.isInteger(body.message_id) || ![1, -1, null].includes(body.value ?? null)) return NextResponse.json({ ok: false }, { status: 400 });
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });
  const { error } = await sb.rpc('yorgo_feedback', { p_message: body.message_id, p_value: body.value ?? null, p_note: typeof body.note === 'string' ? body.note.slice(0, 500) : null });
  return NextResponse.json({ ok: !error }, { status: error ? 400 : 200 });
}
