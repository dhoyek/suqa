import type { NextConfig } from 'next';
const config: NextConfig = { transpilePackages: ['@suqa/shared'], images: { remotePatterns: [{ protocol: 'https', hostname: '*.supabase.co' }] } };
export default config;
