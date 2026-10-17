import { getTenant } from '@/lib/tenant';
import { getTenantRole } from '@/lib/admin';
import { ui } from '@/lib/ui-text';
import SettingsForm from './SettingsForm';

export const dynamic = 'force-dynamic';

export default async function AdminSettings() {
  const tenant = await getTenant();
  const role = await getTenantRole(tenant.id);
  const L = tenant.default_locale;
  const keys = ['settings', 'brandName', 'fxRate', 'displayCurrencyLabel', 'defaultCommission', 'supportPhone', 'whatsapp', 'primaryColor', 'accentColor', 'save', 'saved', 'notAllowed'] as const;
  const labels = Object.fromEntries(keys.map(k => [k, ui(k, L)])) as Record<typeof keys[number], string>;
  return <SettingsForm tenant={tenant} canEdit={role === 'admin'} labels={labels} />;
}
