import { getTenant } from '@/lib/tenant';
import { getLocale } from '@/lib/locale';
import { currentShop } from '@/lib/current-shop';
import { ui } from '@/lib/ui-text';
import { supabaseServer } from '@/lib/supabase-server';
import { t as tr } from '@suqa/shared';
import MyShopForm from './MyShopForm';

export const dynamic = 'force-dynamic';

// Merchant-editable shop details. Slug, commission and approval status stay with the association (guarded in SQL).
export default async function ShopSettingsPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const sp = await searchParams;
  const tenant = await getTenant();
  const shop = await currentShop(sp);
  if (!shop) return null;
  const L = await getLocale(tenant);
  const sb = await supabaseServer();
  const [{ data: zones }, { data: served }] = await Promise.all([
    sb.from('delivery_zones').select('id,name,fee_usd').eq('tenant_id', tenant.id).eq('is_active', true).order('sort_order'),
    sb.from('shop_delivery_zones').select('zone_id,fee_usd').eq('shop_id', shop.id),
  ]);
  const keys = ['myShop', 'shopDetails', 'nameAr', 'nameEn', 'descAr', 'descEn', 'logo', 'cover', 'photo', 'changePhoto', 'remove', 'contact', 'publicPhone', 'whatsapp', 'addressText',
    'openingHours', 'closedDay', 'addRange', 'pauseOrders', 'pauseHint', 'followHours', 'forceOpen', 'forceClosed', 'minOrderUsd', 'prepMinutes', 'save', 'saved', 'pickupEnabled',
    'zonesServed', 'zonesServedHint', 'feeOverride', 'noZonesYet', 'noZonesServed'] as const;
  const labels = Object.fromEntries(keys.map(k => [k, ui(k, L)])) as Record<typeof keys[number], string>;
  return <MyShopForm key={shop.id} shop={shop} locale={L} canEdit={shop.role === 'owner'} labels={labels}
    zones={((zones as { id: string; name: Record<string, string>; fee_usd: number | string }[]) ?? []).map(z => ({ id: z.id, name: tr(z.name, L), fee_usd: Number(z.fee_usd) }))}
    served={((served as { zone_id: string; fee_usd: number | string | null }[]) ?? []).map(z => ({ zone_id: z.zone_id, fee_usd: z.fee_usd == null ? null : Number(z.fee_usd) }))} />;
}
