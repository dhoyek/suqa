import { getTenant } from '@/lib/tenant';
import { getUser } from '@/lib/auth';
import { ui } from '@/lib/ui-text';
import CartView from './CartView';

export const dynamic = 'force-dynamic';

export default async function CartPage() {
  const tenant = await getTenant();
  const user = await getUser();
  const L = tenant.default_locale;
  return <CartView locale={L} fx={tenant.fx_lbp_rate} displayCurrency={tenant.display_currency} signedIn={!!user}
    labels={{ cart: ui('cart', L), emptyCart: ui('emptyCart', L), browseShops: ui('browseShops', L), subtotal: ui('subtotal', L),
      deliveryFee: ui('deliveryFee', L), checkout: ui('checkout', L), from: ui('from', L), remove: ui('remove', L),
      sendCartWhatsapp: ui('sendCartWhatsapp', L), waHello: ui('waHello', L), waOrderIntro: ui('waOrderIntro', L), total: ui('total', L), notes: ui('notes', L) }} />;
}
