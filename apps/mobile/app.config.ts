import type { ExpoConfig } from 'expo/config';
// One build per tenant: EXPO_PUBLIC_SUQA_TENANT_SLUG=batroun npx expo run:android
const slug = process.env.EXPO_PUBLIC_SUQA_TENANT_SLUG ?? 'batroun';
const config: ExpoConfig = {
  name: process.env.SUQA_APP_NAME ?? 'Suqa',
  slug: `suqa-${slug}`,
  version: '0.1.0',
  orientation: 'portrait',
  ios: { bundleIdentifier: `com.yorgoinc.suqa.${slug}` },
  android: { package: `com.yorgoinc.suqa.${slug}` },
  extra: { tenantSlug: slug },
};
export default config;
