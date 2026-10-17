import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTenant } from '@/lib/tenant';
import { getUser } from '@/lib/auth';
import { ui } from '@/lib/ui-text';
import SocialSignIn from '@/components/SocialSignIn';
import { safeNext } from '@/lib/safe-next';
import LoginForm from './LoginForm';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next, '/shop');
  const tenant = await getTenant();
  if (await getUser()) redirect(next);
  const L = tenant.default_locale;
  return (
    <main className="login">
      <div className="card stack">
        <div>
          <div className="brand">{tenant.brand_name}</div>
          <h1 style={{ margin: '4px 0 0', fontSize: 20 }}>{ui('signIn', L)}</h1>
        </div>
        <LoginForm next={next} labels={{ email: ui('email', L), password: ui('password', L), signIn: ui('signIn', L), invalid: ui('invalidLogin', L) }} />
        <SocialSignIn next={next} labels={{ or: ui('orContinueWith', L), google: ui('continueGoogle', L), facebook: ui('continueFacebook', L), apple: ui('continueApple', L) }} />
        <Link href={`/signup?next=${encodeURIComponent(next)}`} className="muted" style={{ fontSize: 14, textAlign: 'center' }}>{ui('noAccount', L)}</Link>
      </div>
    </main>
  );
}
