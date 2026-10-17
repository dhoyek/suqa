'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { friendlyError } from '@/lib/ui-text';
import { useCart } from '@/components/CartProvider';
import MapPicker from '@/components/MapPicker';
import { formatMoney, placeOrder, pointToEwkt, t as tr, type DisplayCurrency, type Locale } from '@suqa/shared';

type Addr = { id: string; label: string | null; line1: string; line2: string | null; notes: string | null; phone: string | null; is_default: boolean; lat: number; lng: number };
type Labels = Record<'checkout' | 'deliveryAddress' | 'newAddress' | 'addressLabel' | 'addressLine1' | 'addressLine2' | 'addressNotes' | 'phone' | 'pinLocation' | 'useMyLocation'
  | 'outsideZone' | 'orderNotes' | 'payCash' | 'placeOrder' | 'subtotal' | 'deliveryFee' | 'total' | 'minOrder' | 'save' | 'cancel' | 'emptyCart' | 'browseShops' | 'eta', string>;

export default function Checkout(props: { tenantId: string; locale: Locale; fx: number; displayCurrency: DisplayCurrency; addresses: Addr[]; defaultPhone: string; center: { lat: number; lng: number }; labels: Labels }) {
  const { tenantId, locale: L, fx, displayCurrency, labels } = props;
  const router = useRouter();
  const sb = useMemo(() => supabaseBrowser(), []);
  const { cart, subtotal, count, clear } = useCart();
  const money = (v: number) => formatMoney(v, fx, displayCurrency, L);

  const [addresses, setAddresses] = useState<Addr[]>(props.addresses);
  const [selected, setSelected] = useState<string | null>(props.addresses[0]?.id ?? null);
  const [adding, setAdding] = useState(props.addresses.length === 0);
  const [draft, setDraft] = useState({ label: '', line1: '', line2: '', notes: '', phone: props.defaultPhone, lat: props.center.lat, lng: props.center.lng });
  const [fee, setFee] = useState<{ fee_usd: number; eta_minutes: number | null } | null | 'outside'>(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Delivery fee preview for the selected address (zone lookup is a stable RPC).
  useEffect(() => {
    const a = addresses.find(x => x.id === selected);
    if (!a || !cart.shop_id) { setFee(null); return; }
    sb.rpc('find_zone', { p_tenant: tenantId, p_shop: cart.shop_id, p_point: pointToEwkt(a) })
      .then(({ data }) => { const z = Array.isArray(data) ? data[0] : data; setFee(z?.zone_id ? { fee_usd: Number(z.fee_usd), eta_minutes: z.eta_minutes } : 'outside'); });
  }, [selected, addresses, cart.shop_id, sb, tenantId]);

  async function saveAddress() {
    if (!draft.line1.trim()) return;
    setBusy(true); setError(null);
    const { data: u } = await sb.auth.getUser();
    const { data, error } = await sb.from('addresses').insert({
      tenant_id: tenantId, user_id: u.user!.id, label: draft.label.trim() || null, line1: draft.line1.trim(), line2: draft.line2.trim() || null,
      notes: draft.notes.trim() || null, phone: draft.phone.trim() || null, location: pointToEwkt(draft), is_default: addresses.length === 0,
    }).select('id,label,line1,line2,notes,phone,is_default').single();
    setBusy(false);
    if (error) { setError(friendlyError(error, L)); return; }
    const a: Addr = { ...(data as any), lat: draft.lat, lng: draft.lng };
    setAddresses(prev => [...prev, a]); setSelected(a.id); setAdding(false);
  }

  async function submit() {
    if (!cart.shop_id || !selected) return;
    setBusy(true); setError(null);
    try {
      const order = await placeOrder(sb, cart.shop_id, selected, cart.lines.map(l => ({ product_id: l.product_id, quantity: l.qty })), notes.trim() || undefined);
      clear();
      router.replace(`/orders/${order.id}?placed=1`);
    } catch (e: any) { setError(friendlyError(e, L)); setBusy(false); }
  }

  if (!count) return <div className="card stack" style={{ textAlign: 'center' }}><p className="muted">{labels.emptyCart}</p><Link className="btn primary" href="/">{labels.browseShops}</Link></div>;
  const feeUsd = fee && fee !== 'outside' ? fee.fee_usd : 0;
  const canOrder = !!selected && fee !== null && fee !== 'outside' && !busy;

  return (
    <div className="stack">
      <h1 style={{ margin: 0, fontSize: 20 }}>{labels.checkout}</h1>

      <section className="card stack">
        <strong>{labels.deliveryAddress}</strong>
        {addresses.map(a => (
          <div key={a.id} className={`addr ${selected === a.id ? 'selected' : ''}`} onClick={() => { setSelected(a.id); setAdding(false); }}>
            <div><strong>{a.label || '—'}</strong> <span className="muted" style={{ fontSize: 13 }}>{a.phone}</span></div>
            <div style={{ fontSize: 14 }}>{a.line1}{a.line2 ? `, ${a.line2}` : ''}</div>
            {a.notes && <div className="muted" style={{ fontSize: 13 }}>{a.notes}</div>}
          </div>
        ))}
        {!adding && <button className="btn" onClick={() => setAdding(true)}>+ {labels.newAddress}</button>}
        {adding && (
          <div className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
            <div className="muted" style={{ fontSize: 13 }}>{labels.pinLocation}</div>
            <MapPicker value={{ lat: draft.lat, lng: draft.lng }} onChange={p => setDraft(d => ({ ...d, ...p }))} useMyLocationLabel={labels.useMyLocation} />
            <div className="row" style={{ alignItems: 'stretch' }}>
              <div style={{ flex: 1 }}><label className="label">{labels.addressLabel}</label><input className="input" value={draft.label} onChange={e => setDraft({ ...draft, label: e.target.value })} /></div>
              <div style={{ flex: 1 }}><label className="label">{labels.phone}</label><input className="input" dir="ltr" inputMode="tel" value={draft.phone} onChange={e => setDraft({ ...draft, phone: e.target.value })} /></div>
            </div>
            <div><label className="label">{labels.addressLine1}</label><input className="input" required value={draft.line1} onChange={e => setDraft({ ...draft, line1: e.target.value })} /></div>
            <div><label className="label">{labels.addressLine2}</label><input className="input" value={draft.line2} onChange={e => setDraft({ ...draft, line2: e.target.value })} /></div>
            <div><label className="label">{labels.addressNotes}</label><input className="input" value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })} /></div>
            <div className="row spread">
              {addresses.length > 0 && <button className="btn" onClick={() => setAdding(false)}>{labels.cancel}</button>}
              <button className="btn primary" disabled={busy || !draft.line1.trim()} onClick={saveAddress}>{labels.save}</button>
            </div>
          </div>
        )}
        {fee === 'outside' && <div className="error">{labels.outsideZone}</div>}
      </section>

      <section className="card stack">
        <strong>{tr(cart.shop_name!, L)}</strong>
        {cart.lines.map(l => <div className="row spread" key={l.product_id} style={{ fontSize: 14 }}><span><span className="qty">{l.qty}×</span> {tr(l.name, L)}</span><span>{money(l.price_usd * l.qty)}</span></div>)}
        <textarea className="input" rows={2} placeholder={labels.orderNotes} value={notes} onChange={e => setNotes(e.target.value)} />
        <div className="row spread"><span>{labels.subtotal}</span><span>{money(subtotal)}</span></div>
        <div className="row spread"><span>{labels.deliveryFee}</span><span>{fee && fee !== 'outside' ? money(feeUsd) : '—'}</span></div>
        {fee && fee !== 'outside' && fee.eta_minutes != null && <div className="row spread muted" style={{ fontSize: 13 }}><span>{labels.eta}</span><span>~{fee.eta_minutes} min</span></div>}
        <div className="row spread" style={{ fontSize: 18 }}><strong>{labels.total}</strong><strong>{money(subtotal + feeUsd)}</strong></div>
        <div className="muted" style={{ fontSize: 13 }}>💵 {labels.payCash}</div>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="btn primary wide" disabled={!canOrder} onClick={submit}>{labels.placeOrder}</button>
      </section>
    </div>
  );
}
