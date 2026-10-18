import type { ReactNode } from 'react';
import './globals.css';
import { getTenantOrNull, isDevDeploy } from '@/lib/tenant';
import { brandCssVars, RTL } from '@suqa/shared';
import { ConfirmProvider } from '@/components/ConfirmProvider';
import { ui } from '@/lib/ui-text';

export async function generateMetadata() {
  const t = await getTenantOrNull();
  return {
    title: t?.brand_name ?? 'Suqa',
    description: t?.name ?? 'Local shops, delivered.',
    manifest: t ? '/manifest.webmanifest' : undefined,
    robots: isDevDeploy() ? { index: false, follow: false } : undefined,
    icons: { icon: t?.branding.app_icon_url ?? '/icons/icon-192.png', apple: t?.branding.app_icon_url ?? '/icons/icon-180.png', shortcut: '/favicon.ico' },
  };
}

export const viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' as const, themeColor: '#0E7490' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const t = await getTenantOrNull();
  if (!t) {
    // Unknown hostname: a neutral page instead of a crash. Domains are mapped in suqa.tenant_domains.
    return (
      <html lang="en" dir="ltr"><body>
        <main className="login"><div className="card stack" style={{ textAlign: 'center' }}>
          <div className="brand">Suqa</div>
          <p className="muted">This address is not linked to a marketplace yet.</p>
          <p className="muted" dir="rtl">هذا العنوان غير مرتبط بأي سوق بعد.</p>
        </div></main>
      </body></html>
    );
  }
  const locale = t.default_locale;
  return (
    <html lang={locale} dir={RTL[locale] ? 'rtl' : 'ltr'} style={brandCssVars(t) as any}>
      <body><ConfirmProvider labels={{ confirm: ui('confirm', locale), cancel: ui('cancel', locale) }}>{children}</ConfirmProvider></body>
    </html>
  );
}
