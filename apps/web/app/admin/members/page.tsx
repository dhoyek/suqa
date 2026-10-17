import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import { getTenantRole } from '@/lib/admin';
import { ui } from '@/lib/ui-text';
import { t as tr, type Shop } from '@suqa/shared';
import MembersList from './MembersList';

export const dynamic = 'force-dynamic';

export default async function AdminMembers() {
  const tenant = await getTenant();
  const sb = await supabaseServer();
  const L = tenant.default_locale;
  const role = await getTenantRole(tenant.id);
  const [{ data: people }, { data: shops }] = await Promise.all([sb.rpc('tenant_people', { p_tenant: tenant.id }), sb.from('shops').select('id,name').eq('tenant_id', tenant.id)]);
  const shopName = Object.fromEntries(((shops as Shop[]) ?? []).map(s => [s.id, tr(s.name, L)]));
  const rows = ((people as any[]) ?? []).map(p => ({ ...p, shop_name: p.shop_id ? shopName[p.shop_id] : null }));
  return <MembersList tenantId={tenant.id} canEdit={role === 'admin'} initial={rows} labels={{ members: ui('members', L), addByEmail: ui('addByEmail', L), userNotFound: ui('userNotFound', L), tenantAdmin: ui('tenantAdmin', L), tenantOps: ui('tenantOps', L), owner: ui('owner', L), staff: ui('staff', L), remove: ui('remove', L) }} />;
}
