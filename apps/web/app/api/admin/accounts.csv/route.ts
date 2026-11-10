import { NextResponse } from 'next/server';
import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import { getTenantRole } from '@/lib/admin';

export const dynamic = 'force-dynamic';

/** Admin → Accounts → ⬇ CSV. Admin-only (the RPC enforces it too). UTF-8 with BOM so Excel opens Arabic correctly. */
export async function GET() {
  const tenant = await getTenant();
  if ((await getTenantRole(tenant.id)) !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const sb = await supabaseServer();
  const { data, error } = await sb.rpc('tenant_accounts_export', { p_tenant: tenant.id });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  const rows = (data as Record<string, unknown>[]) ?? [];
  const cols = ['name', 'phone', 'email', 'created_at', 'last_sign_in_at', 'tenant_role', 'shop_roles', 'driver_for', 'courier', 'orders', 'blocked', 'deleted'];
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = '﻿' + [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\r\n');
  return new NextResponse(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="accounts-${new Date().toISOString().slice(0, 10)}.csv"` } });
}
