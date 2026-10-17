import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { safeNext } from '@/lib/safe-next';
import { getTenantOrNull } from '@/lib/tenant';

// OAuth (Google / Facebook / Apple) lands here with ?code=…; exchange it for a session cookie,
// attach first-time users to the current tenant, then continue to ?next=.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const next = safeNext(url.searchParams.get('next'), '/');
  if (code) {
    const sb = await supabaseServer();
    const { data, error } = await sb.auth.exchangeCodeForSession(code);
    if (!error && data.user) {
      const tenant = await getTenantOrNull();
      const { data: prof } = await sb.from('profiles').select('home_tenant_id, full_name').eq('id', data.user.id).maybeSingle();
      const meta = data.user.user_metadata ?? {};
      const patch: Record<string, unknown> = {};
      if (tenant && !(prof as any)?.home_tenant_id) patch.home_tenant_id = tenant.id;
      if (!(prof as any)?.full_name && (meta.full_name || meta.name)) patch.full_name = meta.full_name || meta.name;
      if (Object.keys(patch).length) await sb.from('profiles').update(patch).eq('id', data.user.id);
      return NextResponse.redirect(new URL(next, url.origin), { status: 303 });
    }
  }
  return NextResponse.redirect(new URL(`/login?error=oauth&next=${encodeURIComponent(next)}`, url.origin), { status: 303 });
}
