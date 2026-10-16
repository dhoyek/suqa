import { getMyShops } from './auth';

/** The shop being managed: ?shop=<id> when the user has several, otherwise their only shop. */
export async function currentShop(searchParams: { shop?: string }) {
  const shops = await getMyShops();
  if (shops.length === 0) return null;
  return shops.find(s => s.id === searchParams.shop) ?? shops[0];
}
