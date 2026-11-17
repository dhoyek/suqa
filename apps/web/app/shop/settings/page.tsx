import { getTenant } from '@/lib/tenant';
import { getLocale } from '@/lib/locale';
import Link from 'next/link';
import { currentShop } from '@/lib/current-shop';
import { getMyShops } from '@/lib/auth';
import { ui } from '@/lib/ui-text';
import { supabaseServer } from '@/lib/supabase-server';
import { t as tr } from '@suqa/shared';
import MyShopForm from './MyShopForm';

export const dynamic = 'force-dynamic';

// Merchant-editable shop details. Slug, commission and approval status stay with the association (guarded in SQL).
export default async function ShopSettingsPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const sp = await searchParams;
  const tenant = await getTenant();
  const L = await getLocale(tenant);
  // an account with several shops says which one first: opening "the first one" is how the wrong shop gets edited
  const mine = await getMyShops();
  if (mine.length > 1 && !mine.some(s => s.id === sp.shop)) return (
    <div className="stack">
      <h1 style={{ margin: 0, fontSize: 20 }}>{L === 'ar' ? 'أي متجر تريد إدارته؟' : 'Which shop do you want to manage?'}</h1>
      <div className="stack" style={{ gap: 8 }}>
        {mine.map(s => <Link key={s.id} href={`/shop/settings?shop=${s.id}`} className="btn big" style={{ justifyContent: 'flex-start' }}>🏪 {tr(s.name, L)}</Link>)}
      </div>
    </div>
  );
  const shop = await currentShop(sp);
  if (!shop) return null;
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  const [{ data: zones }, { data: served }, { data: tm }, { data: cats }] = await Promise.all([
    sb.from('delivery_zones').select('id,name,fee_usd').eq('tenant_id', tenant.id).eq('is_active', true).order('sort_order'),
    sb.from('shop_delivery_zones').select('zone_id,fee_usd').eq('shop_id', shop.id),
    // link name and category are the association's to set: shown only to its admins
    user ? sb.from('tenant_members').select('role').eq('tenant_id', tenant.id).eq('user_id', user.id).eq('role', 'admin').maybeSingle() : Promise.resolve({ data: null }),
    sb.from('categories').select('id,name').eq('tenant_id', tenant.id).order('sort_order'),
  ]);
  const admin = tm ? { tenantId: tenant.id, categories: ((cats as { id: string; name: Record<string, string> }[]) ?? []).map(c => ({ id: c.id, name: tr(c.name, L) })) } : null;
  const keys = ['myShop', 'shopDetails', 'nameAr', 'nameEn', 'descAr', 'descEn', 'logo', 'cover', 'photo', 'changePhoto', 'remove', 'contact', 'publicPhone', 'whatsapp', 'addressText',
    'openingHours', 'closedDay', 'addRange', 'pauseOrders', 'pauseHint', 'followHours', 'forceOpen', 'forceClosed', 'minOrderUsd', 'prepMinutes', 'save', 'saved', 'pickupEnabled',
    'zonesServed', 'zonesServedHint', 'feeOverride', 'noZonesYet', 'noZonesServed'] as const;
  const labels = Object.fromEntries(keys.map(k => [k, ui(k, L)])) as Record<typeof keys[number], string>;
  return <MyShopForm key={shop.id} shop={shop} locale={L} canEdit={shop.role === 'owner'} labels={labels} admin={admin}
    zones={((zones as { id: string; name: Record<string, string>; fee_usd: number | string }[]) ?? []).map(z => ({ id: z.id, name: tr(z.name, L), fee_usd: Number(z.fee_usd) }))}
    served={((served as { zone_id: string; fee_usd: number | string | null }[]) ?? []).map(z => ({ zone_id: z.zone_id, fee_usd: z.fee_usd == null ? null : Number(z.fee_usd) }))} />;
}
