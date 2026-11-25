import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import { getLocale } from '@/lib/locale';
import { getTenantRole } from '@/lib/admin';
import DriversList, { type DriverRow, type CourierRow } from './DriversList';

export const dynamic = 'force-dynamic';

/** Every driver of every shop, and who is shared with the whole association (schema 116). No money here: what a shop pays
 *  its driver and their settlements stay in the shop. */
export default async function AdminDrivers() {
  const tenant = await getTenant();
  const sb = await supabaseServer();
  const L = await getLocale(tenant);
  const role = await getTenantRole(tenant.id);
  const { data, error } = await sb.rpc('admin_drivers', { p_tenant: tenant.id });
  if (error) {
    const missing = /admin_drivers|schema cache|PGRST202/i.test(`${error.code ?? ''} ${error.message}`);
    return <div className="card bad">{missing ? (L === 'ar' ? 'هذه الصفحة غير مفعّلة بعد (السكريبت 116).' : 'This page is not switched on yet (script 116).') : error.message}</div>;
  }
  const d = (data ?? {}) as { drivers?: DriverRow[]; couriers?: CourierRow[] };
  return <DriversList initial={d.drivers ?? []} couriers={d.couriers ?? []} locale={L} canEdit={role === 'admin'} />;
}
