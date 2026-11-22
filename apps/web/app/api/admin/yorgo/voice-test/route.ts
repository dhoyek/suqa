import { NextResponse } from 'next/server';
import { getUser } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import { ROUTE_COLUMNS, toRoute } from '@/lib/ai/routes';
import { googleKey } from '@/lib/ai/google';
import { oggSeconds, runVoice, VOICE_MAX_BYTES } from '@/lib/ai/voice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST multipart { file } — the platform admin tries the 'voice' route on a short clip: the words, the time it took, what it cost.
// Works while the route is still off (that is the point: try it, then switch it on). The clip is read in memory and dropped;
// nothing is stored and nothing is counted against a market's caps. The route is read with the caller's own access, so only a
// platform admin gets one (script 100).
export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const sb = await supabaseServer();
  const { data: isAdmin } = await sb.rpc('is_platform_admin');
  if (isAdmin !== true) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const { data: row } = await sb.from('yorgo_ai_routes').select(ROUTE_COLUMNS).eq('task', 'voice').maybeSingle();
  if (!row) return NextResponse.json({ error: 'no_route' }, { status: 404 });
  const key = googleKey();
  if (!key) return NextResponse.json({ error: 'no_key' }, { status: 409 });
  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof Blob) || !file.size) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  if (file.size > VOICE_MAX_BYTES) return NextResponse.json({ status: 'too_long' });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const route = toRoute(row as Record<string, unknown>);
  const r = await runVoice(route, key, bytes, file.type || 'audio/ogg');
  const secs = oggSeconds(bytes);
  return NextResponse.json({ ...r, seconds: secs == null ? null : Math.round(secs * 10) / 10, priced: route.price_out_per_m != null && (route.price_audio_per_m != null || route.price_in_per_m != null) });
}
