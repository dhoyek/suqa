import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import { getTenantRole } from '@/lib/admin';
import { ui, STATUS_LABEL } from '@/lib/ui-text';
import SettingsForm from './SettingsForm';
import WhatsAppSetup from './WhatsAppSetup';
import { waConfigured } from '@/lib/server/whatsapp';

export const dynamic = 'force-dynamic';

export default async function AdminSettings() {
  const base = await getTenant();
  // the commission is not part of what visitors read of the association (114): the signed-in admin reads it here
  const { data: own } = await (await supabaseServer()).from('tenants').select('commission_rate').eq('id', base.id).maybeSingle();
  const tenant = { ...base, commission_rate: Number((own as { commission_rate?: number | string } | null)?.commission_rate ?? 0) };
  const role = await getTenantRole(tenant.id);
  const L = tenant.default_locale;
  const keys = ['settings', 'brandName', 'fxRate', 'displayCurrencyLabel', 'defaultCommission', 'supportPhone', 'whatsapp', 'primaryColor', 'accentColor', 'save', 'saved', 'notAllowed', 'multiShopCart', 'deliveryMode', 'perShopDelivery', 'courierDelivery', 'courierFee', 'couriersEnabled', 'legalOperator', 'legalEmail', 'legalSection', 'waTestSection', 'waTestPhone', 'waTestSend', 'waTestSent', 'maxOpenOrders', 'notifyStages'] as const;
  const labels = Object.fromEntries(keys.map(k => [k, ui(k, L)])) as Record<typeof keys[number], string>;
  return <><SettingsForm tenant={tenant} canEdit={role === 'admin'} labels={labels} waConfigured={waConfigured()} statusLabels={Object.fromEntries(Object.entries(STATUS_LABEL).map(([k, v]) => [k, (v as any)[L] ?? v.en]))} />{role === 'admin' && <WhatsAppSetup ar={L === 'ar'} />}</>;
}
