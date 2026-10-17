import { notFound } from 'next/navigation';
import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import { ui } from '@/lib/ui-text';
import { pointFromEwkb, t as tr, type Category, type Shop } from '@suqa/shared';
import ShopEditor from './ShopEditor';

export const dynamic = 'force-dynamic';

export default async function AdminShop({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenant();
  const sb = await supabaseServer();
  const L = tenant.default_locale;
  const isNew = id === 'new';
  const [{ data: shop }, { data: cats }, { data: zones }, { data: served }, { data: people }] = await Promise.all([
    isNew ? Promise.resolve({ data: null }) : sb.from('shops').select('*').eq('id', id).eq('tenant_id', tenant.id).maybeSingle(),
    sb.from('categories').select('id,name').eq('tenant_id', tenant.id).order('sort_order'),
    sb.from('delivery_zones').select('id,name,fee_usd').eq('tenant_id', tenant.id).eq('is_active', true).order('sort_order'),
    isNew ? Promise.resolve({ data: [] }) : sb.from('shop_delivery_zones').select('zone_id,fee_usd').eq('shop_id', id),
    isNew ? Promise.resolve({ data: [] }) : sb.rpc('tenant_people', { p_tenant: tenant.id }),
  ]);
  if (!isNew && !shop) notFound();
  const s = shop as Shop | null;
  const center = pointFromEwkb((tenant as any).center) ?? { lat: 34.2553, lng: 35.6581 };
  const loc = s ? (pointFromEwkb((s as any).location) ?? center) : center;
  const members = ((people as any[]) ?? []).filter(p => p.shop_id === id).map(p => ({ user_id: p.user_id, full_name: p.full_name, email: p.email, role: p.shop_role }));
  const keys = ['save', 'saved', 'nameAr', 'nameEn', 'shopSlug', 'category', 'phone', 'whatsapp', 'addressText', 'minOrder', 'prepMinutes', 'commissionRate', 'shopLocation', 'useMyLocation',
    'zonesServed', 'feeOverride', 'owners', 'addByEmail', 'userNotFound', 'role', 'owner', 'staff', 'remove', 'newShop', 'editProduct', 'products'] as const;
  const labels = Object.fromEntries(keys.map(k => [k, ui(k, L)])) as Record<typeof keys[number], string>;
  return <ShopEditor tenantId={tenant.id} locale={L} shop={s} location={loc}
    categories={((cats as Category[]) ?? []).map(c => ({ id: c.id, name: tr(c.name, L) }))}
    zones={((zones as any[]) ?? []).map(z => ({ id: z.id, name: tr(z.name, L), fee_usd: Number(z.fee_usd) }))}
    served={((served as any[]) ?? []).map(z => ({ zone_id: z.zone_id, fee_usd: z.fee_usd == null ? null : Number(z.fee_usd) }))}
    members={members} labels={labels} />;
}
