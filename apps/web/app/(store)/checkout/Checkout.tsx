'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { friendlyError } from '@/lib/ui-text';
import { useCart } from '@/components/CartProvider';
import { useConfirm } from '@/components/ConfirmProvider';
import MapPicker from '@/components/MapPicker';
import { normalizePhone } from '@/lib/whatsapp';
import { formatMoney, placeOrder, placeBasket, pointToEwkt, t as tr, type DisplayCurrency, type Locale } from '@suqa/shared';

type Addr = { id: string; label: string | null; line1: string | null; line2: string | null; notes: string | null; phone: string | null; is_default: boolean; lat: number; lng: number };
type Draft = { id?: string; label: string; line1: string; line2: string; notes: string; lat: number; lng: number };
type Labels = Record<'checkout' | 'deliveryAddress' | 'newAddress' | 'addressLabel' | 'addressLine1' | 'addressLine2' | 'addressNotes' | 'phone' | 'pinLocation' | 'useMyLocation'
  | 'outsideZone' | 'orderNotes' | 'payCash' | 'placeOrder' | 'subtotal' | 'deliveryFee' | 'total' | 'minOrder' | 'save' | 'cancel' | 'emptyCart' | 'browseShops' | 'eta'
  | 'oneFeeCourier' | 'feePerShop' | 'deliveredTogether' | 'contactPhone' | 'phoneRequired' | 'editAddress' | 'deleteAddress' | 'pinHint' | 'confirm', string>;

const addrText = (a: Addr) => [a.line1, a.line2].filter(Boolean).join(', ');

export default function Checkout(props: { tenantId: string; locale: Locale; fx: number; displayCurrency: DisplayCurrency; addresses: Addr[]; defaultPhone: string; center: { lat: number; lng: number }; deliveryMode: 'per_shop' | 'courier'; courierFee: number | null; labels: Labels }) {
  const { tenantId, locale: L, fx, displayCurrency, deliveryMode, courierFee, labels } = props;
  const router = useRouter();
  const ask = useConfirm();
  const sb = useMemo(() => supabaseBrowser(), []);
  const { selectedShops: shops, selectedSubtotal: subtotal, selectedCount: count, removeShops } = useCart();
  const shopKey = shops.map(s => s.id).join(',');
  const money = (v: number) => formatMoney(v, fx, displayCurrency, L);

  // Contact phone is a checkout field: prefilled from the profile (or the default address), saved back on order.
  const [phone, setPhone] = useState(props.defaultPhone || props.addresses.find(a => a.is_default)?.phone || props.addresses[0]?.phone || '');
  const phoneOk = !!normalizePhone(phone);

  const [addresses, setAddresses] = useState<Addr[]>(props.addresses);
  const [selected, setSelected] = useState<string | null>(props.addresses.find(a => a.is_default)?.id ?? props.addresses[0]?.id ?? null);
  const blank = (): Draft => ({ label: '', line1: '', line2: '', notes: '', lat: props.center.lat, lng: props.center.lng });
  const [draft, setDraft] = useState<Draft | null>(props.addresses.length === 0 ? blank() : null);   // null = form closed; id set = editing
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

  function startEdit(a: Addr) { setDraft({ id: a.id, label: a.label ?? '', line1: a.line1 ?? '', line2: a.line2 ?? '', notes: a.notes ?? '', lat: a.lat, lng: a.lng }); }

  async function saveAddress() {
    if (!draft) return;
    setBusy(true); setError(null);
    const row = { label: draft.label.trim() || null, line1: draft.line1.trim() || null, line2: draft.line2.trim() || null, notes: draft.notes.trim() || null, location: pointToEwkt(draft) };
    if (draft.id) {
      const { error } = await sb.from('addresses').update(row).eq('id', draft.id);
      setBusy(false);
      if (error) { setError(friendlyError(error, L)); return; }
      setAddresses(prev => prev.map(a => a.id === draft.id ? { ...a, ...row, lat: draft.lat, lng: draft.lng } : a));
      setSelected(draft.id); setDraft(null);
    } else {
      const { data: sess } = await sb.auth.getSession();
      const { data, error } = await sb.from('addresses').insert({ ...row, tenant_id: tenantId, user_id: sess.session!.user.id, phone: normalizePhone(phone) ? `+${normalizePhone(phone)}` : null, is_default: addresses.length === 0 })
        .select('id,label,line1,line2,notes,phone,is_default').single();
      setBusy(false);
      if (error) { setError(friendlyError(error, L)); return; }
      const a: Addr = { ...(data as any), lat: draft.lat, lng: draft.lng };
      setAddresses(prev => [...prev, a]); setSelected(a.id); setDraft(null);
    }
  }

  async function deleteAddress(a: Addr) {
    if (!(await ask(`${labels.deleteAddress}: ${a.label || addrText(a) || '—'}?`, { danger: true, confirmLabel: labels.deleteAddress }))) return;
    const { error } = await sb.from('addresses').delete().eq('id', a.id);
    if (error) { setError(friendlyError(error, L)); return; }
    const rest = addresses.filter(x => x.id !== a.id);
    setAddresses(rest); if (selected === a.id) setSelected(rest[0]?.id ?? null); if (!rest.length) setDraft(blank());
  }

  async function submit() {
    if (!shops.length || !selected) return;
    if (!phoneOk) { setError(labels.phoneRequired); return; }
    setBusy(true); setError(null);
    const ids = shops.map(s => s.id);
    const ph = `+${normalizePhone(phone)}`;
    try {
      if (shops.length === 1) {
        const s = shops[0];
        const order = await placeOrder(sb, s.id, selected, s.lines.map(l => ({ product_id: l.product_id, quantity: l.qty })), notes.trim() || undefined, ph);
        removeShops(ids);
        router.replace(`/orders/${order.id}?placed=1`);
      } else {
        const basket = await placeBasket(sb, selected, shops.map(s => ({ shop_id: s.id, items: s.lines.map(l => ({ product_id: l.product_id, quantity: l.qty })) })), notes.trim() || undefined, ph);
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
  const canOrder = !!selected && phoneOk && feesReady && !anyOutside && !busy && !draft;
  const shopSub = (lines: { price_usd: number; qty: number }[]) => Math.round(lines.reduce((a, l) => a + l.price_usd * l.qty, 0) * 100) / 100;

  return (
    <div className="stack">
      <h1 style={{ margin: 0, fontSize: 20 }}>{labels.checkout}</h1>

      <section className="card stack">
        <label className="label" htmlFor="phone">{labels.phone}</label>
        <input id="phone" className="input" type="tel" inputMode="tel" autoComplete="tel" dir="ltr" placeholder="+961 70 000 000" value={phone} onChange={e => setPhone(e.target.value)}
          style={{ fontSize: 18, letterSpacing: 1 }} aria-invalid={!phoneOk} />
        <div className="muted" style={{ fontSize: 13 }}>{labels.contactPhone}</div>
      </section>

      <section className="card stack">
        <strong>{labels.deliveryAddress}</strong>
        {addresses.map(a => (
          <div key={a.id} className={`addr ${selected === a.id ? 'selected' : ''}`} onClick={() => { setSelected(a.id); if (draft && !draft.id) setDraft(null); }}>
            <div className="row spread">
              <strong>{a.label || addrText(a) || '📍'}</strong>
              <span className="row" style={{ gap: 4 }}>
                <button className="btn" style={{ padding: '2px 8px', fontSize: 13 }} onClick={e => { e.stopPropagation(); startEdit(a); }}>✎ {labels.editAddress}</button>
                {addresses.length > 1 && <button className="btn" style={{ padding: '2px 8px', fontSize: 13 }} onClick={e => { e.stopPropagation(); deleteAddress(a); }}>🗑</button>}
              </span>
            </div>
            {a.label && addrText(a) && <div style={{ fontSize: 14 }}>{addrText(a)}</div>}
            {a.notes && <div className="muted" style={{ fontSize: 13 }}>{a.notes}</div>}
          </div>
        ))}
        {!draft && <button className="btn" onClick={() => setDraft(blank())}>+ {labels.newAddress}</button>}
        {draft && (
          <div className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
            <div className="muted" style={{ fontSize: 13 }}>{labels.pinLocation}</div>
            <MapPicker value={{ lat: draft.lat, lng: draft.lng }} onChange={p => setDraft(d => d && ({ ...d, ...p }))} useMyLocationLabel={labels.useMyLocation} />
            <div className="muted" style={{ fontSize: 12 }}>{labels.pinHint}</div>
            <div><label className="label">{labels.addressLabel}</label><input className="input" value={draft.label} onChange={e => setDraft({ ...draft, label: e.target.value })} /></div>
            <div><label className="label">{labels.addressLine1}</label><input className="input" value={draft.line1} onChange={e => setDraft({ ...draft, line1: e.target.value })} /></div>
            <div><label className="label">{labels.addressLine2}</label><input className="input" value={draft.line2} onChange={e => setDraft({ ...draft, line2: e.target.value })} /></div>
            <div><label className="label">{labels.addressNotes}</label><input className="input" value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })} /></div>
            <div className="row spread">
              {addresses.length > 0 && <button className="btn" onClick={() => setDraft(null)}>{labels.cancel}</button>}
              <button className="btn primary" disabled={busy} onClick={saveAddress}>{labels.save}</button>
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
