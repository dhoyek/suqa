import type { NextConfig } from 'next';

// Security headers live here (not only netlify.toml) because Netlify's [[headers]] only apply to
// static assets — server-rendered pages come from the Next.js function and need these from Next itself.
const SECURITY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'geolocation=(self), camera=(), microphone=(), payment=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
];

const config: NextConfig = {
  transpilePackages: ['@suqa/shared'],
  images: { remotePatterns: [{ protocol: 'https', hostname: '*.supabase.co' }] },
  poweredByHeader: false,
  async headers() { return [{ source: '/(.*)', headers: SECURITY_HEADERS }]; },
  // Friendly aliases for the legal pages (Meta's URL validator is picky about paths)
  async redirects() {
    return [
      { source: '/data-deletion', destination: '/legal/delete-data', permanent: true },
      { source: '/privacy', destination: '/legal/privacy', permanent: true },
      { source: '/terms', destination: '/legal/terms', permanent: true },
    ];
  },
};
export default config;
