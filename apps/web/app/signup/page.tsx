import Link from 'next/link';
import { redirect } from 'next/navigation';
import { safeNext } from '@/lib/safe-next';
import { getTenant } from '@/lib/tenant';
import { getUser } from '@/lib/auth';
import { ui } from '@/lib/ui-text';
import SignupForm from './SignupForm';

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next, '/');
  const tenant = await getTenant();
  if (await getUser()) redirect(next);
  const L = tenant.default_locale;
  return (
    <main className="login">
      <div className="card stack">
        <div><div className="brand">{tenant.brand_name}</div><h1 style={{ margin: '4px 0 0', fontSize: 20 }}>{ui('createAccount', L)}</h1></div>
        <SignupForm next={next} tenantId={tenant.id} locale={L}
          labels={{ fullName: ui('fullName', L), phone: ui('phone', L), email: ui('email', L), password: ui('password', L), createAccount: ui('createAccount', L), failed: ui('signupFailed', L) }} />
        <Link href={`/login?next=${encodeURIComponent(next)}`} className="muted" style={{ fontSize: 14, textAlign: 'center' }}>{ui('haveAccount', L)}</Link>
      </div>
    </main>
  );
}
