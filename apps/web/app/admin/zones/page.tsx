import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import { ui } from '@/lib/ui-text';
import { pointFromEwkb } from '@suqa/shared';
import ZonesEditor from './ZonesEditor';

export const dynamic = 'force-dynamic';

export default async function AdminZones() {
  const tenant = await getTenant();
  const sb = await supabaseServer();
  const L = tenant.default_locale;
  // Polygons come as GeoJSON through an RPC (PostgREST would return WKB hex otherwise).
  const { data: zones } = await sb.rpc('tenant_zones_geojson', { p_tenant: tenant.id });
  const center = pointFromEwkb((tenant as any).center) ?? { lat: 34.2553, lng: 35.6581 };
  const keys = ['zones', 'newZone', 'zoneName', 'nameAr', 'nameEn', 'deliveryFee', 'etaMinutes', 'active', 'drawZone', 'finish', 'clearDrawing', 'save', 'saved', 'cancel', 'remove'] as const;
  const labels = Object.fromEntries(keys.map(k => [k, ui(k, L)])) as Record<typeof keys[number], string>;
  return <ZonesEditor tenantId={tenant.id} locale={L} center={center} initial={(zones as any[]) ?? []} labels={labels} />;
}
