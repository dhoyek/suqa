import { redirect } from 'next/navigation';
import { getTenant } from '@/lib/tenant';
import { getUser } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import { getLocale } from '@/lib/locale';
import { ui } from '@/lib/ui-text';
import AccountForm from './AccountForm';

export const dynamic = 'force-dynamic';

/** My account: name, phone number (changed with a code sent to the new number), email if any. */
export default async function AccountPage() {
  const tenant = await getTenant();
  const user = await getUser();
  if (!user) redirect('/login?next=/account');
  const L = await getLocale(tenant);
  const sb = await supabaseServer();
  const { data: p } = await sb.from('profiles').select('full_name, phone').eq('id', user.id).maybeSingle();
  const prof = (p as unknown as { full_name: string | null; phone: string | null } | null);
  return (
    <main className="container narrow stack">
      <h1>{ui('myAccount', L)}</h1>
      <AccountForm name={prof?.full_name ?? ''} phone={prof?.phone ?? ''} email={user.email ?? ''}
        labels={{ fullName: ui('fullName', L), phoneNumber: ui('phoneNumber', L), save: ui('save', L), saved: ui('saved', L), changePhone: ui('changeNumberBtn', L), sendCode: ui('sendCode', L),
          codeSentTo: ui('codeSentTo', L), enterCode: ui('enterCode', L), verifyCode: ui('verifyCode', L), cancel: ui('cancel', L), invalid: ui('invalidLogin', L), invalidCode: ui('invalidCode', L),
          phoneChanged: ui('phoneChanged', L), phoneHint: ui('phoneChangeHint', L), email: ui('email', L) }} />
    </main>
  );
}
