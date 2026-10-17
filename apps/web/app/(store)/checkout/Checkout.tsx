'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { friendlyError } from '@/lib/ui-text';
import { useCart } from '@/components/CartProvider';
import MapPicker from '@/components/MapPicker';
import { formatMoney, placeOrder, placeBasket, pointToEwkt, t as tr, type DisplayCurrency, type Locale } from '@suqa/shared';

type Addr = { id: string; label: string | null; line1: string; line2: string | null; notes: string | null; phone: string | null; is_default: boolean; lat: number; lng: number };
type Labels = Record<'checkout' | 'deliveryAddress' | 'newAddress' | 'addressLabel' | 'addressLine1' | 'addressLine2' | 'addressNotes' | 'phone' | 'pinLocation' | 'useMyLocation'
  | 'outsideZone' | 'orderNotes' | 'payCash' | 'placeOrder' | 'subtotal' | 'deliveryFee' | 'total' | 'minOrder' | 'save' | 'cancel' | 'emptyCart' | 'browseShops' | 'eta'
  | 'oneFeeCourier' | 'feePerShop' | 'deliveredTogether', string>;

export default function Checkout(props: { tenantId: string; locale: Locale; fx: number; displayCurrency: DisplayCurrency; addresses: Addr[]; defaultPhone: string; center: { lat: number; lng: number }; deliveryMode: 'per_shop' | 'courier'; courierFee: number | null; labels: Labels }) {
  const { tenantId, locale: L, fx, displayCurrency, deliveryMode, courierFee, labels } = props;
  const router = useRouter();
  const sb = useMemo(() => supabaseBrowser(), []);
  const { selectedShops: shops, selectedSubtotal: subtotal, selectedCount: count, removeShops } = useCart();
  const shopKey = shops.map(s => s.id).join(',');
  const money = (v: number) => formatMoney(v, fx, displayCurrency, L);

  const [addresses, setAddresses] = useState<Addr[]>(props.addresses);
  const [selected, setSelected] = useState<string | null>(props.addresses[0]?.id ?? null);
  const [adding, setAdding] = useState(props.addresses.length === 0);
  const [draft, setDraft] = useState({ label: '', line1: '', line2: '', notes: '', phone: props.defaultPhone, lat: props.center.lat, lng: props.center.lng });
  // per shop: zone fee + ETA, or 'outside' when the address is not served by that shop
  const [fees, setFees] = useState<Record<string, { fee_usd: number; eta_minutes: number | null } | 'outside'>>({});
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Delivery fee preview per shop for the selected address (zone lookup is a stable RPC).
  useEffect(() => {
    const a = addresses.find(x => x.id === selected);
    if (!a || !shopKey) { setFees({}); return; }
    let live = true;
    Promise.all(shops.map(s => sb.rpc('find_zone', { p_tenant: tenantId, p_shop: s.id, p_point: pointToEwkt(a) }).then(({ data }) => {
      const z = Array.isArray(data) ? data[0] : data;
      return [s.id, z?.zone_id ? { fee_usd: Number(z.fee_usd), eta_minutes: z.eta_minutes as number | null } : 'outside'] as const;
    }))).then(entries => { if (live) setFees(Object.fromEntries(entries)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, addresses, shopKey, sb, tenantId]);

  async function saveAddress() {
    if (!draft.line1.trim()) return;
    setBusy(true); setError(null);
    const { data: sess } = await sb.auth.getSession();
    const { data, error } = await sb.from('addresses').insert({
      tenant_id: tenantId, user_id: sess.session!.user.id, label: draft.label.trim() || null, line1: draft.line1.trim(), line2: draft.line2.trim() || null,
      notes: draft.notes.trim() || null, phone: draft.phone.trim() || null, location: pointToEwkt(draft), is_default: addresses.length === 0,
    }).select('id,label,line1,line2,notes,phone,is_default').single();
    setBusy(false);
    if (error) { setError(friendlyError(error, L)); return; }
    const a: Addr = { ...(data as any), lat: draft.lat, lng: draft.lng };
    setAddresses(prev => [...prev, a]); setSelected(a.id); setAdding(false);
  }

  async function submit() {
    if (!shops.length || !selected) return;
    setBusy(true); setError(null);
    const ids = shops.map(s => s.id);
    try {
      if (shops.length === 1) {
        const s = shops[0];
        const order = await placeOrder(sb, s.id, selected, s.lines.map(l => ({ product_id: l.product_id, quantity: l.qty })), notes.trim() || undefined);
        removeShops(ids);
        router.replace(`/orders/${order.id}?placed=1`);
      } else {
        const basket = await placeBasket(sb, selected, shops.map(s => ({ shop_id: s.id, items: s.lines.map(l => ({ product_id: l.product_id, quantity: l.qty })) })), notes.trim() || undefined);
        removeShops(ids);
        router.replace(`/orders/b/${basket.id}?placed=1`);
      }
    } catch (e: any) { setError(friendlyError(e, L)); setBusy(false); }
  }

  if (!count) return <div className="card stack" style={{ textAlign: 'center' }}><p className="muted">{labels.emptyCart}</p><Link className="btn primary" href="/">{labels.browseShops}</Link></div>;
  const feeStates = shops.map(s => fees[s.id]);
  const feesReady = feeStates.length === shops.length && feeStates.every(f => f !== undefined);
  const anyOutside = feeStates.some(f => f === 'outside');
  const perShopFees = shops.reduce((sum, s) => { const f = fees[s.id]; return sum + (f && f !== 'outside' ? f.fee_usd : 0); }, 0);
  const maxZoneFee = shops.reduce((m, s) => { const f = fees[s.id]; return Math.max(m, f && f !== 'outside' ? f.fee_usd : 0); }, 0);
  const courier = shops.length > 1 && deliveryMode === 'courier';
  const feeUsd = courier ? (courierFee ?? maxZoneFee) : perShopFees;
  const canOrder = !!selected && feesReady && !anyOutside && !busy;
  const shopSub = (lines: { price_usd: number; qty: number }[]) => Math.round(lines.reduce((a, l) => a + l.price_usd * l.qty, 0) * 100) / 100;

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
      </section>

      {shops.map(s => {
        const f = fees[s.id];
        return (
          <section className="card stack" key={s.id}>
            <div className="row spread"><strong>{tr(s.name, L)}</strong><span>{money(shopSub(s.lines))}</span></div>
            {s.lines.map(l => <div className="row spread" key={l.product_id} style={{ fontSize: 14 }}><span><span className="qty">{l.qty}×</span> {tr(l.name, L)}</span><span>{money(l.price_usd * l.qty)}</span></div>)}
            {f === 'outside' && <div className="error">{labels.outsideZone}</div>}
            {f && f !== 'outside' && !courier && (
              <div className="row spread muted" style={{ fontSize: 13 }}>
                <span>{labels.deliveryFee}: {money(f.fee_usd)}</span>{f.eta_minutes != null && <span>{labels.eta} ~{f.eta_minutes} min</span>}
              </div>
            )}
          </section>
        );
      })}

      <section className="card stack">
        <textarea className="input" rows={2} placeholder={labels.orderNotes} value={notes} onChange={e => setNotes(e.target.value)} />
        <div className="row spread"><span>{labels.subtotal}</span><span>{money(subtotal)}</span></div>
        <div className="row spread"><span>{labels.deliveryFee}{shops.length > 1 && <span className="muted" style={{ fontSize: 12 }}> · {courier ? labels.oneFeeCourier : labels.feePerShop}</span>}</span><span>{feesReady && !anyOutside ? money(feeUsd) : '—'}</span></div>
        {courier && <div className="muted" style={{ fontSize: 13 }}>🚚 {labels.deliveredTogether}</div>}
        <div className="row spread" style={{ fontSize: 18 }}><strong>{labels.total}</strong><strong>{money(subtotal + feeUsd)}</strong></div>
        <div className="muted" style={{ fontSize: 13 }}>💵 {labels.payCash}</div>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="btn primary wide" disabled={!canOrder} onClick={submit}>{labels.placeOrder}</button>
      </section>
    </div>
  );
}
