'use client';
import { useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { text } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import { can, roleOf } from '../lib/perm';

type Staff = { display_name?: string | null; full_name?: string | null; role?: 'owner' | 'cashier' | 'staff' | 'stock' };

/**
 * The avatar in the POS bar: a dropdown under it (same shape as the storefront's profile menu) — who is at the till and with which
 * account, the shop, language, the ways out of the POS, lock and sign out.
 */
export default function AccountMenu({ sb, boot, staff, locale, setLocale, onLock }: { sb: SupabaseClient; boot: Booted; staff: Staff; locale: L; setLocale: (l: L) => void; onLock: () => void }) {
  const [open, setOpen] = useState(false);
  const [me, setMe] = useState<string>(''); const [admin, setAdmin] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // loaded once, ahead of the first open, so the menu never opens half-empty
  useEffect(() => {
    let on = true;
    void (async () => {
      try {
        const { data } = await sb.auth.getSession();           // local: works offline too
        const u = data.session?.user;
        if (on) setMe(u?.phone ? `+${u.phone.replace(/^\+/, '')}` : (u?.email ?? ''));
        const [r, t] = await Promise.all([sb.rpc('is_platform_admin'), sb.rpc('is_tenant_member', { p_tenant: boot.shop.tenant_id })]);
        if (on) setAdmin((!r.error && !!r.data) || (!t.error && !!t.data));
      } catch { /* offline: the menu still shows the till user */ }
    })();
    return () => { on = false; };
  }, [sb, boot.shop.tenant_id]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | TouchEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', close); document.addEventListener('touchstart', close); document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('touchstart', close); document.removeEventListener('keydown', esc, true); };
  }, [open]);
  const name = staff.display_name || staff.full_name || '';
  const initial = (name || me || '?').trim().charAt(0).toUpperCase();
  const role = roleOf(staff);
  return (
    <div className="profile-menu pos-account" ref={ref}>
      <button className="btn icon avatar-btn" title={pt('account', locale)} aria-expanded={open} onClick={() => setOpen(o => !o)}><span className="avatar-sm">{initial}</span><span className="avatar-name">{name}</span></button>
      {open && <div className="menu card">
        <div className="who">
          <strong>{name || pt('account', locale)}</strong>
          <div className="muted">{pt(`role_${boot.role}` as Parameters<typeof pt>[0], locale)} · 🏪 {text(boot.shop.name, locale)}</div>
          {me && <div className="muted" dir="ltr" style={{ textAlign: 'start' }}>{me}</div>}
        </div>
        <a className="item" href="/account">👤 {pt('account', locale)}</a>
        <a className="item" href="/orders">🧾 {pt('myPurchases', locale)}</a>
        {boot.role === 'owner' && <a className="item" href="/shop/settings">🏪 {pt('backToShop', locale)}</a>}
        {admin && <a className="item" href="/admin">🛠️ {pt('adminArea', locale)}</a>}
        <a className="item" href="/">🏠 {pt('backHome', locale)}</a>
        <div className="item lang">
          <span className="muted">{pt('language', locale)}</span>
          <span className="seg">
            <button type="button" className={locale === 'ar' ? 'on' : ''} onClick={() => setLocale('ar')}>عربي</button>
            <button type="button" className={locale === 'en' ? 'on' : ''} onClick={() => setLocale('en')}>EN</button>
          </span>
        </div>
        <button type="button" className="item strong" onClick={() => { setOpen(false); onLock(); }}>🔒 {pt('lock', locale)}</button>
        {can(role, 'signOut') && <form action="/auth/signout" method="post"><button type="submit" className="item danger">⎋ {pt('signOut', locale)}</button></form>}
      </div>}
    </div>
  );
}
