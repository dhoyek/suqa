import { NextResponse } from 'next/server';
import { getUser } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import { supabaseAdmin } from '@/lib/server/supabase-admin';
import { googleCleanImage, googleKey } from '@/lib/ai/google';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST { image_url, model } — a PLATFORM ADMIN tries an image model on one existing item photo: background and shadows removed.
// A quality test before the feature is built (Dan, 24 Nov 2026): the result is stored under media/tests/ and its address is
// returned with what the call used, so the two pictures can be looked at side by side. Nothing in the catalog is touched and
// nothing is counted against a market's caps. Only photos already public in our own storage can be sent.
const MODELS = ['gemini-nano-banana-2.1', 'gemini-3.1-flash-lite-image', 'gemini-3.1-flash-image', 'gemini-3-pro-image'];
export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const sb = await supabaseServer();
  const { data: isAdmin } = await sb.rpc('is_platform_admin');
  if (isAdmin !== true) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const key = googleKey(); const admin = supabaseAdmin();
  if (!key || !admin) return NextResponse.json({ error: 'no_key' }, { status: 409 });
  const body = await req.json().catch(() => null) as { image_url?: string; model?: string } | null;
  const model = MODELS.includes(body?.model ?? '') ? body!.model! : null;
  let src: URL | null = null; try { src = new URL(body?.image_url ?? ''); } catch { src = null; }
  if (!model || !src || src.protocol !== 'https:' || !src.hostname.endsWith('.supabase.co') || !src.pathname.startsWith('/storage/v1/object/public/media/')) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  const t0 = Date.now();
  try {
    const got = await fetch(src, { signal: AbortSignal.timeout(15_000) });
    if (!got.ok) return NextResponse.json({ error: 'image_unavailable' }, { status: 400 });
    const bytes = new Uint8Array(await got.arrayBuffer());
    if (bytes.length > 4 * 1024 * 1024) return NextResponse.json({ error: 'too_big' }, { status: 400 });
    const out = await googleCleanImage({ key, model, image: bytes, mime: got.headers.get('content-type') || 'image/jpeg' });
    const ext = out.mime.includes('png') ? 'png' : 'jpg';
    const path = `tests/enhance-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
    const up = await admin.storage.from('media').upload(path, out.image, { contentType: out.mime, upsert: false });
    if (up.error) return NextResponse.json({ error: 'store_failed', detail: up.error.message.slice(0, 120) }, { status: 500 });
    return NextResponse.json({ status: 'ok', model, url: admin.storage.from('media').getPublicUrl(path).data.publicUrl, bytes_in: bytes.length, bytes_out: out.image.length, ...out.usage, ms: Date.now() - t0 });
  } catch (e) {
    return NextResponse.json({ status: 'failed', model, error: String((e as Error).message ?? e).slice(0, 300), ms: Date.now() - t0 });
  }
}
