import { getTenant } from '@/lib/tenant';
import { requireUser } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import { ui } from '@/lib/ui-text';
import { pointFromEwkb } from '@suqa/shared';
import Checkout from './Checkout';

export const dynamic = 'force-dynamic';

export default async function CheckoutPage() {
  const user = await requireUser('/checkout');
  const tenant = await getTenant();
  const sb = await supabaseServer();
  const [{ data: addresses }, { data: profile }] = await Promise.all([
    sb.from('addresses').select('id,label,line1,line2,notes,phone,is_default,location').eq('user_id', user.id).order('is_default', { ascending: false }),
    sb.from('profiles').select('phone').eq('id', user.id).maybeSingle(),
  ]);
  const L = tenant.default_locale;
  const center = pointFromEwkb((tenant as any).center) ?? { lat: 34.2553, lng: 35.6581 };
  const addrs = ((addresses as any[]) ?? []).map(a => { const p = pointFromEwkb(a.location) ?? center; const { location, ...rest } = a; return { ...rest, lat: p.lat, lng: p.lng }; });
  const keys = ['checkout', 'deliveryAddress', 'newAddress', 'addressLabel', 'addressLine1', 'addressLine2', 'addressNotes', 'phone', 'pinLocation', 'useMyLocation',
    'outsideZone', 'orderNotes', 'payCash', 'placeOrder', 'subtotal', 'deliveryFee', 'total', 'minOrder', 'save', 'cancel', 'emptyCart', 'browseShops', 'eta',
    'oneFeeCourier', 'feePerShop', 'deliveredTogether'] as const;
  const labels = Object.fromEntries(keys.map(k => [k, ui(k, L)])) as Record<typeof keys[number], string>;

  return <Checkout tenantId={tenant.id} locale={L} fx={tenant.fx_lbp_rate} displayCurrency={tenant.display_currency}
    addresses={addrs} defaultPhone={(profile as any)?.phone ?? ''} center={center} labels={labels}
    deliveryMode={tenant.settings.delivery_mode ?? 'per_shop'} courierFee={tenant.settings.courier_fee_usd != null ? Number(tenant.settings.courier_fee_usd) : null} />;
}
