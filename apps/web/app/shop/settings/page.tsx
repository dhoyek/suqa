import { getTenant } from '@/lib/tenant';
import { currentShop } from '@/lib/current-shop';
import { ui } from '@/lib/ui-text';
import MyShopForm from './MyShopForm';

export const dynamic = 'force-dynamic';

// Merchant-editable shop details. Slug, commission and approval status stay with the association (guarded in SQL).
export default async function ShopSettingsPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const sp = await searchParams;
  const tenant = await getTenant();
  const shop = await currentShop(sp);
  if (!shop) return null;
  const L = tenant.default_locale;
  const keys = ['myShop', 'shopDetails', 'nameAr', 'nameEn', 'descAr', 'descEn', 'logo', 'cover', 'photo', 'changePhoto', 'remove', 'contact', 'publicPhone', 'whatsapp', 'addressText',
    'openingHours', 'closedDay', 'addRange', 'pauseOrders', 'pauseHint', 'followHours', 'forceOpen', 'forceClosed', 'minOrderUsd', 'prepMinutes', 'save', 'saved'] as const;
  const labels = Object.fromEntries(keys.map(k => [k, ui(k, L)])) as Record<typeof keys[number], string>;
  return <MyShopForm shop={shop} locale={L} canEdit={shop.role === 'owner'} labels={labels} />;
}
