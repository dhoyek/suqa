import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import { getTenantRole } from '@/lib/admin';
import { ui } from '@/lib/ui-text';
import { t as tr, type Shop } from '@suqa/shared';
import MembersList from './MembersList';
import CouriersList from './CouriersList';

export const dynamic = 'force-dynamic';

export default async function AdminMembers() {
  const tenant = await getTenant();
  const sb = await supabaseServer();
  const L = tenant.default_locale;
  const role = await getTenantRole(tenant.id);
  const [{ data: people }, { data: shops }, { data: couriers }] = await Promise.all([sb.rpc('tenant_people', { p_tenant: tenant.id }), sb.from('shops').select('id,name').eq('tenant_id', tenant.id),
    tenant.settings.courier_enabled ? sb.rpc('tenant_couriers', { p_tenant: tenant.id }) : Promise.resolve({ data: null })]);
  const shopName = Object.fromEntries(((shops as Shop[]) ?? []).map(s => [s.id, tr(s.name, L)]));
  const rows = ((people as any[]) ?? []).map(p => ({ ...p, shop_name: p.shop_id ? shopName[p.shop_id] : null }));
  return (
    <div className="stack">
      <MembersList tenantId={tenant.id} canEdit={role === 'admin'} initial={rows} labels={{ members: ui('members', L), addByEmail: ui('addByEmail', L), userNotFound: ui('userNotFound', L), tenantAdmin: ui('tenantAdmin', L), tenantOps: ui('tenantOps', L), owner: ui('owner', L), staff: ui('staff', L), remove: ui('remove', L) }} />
      {tenant.settings.courier_enabled && <CouriersList tenantId={tenant.id} canEdit={role === 'admin'} initial={(couriers as any[]) ?? []} locale={L}
        labels={{ couriers: ui('couriers', L), addByEmail: ui('addByEmail', L), userNotFound: ui('userNotFound', L), remove: ui('remove', L), active: ui('active', L), activeDeliveries: ui('activeDeliveries', L) }} />}
    </div>
  );
}
