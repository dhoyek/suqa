import { NextResponse } from 'next/server';
import { getUser } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import { supabaseAdmin } from '@/lib/server/supabase-admin';
import { googleKey } from '@/lib/ai/google';
import { createCleanupBatch, getCleanupBatch } from '@/lib/ai/batch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// A PLATFORM ADMIN tries Google's batch mode (half price, answers later) for "remove background" on a few existing item
// photos — a test before bulk cleanup is built (Dan, 25 Nov 2026). Same rules as image-test: only photos already public in
// our own storage, results stored under media/tests/, nothing in the catalog touched, nothing counted against any cap.
//   POST { image_urls: [..1–5], model? }  → { batch: "batches/…" }
//   GET  ?batch=batches/…                  → state; once done, the cleaned pictures' addresses and the tokens each used
const MODELS = ['gemini-3.1-flash-lite-image', 'gemini-3.1-flash-image', 'gemini-nano-banana-2.1', 'gemini-3-pro-image'];
const ourPhoto = (u: string) => { try { const x = new URL(u); return x.protocol === 'https:' && x.hostname.endsWith('.supabase.co') && x.pathname.startsWith('/storage/v1/object/public/media/') ? x : null; } catch { return null; } };

async function gate() {
  const user = await getUser();
  if (!user) return { res: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  const sb = await supabaseServer();
  const { data: isAdmin } = await sb.rpc('is_platform_admin');
  if (isAdmin !== true) return { res: NextResponse.json({ error: 'forbidden' }, { status: 403 }) };
  const key = googleKey(); const admin = supabaseAdmin();
  if (!key || !admin) return { res: NextResponse.json({ error: 'no_key' }, { status: 409 }) };
  return { key, admin };
}

export async function POST(req: Request) {
  const g = await gate(); if ('res' in g) return g.res;
  const body = await req.json().catch(() => null) as { image_urls?: string[]; model?: string } | null;
  const model = MODELS.includes(body?.model ?? '') ? body!.model! : MODELS[0];
  const urls = (Array.isArray(body?.image_urls) ? body!.image_urls : []).map(ourPhoto);
  if (!urls.length || urls.length > 5 || urls.some(u => !u)) return NextResponse.json({ error: 'bad_request', hint: '1–5 photo addresses from our own media storage' }, { status: 400 });
  try {
    const photos = await Promise.all(urls.map(async (u, i) => {
      const got = await fetch(u!, { signal: AbortSignal.timeout(15_000) });
      if (!got.ok) throw new Error(`image_unavailable_${i + 1}`);
      const image = new Uint8Array(await got.arrayBuffer());
      if (image.length > 3 * 1024 * 1024) throw new Error(`too_big_${i + 1}`);
      return { key: `p${i + 1}`, image, mime: got.headers.get('content-type') || 'image/jpeg' };
    }));
    const batch = await createCleanupBatch({ key: g.key, model, photos, name: `suqa-cleanup-test-${Date.now()}` });
    return NextResponse.json({ status: 'sent', batch, model, photos: photos.map(p => ({ key: p.key, bytes: p.image.length })) });
  } catch (e) {
    return NextResponse.json({ status: 'failed', model, error: String((e as Error).message ?? e).slice(0, 500) });
  }
}

export async function GET(req: Request) {
  const g = await gate(); if ('res' in g) return g.res;
  const name = new URL(req.url).searchParams.get('batch') ?? '';
  try {
    const b = await getCleanupBatch({ key: g.key, name });
    if (!b.done) return NextResponse.json({ status: 'waiting', state: b.state });
    const stamp = name.replace(/\W/g, '-');
    const items = await Promise.all(b.items.map(async it => {
      if (!it.image) return { key: it.key, error: it.error, input_tokens: it.input_tokens, output_tokens: it.output_tokens };
      const path = `tests/${stamp}-${it.key}.${it.image.mime.includes('png') ? 'png' : 'jpg'}`;
      const up = await g.admin.storage.from('media').upload(path, it.image.data, { contentType: it.image.mime, upsert: true });
      return { key: it.key, url: up.error ? null : g.admin.storage.from('media').getPublicUrl(path).data.publicUrl, store_error: up.error?.message?.slice(0, 120), input_tokens: it.input_tokens, output_tokens: it.output_tokens };
    }));
    return NextResponse.json({ status: 'done', state: b.state, items });
  } catch (e) {
    return NextResponse.json({ status: 'failed', error: String((e as Error).message ?? e).slice(0, 500) });
  }
}
