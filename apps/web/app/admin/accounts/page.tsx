import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import { getLocale } from '@/lib/locale';
import { getTenantRole } from '@/lib/admin';
import { ui } from '@/lib/ui-text';
import AccountsList, { type Account, type ShopBrief } from './AccountsList';

export const dynamic = 'force-dynamic';

/** Every signed-in account that has touched this association — admins, shop staff, drivers, couriers, customers —
 *  with what each one is. The single place to answer "does this person have an account, and what can they do?". */
export default async function AdminAccounts() {
  const tenant = await getTenant();
  const sb = await supabaseServer();
  const L = await getLocale(tenant);
  const role = await getTenantRole(tenant.id);
  const { data, error } = await sb.rpc('tenant_accounts', { p_tenant: tenant.id });
  const { data: shops } = await sb.rpc('tenant_shops_brief', { p_tenant: tenant.id });
  if (error) return <div className="card bad">{error.message}</div>;
  return <AccountsList initial={(data as Account[]) ?? []} locale={L} tenantId={tenant.id} canEdit={role === 'admin'} shops={(shops as ShopBrief[]) ?? []}
    labels={{ accounts: ui('accounts', L), search: ui('searchAccounts', L), all: ui('all', L), admins: ui('admins', L), staff: ui('staffRole', L), drivers: ui('drivers', L), customers: ui('customers', L),
      lastSeen: ui('lastSeen', L), orders: ui('orders', L), pending: ui('accessPending', L), noRole: ui('customerOnly', L), count: ui('accountsCount', L), edit: ui('editAccount', L), name: ui('fullName', L), phone: ui('phone', L), save: ui('save', L), cancel: ui('cancel', L), phoneTaken: ui('phoneTaken', L), saved: ui('saved', L),
      roles: ui('roles', L), assocRole: ui('assocRole', L), none: ui('none', L), tenantAdmin: ui('tenantAdmin', L), tenantOps: ui('tenantOps', L), block: ui('block', L), unblock: ui('unblock', L), blocked: ui('blocked', L), deleted: ui('deleted', L),
      delete: ui('deleteAccount', L), merge: ui('merge', L), mergeInto: ui('mergeInto', L), confirmDelete: ui('confirmDelete', L), confirmMerge: ui('confirmMerge', L), confirmBlock: ui('confirmBlock', L),
      roleOwner: ui('roleOwner', L), roleCashier: ui('roleCashier', L), roleStock: ui('roleStock', L), shopRoles: ui('shopRoles', L), mergeHint: ui('mergeHint', L), deleteHint: ui('deleteHint', L) }} />;
}
