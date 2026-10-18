import { getTenant } from '@/lib/tenant';
// PWA manifest generated from tenant branding — installable storefront per town, no native app needed in Phase 1.
export async function GET() {
  const t = await getTenant();
  return Response.json({
    name: t.brand_name, short_name: t.brand_name, start_url: '/', display: 'standalone', dir: t.default_locale === 'ar' ? 'rtl' : 'ltr',
    lang: t.default_locale, background_color: '#ffffff', theme_color: t.branding.colors?.primary ?? '#0E7490',
    icons: t.branding.app_icon_url
      ? [{ src: t.branding.app_icon_url, sizes: '512x512', type: 'image/png', purpose: 'any' }]
      : [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }],
  }, { headers: { 'content-type': 'application/manifest+json' } });
}
