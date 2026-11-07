import { getTenant } from '@/lib/tenant';
// Installable POS (separate start_url and name from the storefront PWA).
export async function GET() {
  const t = await getTenant();
  return Response.json({
    name: `${t.brand_name} POS`, short_name: 'POS', start_url: '/pos', scope: '/pos', display: 'standalone', orientation: 'any',
    dir: t.default_locale === 'ar' ? 'rtl' : 'ltr', lang: t.default_locale, background_color: '#f3f4f6', theme_color: t.branding.colors?.primary ?? '#0E7490',
    icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }],
  }, { headers: { 'content-type': 'application/manifest+json' } });
}
