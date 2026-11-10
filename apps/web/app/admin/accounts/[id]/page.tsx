import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import { getTenantRole } from '@/lib/admin';
import { getLocale } from '@/lib/locale';
import { ui } from '@/lib/ui-text';
import { t as tr, type LocalizedText } from '@suqa/shared';

export const dynamic = 'force-dynamic';

type Activity = {
  user: { id: string; name: string | null; phone: string | null; email: string | null; created_at: string; last_sign_in_at: string | null; blocked: boolean; deleted: boolean; locale: string | null };
  sessions: { created_at: string; updated_at: string; user_agent: string | null; ip: string | null }[];
  devices: { name: string; shop: LocalizedText; registered_at: string; last_sync_at: string | null; revoked: boolean }[];
  orders: { id: string; number: string; shop: LocalizedText; status: string; total_usd: number; placed_at: string }[];
  orders_total: number;
  audit: { at: string; action: string; by: string; before: unknown; after: unknown }[];
  roles: { tenant_role: string | null; shops: { shop: LocalizedText; role: string; active: boolean; pin_set: boolean }[]; driver_for: LocalizedText[]; courier: boolean };
};

/** Activity + "what they see" (read-only) for one account. Every open is audit-logged as account.view. */
export default async function AccountActivity({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenant();
  if ((await getTenantRole(tenant.id)) !== 'admin') notFound();
  const L = await getLocale(tenant);
  const sb = await supabaseServer();
  const { data, error } = await sb.rpc('admin_account_activity', { p_tenant: tenant.id, p_user: id });
  if (error) return <div className="card bad">{error.message}</div>;
  const a = data as Activity;
  await sb.rpc('admin_account_view_log', { p_tenant: tenant.id, p_user: id }).then(() => undefined, () => undefined);
  const when = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString(L === 'ar' ? 'ar-LB' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const ua = (s: string | null) => { if (!s) return '—'; const m = /(iPhone|iPad|Android|Windows|Macintosh|Linux)/.exec(s); const b = /(Chrome|Safari|Firefox|Edg)\/[\d.]+/.exec(s); return `${m?.[1] ?? ''} ${b?.[0]?.split('/')[0] ?? ''}`.trim() || s.slice(0, 40); };
  return (
    <div className="stack">
      <div className="row spread" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>👤 {a.user.name || a.user.phone || '—'} <span className="muted" dir="ltr" style={{ fontSize: 14, fontWeight: 400 }}>{a.user.phone ? `+${a.user.phone.replace(/^\+/, '')}` : a.user.email}</span></h2>
        <Link href="/admin/accounts" className="btn">← {ui('accounts', L)}</Link>
      </div>
      <section className="card stack">
        <strong>{ui('roles', L)}</strong>
        <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
          {a.roles.tenant_role && <span className="badge">🛠️ {a.roles.tenant_role}</span>}
          {a.roles.shops.filter(s => s.active).map((s, i) => <span key={i} className="badge">🏪 {tr(s.shop, L)} · {s.role}{s.pin_set ? ' · PIN ✓' : ' · PIN —'}</span>)}
          {a.roles.driver_for.map((n, i) => <span key={i} className="badge">🛵 {tr(n, L)}</span>)}
          {a.roles.courier && <span className="badge">🛵 courier</span>}
          {a.user.blocked && <span className="badge" style={{ background: '#fee2e2' }}>⛔ {ui('blocked', L)}</span>}
        </div>
        <div className="muted" style={{ fontSize: 13 }}>{ui('createdAt', L)}: {when(a.user.created_at)} · {ui('lastSeen', L)}: {when(a.user.last_sign_in_at)}</div>
      </section>
      <section className="card stack">
        <strong>{ui('sessions', L)} ({a.sessions.length})</strong>
        <table className="table"><tbody>{a.sessions.map((s, i) => <tr key={i}><td className="muted">{when(s.updated_at)}</td><td>{ua(s.user_agent)}</td><td className="muted" dir="ltr">{s.ip ?? ''}</td></tr>)}{!a.sessions.length && <tr><td className="muted">—</td></tr>}</tbody></table>
      </section>
      {a.devices.length > 0 && <section className="card stack">
        <strong>{ui('posDevices', L)}</strong>
        <table className="table"><tbody>{a.devices.map((d, i) => <tr key={i}><td>{d.name}{d.revoked ? ' ⛔' : ''}</td><td>{tr(d.shop, L)}</td><td className="muted">{when(d.last_sync_at)}</td></tr>)}</tbody></table>
      </section>}
      <section className="card stack">
        <strong>{ui('orders', L)} ({a.orders_total})</strong>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>{ui('viewAsHint', L)}</p>
        <table className="table"><tbody>{a.orders.map(o => <tr key={o.id}><td className="muted">{when(o.placed_at)}</td><td><Link href={`/r/${o.id}`}>{o.number}</Link></td><td>{tr(o.shop, L)}</td><td>{o.status}</td><td className="num">${Number(o.total_usd).toFixed(2)}</td></tr>)}{!a.orders.length && <tr><td className="muted">—</td></tr>}</tbody></table>
      </section>
      <section className="card stack">
        <strong>{ui('auditTrail', L)}</strong>
        <table className="table"><tbody>{a.audit.map((e, i) => <tr key={i}><td className="muted">{when(e.at)}</td><td>{e.action}</td><td>{e.by}</td><td className="muted" style={{ fontSize: 12 }} dir="ltr">{e.after ? JSON.stringify(e.after).slice(0, 80) : ''}</td></tr>)}{!a.audit.length && <tr><td className="muted">—</td></tr>}</tbody></table>
      </section>
    </div>
  );
}
