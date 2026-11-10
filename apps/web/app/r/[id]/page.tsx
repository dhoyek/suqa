import { notFound } from 'next/navigation';
import { supabaseAdmin } from '@/lib/server/supabase-admin';
import { getTenant } from '@/lib/tenant';

// Public receipt page (QR / WhatsApp link). The order id is a v7 UUID — not guessable — and the page shows nothing
// a receipt wouldn't: items, totals in both currencies, rate, payments. No customer name or phone.
export const dynamic = 'force-dynamic';
const usd = (c: number) => '$' + (c / 100).toFixed(2);
const lbp = (n: number, ar: boolean) => Number(n).toLocaleString('en-US') + (ar ? ' ل.ل.' : ' LBP');

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const admin = supabaseAdmin(); const t = await getTenant();
  if (!admin || !/^[0-9a-f-]{36}$/.test(id)) notFound();
  const { data: o } = await admin.from('orders').select('id, number, local_number, placed_at, rate_lbp_per_usd, subtotal_cents, discount_cents, total_cents, total_lbp, change_usd_cents, change_lbp, tenant_id, shop:shops(name, phone, receipt_footer), items:order_items(name, quantity, unit, notes, price_currency, unit_price_cents, unit_price_lbp, discount_cents, line_total_cents, voided), payments(tender, amount, currency)').eq('id', id).maybeSingle();
  if (!o || o.tenant_id !== t.id) notFound();
  const L = t.default_locale === 'en' ? 'en' : 'ar'; const ar = L === 'ar';
  const shop = o.shop as unknown as { name: Record<string, string>; phone?: string | null; receipt_footer?: string | null } | null;
  const tx = (n: Record<string, string> | null | undefined) => n?.[L] || n?.ar || n?.en || '';
  const tender: Record<string, string> = ar ? { cash_usd: 'نقدي $', cash_lbp: 'نقدي ل.ل.', card: 'بطاقة', wallet: 'محفظة', unpaid: 'غير مدفوع' } : { cash_usd: 'Cash USD', cash_lbp: 'Cash LBP', card: 'Card', wallet: 'Wallet', unpaid: 'Unpaid' };
  const items = (o.items as Array<{ name: Record<string, string>; quantity: number | string; unit?: string | null; notes?: string | null; price_currency: string; unit_price_cents: number; unit_price_lbp: number; discount_cents: number; line_total_cents: number; voided: boolean }>).filter(i => !i.voided);
  return (
    <main className="container" style={{ maxWidth: 420, padding: 16 }} dir={ar ? 'rtl' : 'ltr'}>
      <div className="card" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 14 }}>
        <div style={{ textAlign: 'center' }}><strong style={{ fontSize: 18 }}>{tx(shop?.name)}</strong>{shop?.phone && <div className="muted" dir="ltr">{shop.phone}</div>}</div>
        <div className="row spread muted" style={{ margin: '10px 0', fontSize: 12 }}><span>{ar ? 'رقم' : 'No.'} {o.number ?? o.local_number}</span><span>{new Date(o.placed_at).toLocaleString(ar ? 'ar-LB-u-nu-latn' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' })}</span></div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}><tbody>
          {items.map((i, k) => <tr key={k}><td style={{ padding: '4px 0' }}>{tx(i.name)}{i.notes && <div style={{ fontSize: 12, color: '#92400e' }}>📝 {i.notes}</div>}<div className="muted" style={{ fontSize: 12 }}>{Number(i.quantity)}{i.unit ? ` ${i.unit}` : ''} × {i.price_currency === 'usd' ? usd(i.unit_price_cents) : lbp(i.unit_price_lbp, ar)}{i.discount_cents ? ` − ${usd(i.discount_cents)}` : ''}</div></td><td style={{ textAlign: 'end', verticalAlign: 'top' }}>{usd(i.line_total_cents)}</td></tr>)}
        </tbody></table>
        <hr style={{ border: 0, borderTop: '1px dashed var(--line)', margin: '8px 0' }} />
        {o.discount_cents > 0 && <div className="row spread"><span>{ar ? 'خصم' : 'Discount'}</span><span>−{usd(o.discount_cents)}</span></div>}
        <div className="row spread" style={{ fontSize: 18, fontWeight: 700 }}><span>{ar ? 'الإجمالي' : 'Total'}</span><span>{usd(o.total_cents)}</span></div>
        <div className="row spread" style={{ fontSize: 16, fontWeight: 700 }}><span></span><span>{lbp(o.total_lbp, ar)}</span></div>
        <div className="row spread muted" style={{ fontSize: 12 }}><span>{ar ? 'سعر الصرف' : 'Rate'}</span><span>{Number(o.rate_lbp_per_usd).toLocaleString('en-US')} / $1</span></div>
        {(o.payments as Array<{ tender: string; amount: number; currency: string }>).map((p, k) => <div key={k} className="row spread"><span>{tender[p.tender] ?? p.tender}</span><span>{p.currency === 'lbp' ? lbp(p.amount, ar) : usd(p.amount)}</span></div>)}
        {(o.change_usd_cents > 0 || o.change_lbp > 0) && <div className="row spread"><span>{ar ? 'الباقي' : 'Change'}</span><span>{o.change_usd_cents ? usd(o.change_usd_cents) : lbp(o.change_lbp, ar)}</span></div>}
        <p className="muted" style={{ textAlign: 'center', marginTop: 12 }}>{shop?.receipt_footer || (ar ? 'شكراً لزيارتكم' : 'Thank you')}</p>
      </div>
    </main>
  );
}
