import { NextResponse } from 'next/server';
import { getTenant } from '@/lib/tenant';
import { getUser } from '@/lib/auth';
import { getTenantRole } from '@/lib/admin';
import { supabaseAdmin } from '@/lib/server/supabase-admin';

export const dynamic = 'force-dynamic';

/**
 * Admin-only credential management for one account (things SQL cannot do safely):
 *   POST { email }            set / change the sign-in email (confirmed immediately; the person can then use email + password)
 *   POST { password }         set a password (for staff who use a laptop); shown once to the admin, never stored in clear
 *   POST { reset: true }      send a password-reset email to the account's address
 * Every call is audit-logged (account.credentials).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const tenant = await getTenant(); const me = await getUser();
  if (!me || (await getTenantRole(tenant.id)) !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const admin = supabaseAdmin(); if (!admin) return NextResponse.json({ error: 'service_role_missing' }, { status: 500 });
  // only accounts of this association (same rule as the Accounts list)
  const { data: inTenant } = await admin.rpc('_account_in_tenant', { p_tenant: tenant.id, p_user: id });   // internal helper: service key only (schema 58)
  if (!inTenant) return NextResponse.json({ error: 'not_in_tenant' }, { status: 404 });
  const body = await req.json().catch(() => ({})) as { email?: string; password?: string; reset?: boolean };
  const did: string[] = [];
  if (body.email !== undefined) {
    const email = String(body.email).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return NextResponse.json({ error: 'bad_email' }, { status: 400 });
    const { error } = await admin.auth.admin.updateUserById(id, { email, email_confirm: true });
    if (error) return NextResponse.json({ error: /already|exists|registered/i.test(error.message) ? 'email_taken' : error.message }, { status: 400 });
    did.push('email');
  }
  if (body.password) {
    if (String(body.password).length < 8) return NextResponse.json({ error: 'password_short' }, { status: 400 });
    const { error } = await admin.auth.admin.updateUserById(id, { password: String(body.password) });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    did.push('password');
  }
  if (body.reset) {
    const { data: u } = await admin.auth.admin.getUserById(id);
    if (!u.user?.email) return NextResponse.json({ error: 'no_email' }, { status: 400 });
    const origin = `https://${req.headers.get('x-forwarded-host') ?? new URL(req.url).host}`;
    const { error } = await admin.auth.resetPasswordForEmail(u.user.email, { redirectTo: `${origin}/auth/callback?next=/account` });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    did.push('reset');
  }
  if (did.length) await admin.from('audit_log').insert({ shop_id: '00000000-0000-0000-0000-000000000000', tenant_id: tenant.id, user_id: me.id, action: 'account.credentials', ref_tbl: 'auth.users', ref_id: id, after: { did }, acting_as_admin: true });
  return NextResponse.json({ ok: true, did });
}
