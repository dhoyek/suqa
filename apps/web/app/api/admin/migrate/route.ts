import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from '@/lib/server/supabase-admin';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Operator-only import endpoint for migration/convert.py (x-suqa-secret = SUQA_EVENTS_SECRET).
//   POST { shop: "<slug>", kind, rows: [...], dry_run?: true }   → suqa.migrate_apply
//   GET  ?shop=<slug>                                             → suqa.migrate_status
function authorized(req: Request) {
  const want = process.env.SUQA_EVENTS_SECRET, got = req.headers.get('x-suqa-secret');
  return !!want && !!got && want.length === got.length && timingSafeEqual(Buffer.from(want), Buffer.from(got));
}
async function shopId(slug: string) {
  const admin = supabaseAdmin(); if (!admin) throw new Error('no_service_role');
  const { data, error } = await admin.from('shops').select('id').eq('slug', slug).maybeSingle();
  if (error) throw new Error(error.message); if (!data) throw new Error('shop_not_found');
  return { admin, id: data.id as string };
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const slug = new URL(req.url).searchParams.get('shop') ?? '';
    const { admin, id } = await shopId(slug);
    const { data, error } = await admin.rpc('migrate_status', { p_shop: id });
    if (error) throw new Error(error.message);
    return NextResponse.json({ shop: slug, imported: data });
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const body = await req.json() as { shop: string; kind: string; rows: unknown[]; dry_run?: boolean };
    if (!Array.isArray(body.rows) || body.rows.length > 2000) return NextResponse.json({ error: 'rows must be an array of ≤ 2000' }, { status: 400 });
    const { admin, id } = await shopId(body.shop);
    const { data, error } = await admin.rpc('migrate_apply', { p_shop: id, p_kind: body.kind, p_rows: body.rows, p_dry: !!body.dry_run });
    if (error) {
      if (error.message === 'dry_run') return NextResponse.json({ dry_run: true, ...(JSON.parse(error.details || '{}') as object) });
      throw new Error(error.message);
    }
    return NextResponse.json(data);
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
}
