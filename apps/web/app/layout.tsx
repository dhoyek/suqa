import type { ReactNode } from 'react';
import './globals.css';
import { getTenant } from '@/lib/tenant';
import { brandCssVars, RTL } from '@suqa/shared';

export async function generateMetadata() {
  const t = await getTenant();
  return { title: t.brand_name, description: t.name, manifest: '/manifest.webmanifest' };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const t = await getTenant();
  const locale = t.default_locale;
  return (
    <html lang={locale} dir={RTL[locale] ? 'rtl' : 'ltr'} style={brandCssVars(t) as any}>
      <body>{children}</body>
    </html>
  );
}
