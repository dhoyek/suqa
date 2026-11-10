'use client';
import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import Modal from './Modal';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import { can, roleOf } from '../lib/perm';

type Staff = { display_name?: string | null; full_name?: string | null; role?: 'owner' | 'cashier' | 'staff' | 'stock' };

/** 👤 in the POS bar: who is signed in (account) and who is at the till (staff), language, links out, sign out. */
export default function AccountMenu({ sb, boot, staff, locale, setLocale, onLock }: { sb: SupabaseClient; boot: Booted; staff: Staff; locale: L; setLocale: (l: L) => void; onLock: () => void }) {
  const [open, setOpen] = useState(false);
  const [me, setMe] = useState<string>(''); const [admin, setAdmin] = useState(false);
  useEffect(() => {
    if (!open) return;
    void (async () => {
      const { data } = await sb.auth.getUser();
      setMe(data.user?.phone ? `+${data.user.phone.replace(/^\+/, '')}` : (data.user?.email ?? ''));
      const [r, t] = await Promise.all([sb.rpc('is_platform_admin'), sb.rpc('is_tenant_member', { p_tenant: boot.shop.tenant_id })]);
      setAdmin((!r.error && !!r.data) || (!t.error && !!t.data));
    })();
  }, [open, sb, boot.shop.tenant_id]);
  const name = staff.display_name || staff.full_name || '';
  const initial = (name || me || '?').trim().charAt(0).toUpperCase();
  return (
    <>
      <button className="btn icon avatar-btn" title={pt('account', locale)} onClick={() => setOpen(true)}><span className="avatar-sm">{initial}</span><span className="avatar-name">{name}</span></button>
      {open && <Modal open onClose={() => setOpen(false)} title={`👤 ${name}`}
        footer={<>{can(roleOf(staff), 'signOut') && <form action="/auth/signout" method="post"><button className="btn ghost" type="submit">⎋ {pt('signOut', locale)}</button></form>}<span style={{ flex: 1 }} /><button className="btn primary" onClick={() => { setOpen(false); onLock(); }}>🔒 {pt('lock', locale)}</button></>}>
        <div className="stack" style={{ gap: 10 }}>
          <div className="muted" style={{ fontSize: 13 }}>
            {pt(`role_${boot.role}` as Parameters<typeof pt>[0], locale)}
            {me && <> · {pt('signedInAs', locale)} <strong dir="ltr">{me}</strong></>}
          </div>
          <label className="label">{pt('language', locale)}
            <div className="row" style={{ gap: 6 }}>
              <button className={`btn ${locale === 'ar' ? 'primary' : 'ghost'}`} onClick={() => setLocale('ar')}>عربي</button>
              <button className={`btn ${locale === 'en' ? 'primary' : 'ghost'}`} onClick={() => setLocale('en')}>English</button>
            </div>
          </label>
          <div className="stack" style={{ gap: 6 }}>
            <a className="btn ghost" href="/account" style={{ justifyContent: 'flex-start' }}>👤 {pt('account', locale)}</a>
            <a className="btn ghost" href="/" style={{ justifyContent: 'flex-start' }}>🏠 {pt('backHome', locale)}</a>
            {boot.role === 'owner' && <a className="btn ghost" href="/shop/settings" style={{ justifyContent: 'flex-start' }}>🏪 {pt('backToShop', locale)}</a>}
            {admin && <a className="btn ghost" href="/admin" style={{ justifyContent: 'flex-start' }}>🛠️ {pt('adminArea', locale)}</a>}
          </div>
        </div>
      </Modal>}
    </>
  );
}
