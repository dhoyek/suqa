import { getTenant } from '@/lib/tenant';
import PosApp from './PosApp';

// The POS is one client-rendered page (views switch inside it) so the service worker can serve it with no network.
// Sign-in is checked client-side from the session cookie; a server redirect here would break the offline open.
export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTenant();
  return { title: `${t.brand_name} · POS`, manifest: '/pos/manifest.webmanifest', robots: { index: false, follow: false } };
}

export default async function PosPage() {
  const t = await getTenant();
  return <PosApp locale={t.default_locale === 'en' ? 'en' : 'ar'} brand={t.brand_name} />;
}
