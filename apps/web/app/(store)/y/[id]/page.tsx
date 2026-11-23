import { getTenant } from '@/lib/tenant';
import { getLocale } from '@/lib/locale';
import { supabaseServer } from '@/lib/supabase-server';
import { hydrateBasket, type OrderDraft } from '@/lib/yorgo/tools';
import DraftBasket from './DraftBasket';

export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false, follow: false } };

// The page a Yorgo WhatsApp link opens (script 95): the basket draft behind /y/<id>, for 24 hours.
// The draft holds ids only; names, prices and availability are read here from the public catalog with the visitor's own access,
// so the card always shows today's price. Whoever holds the link sees public items and nothing about who asked for them.
// Nothing is ordered here: "add to cart" fills the usual cart; checkout (and sign-in) stay the usual ones.
export default async function YorgoDraftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [tenant, sb] = await Promise.all([getTenant(), supabaseServer()]);
  const L = (await getLocale(tenant)) === 'en' ? 'en' : 'ar';
  const gone = <div className="card stack" style={{ maxWidth: 560, margin: '24px auto' }}>
    <strong>{L === 'ar' ? 'هذه السلة لم تعد متاحة' : 'This basket is no longer available'}</strong>
    <span className="muted">{L === 'ar' ? 'رابط السلة صالح 24 ساعة. اكتب طلبك من جديد على واتساب، أو تسوّق مباشرة من هنا.' : 'A basket link works for 24 hours. Write your order again on WhatsApp, or shop directly from here.'}</span>
    <div><a className="btn primary" href="/">{L === 'ar' ? 'تصفّح المتاجر' : 'Browse the shops'}</a></div>
  </div>;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return gone;
  const { data } = await sb.rpc('yorgo_draft_get', { p_id: id });
  const row = data as { id: string; tenant_id: string; draft: Partial<OrderDraft>; added: boolean; discarded?: boolean } | null;
  if (!row || row.tenant_id !== tenant.id) return gone;
  const slim = { lines: row.draft.lines ?? [], choices: row.draft.choices ?? [], not_found: row.draft.not_found ?? [] };
  const full = await hydrateBasket({ sb: { rpc: (fn, args) => sb.rpc(fn, args), from: t => sb.from(t) as never }, tenantId: tenant.id, fx: Number(tenant.fx_lbp_rate ?? 0) || null }, slim);
  return <DraftBasket id={row.id} locale={L} draft={{ lines: full.lines, choices: full.choices, not_found: full.not_found }} alreadyAdded={row.added} discarded={row.discarded === true} />;
}
