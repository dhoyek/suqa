'use client';
import { useEffect, useMemo, useState } from 'react';
import { commonDays, weekdayName, weekdaysLabel } from '@/lib/weekdays';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { friendlyError } from '@/lib/ui-text';
import { useCart, orderItems } from '@/components/CartProvider';
import { useConfirm } from '@/components/ConfirmProvider';
import MapPicker from '@/components/MapPicker';
import { normalizePhone } from '@/lib/whatsapp';
import { formatMoneySum, rateOf, type Rates } from '@/lib/shop-money';
import { formatMoney, placeOrder, placeBasket, pointToEwkt, t as tr, type DisplayCurrency, type Locale } from '@suqa/shared';

type Addr = { id: string; label: string | null; line1: string | null; line2: string | null; notes: string | null; phone: string | null; is_default: boolean; lat: number; lng: number };
type Draft = { id?: string; label: string; line1: string; line2: string; notes: string; lat: number; lng: number };
type Labels = Record<'checkout' | 'deliveryAddress' | 'newAddress' | 'addressLabel' | 'addressLine1' | 'addressLine2' | 'addressNotes' | 'phone' | 'pinLocation' | 'useMyLocation'
  | 'outsideZone' | 'orderNotes' | 'payCash' | 'placeOrder' | 'subtotal' | 'deliveryFee' | 'total' | 'minOrder' | 'save' | 'cancel' | 'emptyCart' | 'browseShops' | 'eta'
  | 'oneFeeCourier' | 'feePerShop' | 'deliveredTogether' | 'contactPhone' | 'phoneRequired' | 'editAddress' | 'deleteAddress' | 'pinHint' | 'confirm'
  | 'fulfillment' | 'deliveryOption' | 'pickup' | 'pickupNotOffered' | 'changePhone' | 'suggestedFromShop', string>;

const addrText = (a: Addr) => [a.line1, a.line2].filter(Boolean).join(', ');

export default function Checkout(props: { tenantId: string; locale: Locale; fx: number; rates?: Rates; displayCurrency: DisplayCurrency; addresses: Addr[]; defaultPhone: string; center: { lat: number; lng: number }; deliveryMode: 'per_shop' | 'courier'; courierFee: number | null; labels: Labels; suggested?: { line1?: string; lat?: number; lng?: number; label?: string } | null }) {
  const { tenantId, locale: L, fx, displayCurrency, deliveryMode, courierFee, labels } = props;
  const router = useRouter();
  const ask = useConfirm();
  const sb = useMemo(() => supabaseBrowser(), []);
  const { selectedShops: shops, selectedSubtotal: subtotal, selectedCount: count, removeShops } = useCart();
  const shopKey = shops.map(s => s.id).join(',');
  // each shop's lira at its own rate (103) — the rate its order will be stored at; a sum across shops adds their lira up
  const rate = (shopId: string) => rateOf(props.rates, shopId, fx);
  const moneyAt = (shopId: string) => (v: number) => formatMoney(v, rate(shopId), displayCurrency, L);
  const sumMoney = (parts: { usd: number; rate: number }[]) => formatMoneySum(parts, displayCurrency, L);

  // Contact phone is a checkout field: prefilled from the profile (or the default address), saved back on order.
  const [phone, setPhone] = useState(props.defaultPhone || props.addresses.find(a => a.is_default)?.phone || props.addresses[0]?.phone || '');
  const phoneOk = !!normalizePhone(phone);
  // delivery vs pickup — pickup only when every selected shop offers it
  const pickupOk = shops.length > 0 && shops.every(s => s.pickup_enabled !== false);
  const [pickup, setPickup] = useState(false);

  const [addresses, setAddresses] = useState<Addr[]>(props.addresses);
  const [selected, setSelected] = useState<string | null>(props.addresses.find(a => a.is_default)?.id ?? props.addresses[0]?.id ?? null);
  const blank = (): Draft => ({ label: '', line1: '', line2: '', notes: '', lat: props.center.lat, lng: props.center.lng });
  // first web checkout of a customer the shop already knows (phone/WhatsApp orders) → start from that address
  const fromShop = (): Draft => ({ ...blank(), label: props.suggested?.label ?? '', line1: props.suggested?.line1 ?? '', lat: props.suggested?.lat ?? props.center.lat, lng: props.suggested?.lng ?? props.center.lng });
  const [draft, setDraft] = useState<Draft | null>(props.addresses.length === 0 ? (props.suggested ? fromShop() : blank()) : null);   // null = form closed; id set = editing
  const [editPhone, setEditPhone] = useState(!normalizePhone(props.defaultPhone || props.addresses.find(a => a.is_default)?.phone || props.addresses[0]?.phone || ''));
  // per shop: zone fee + ETA, or 'outside' when the address is not served by that shop
  const [fees, setFees] = useState<Record<string, { fee_usd: number; eta_minutes: number | null } | 'outside'>>({});
  const [notes, setNotes] = useState('');
  // When the order is wanted: as soon as possible, or a chosen day + time (up to a week ahead).
  // Items sold on some weekdays only decide which days can be picked.
  const ar = L === 'ar';
  const allowedDays = useMemo(() => commonDays(shops.flatMap(s => s.lines)), [shops]);
  const dayOptions = useMemo(() => Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + i); return d; }), []);
  const dayOk = (d: Date) => !allowedDays || allowedDays.includes(d.getDay());
  const todayOk = dayOk(new Date());
  const [later, setLater] = useState(false);
  const [day, setDay] = useState<number | null>(null);          // index into dayOptions
  const [time, setTime] = useState('');
  const mustSchedule = !todayOk;                                  // a weekday-only item that is not sold today
  const isLater = later || mustSchedule;
  const timeOptions = useMemo(() => {
    const out: string[] = []; const now = new Date(); const soon = now.getHours() * 60 + now.getMinutes() + 45;
    for (let m = 7 * 60; m <= 23 * 60 + 30; m += 30) if (day !== 0 || m >= soon) out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
    return out;
  }, [day]);
  useEffect(() => { if (time && !timeOptions.includes(time)) setTime(''); }, [timeOptions, time]);
  useEffect(() => { if (day != null && !dayOk(dayOptions[day])) setDay(null); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [allowedDays]);
  const neededAt = isLater && day != null && time ? (() => { const d = new Date(dayOptions[day]); const [h, m] = time.split(':').map(Number); d.setHours(h, m, 0, 0); return d.toISOString(); })() : null;
  const whenOk = allowedDays?.length === 0 ? false : isLater ? !!neededAt : true;
  const limitedNames = shops.flatMap(s => s.lines).filter(l => l.days?.length).map(l => `${tr(l.name, L)} (${weekdaysLabel(l.days!, L)})`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Delivery fee preview per shop for the selected address (zone lookup is a stable RPC).
  useEffect(() => {
    const a = addresses.find(x => x.id === selected);
    if (!a || !shopKey || pickup) { setFees({}); return; }
    let live = true;
    Promise.all(shops.map(s => sb.rpc('find_zone', { p_tenant: tenantId, p_shop: s.id, p_point: pointToEwkt(a) }).then(({ data }) => {
      const z = Array.isArray(data) ? data[0] : data;
      return [s.id, z?.zone_id ? { fee_usd: Number(z.fee_usd), eta_minutes: z.eta_minutes as number | null } : 'outside'] as const;
    }))).then(entries => { if (live) setFees(Object.fromEntries(entries)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, addresses, shopKey, sb, tenantId, pickup]);

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
    if (!shops.length || (!pickup && !selected)) return;
    if (!phoneOk) { setError(labels.phoneRequired); return; }
    setBusy(true); setError(null);
    const ids = shops.map(s => s.id);
    const ph = `+${normalizePhone(phone)}`;
    try {
      if (shops.length === 1) {
        const s = shops[0];
        const order = await placeOrder(sb, s.id, pickup ? null : selected, (orderItems(s.lines) as never), notes.trim() || undefined, ph, pickup ? 'pickup' : 'delivery', neededAt);
        removeShops(ids);
        router.replace(`/orders/${order.id}?placed=1`);
      } else {
        const basket = await placeBasket(sb, pickup ? null : selected, shops.map(s => ({ shop_id: s.id, items: (orderItems(s.lines) as never) })), notes.trim() || undefined, ph, pickup ? 'pickup' : 'delivery', neededAt);
        removeShops(ids);
        router.replace(`/orders/b/${basket.id}?placed=1`);
      }
    } catch (e: any) { setError(friendlyError(e, L)); setBusy(false); }
  }

  if (!count) return <div className="card stack" style={{ textAlign: 'center' }}><p className="muted">{labels.emptyCart}</p><Link className="btn primary" href="/">{labels.browseShops}</Link></div>;
  const feeStates = shops.map(s => fees[s.id]);
  const feesReady = pickup || (feeStates.length === shops.length && feeStates.every(f => f !== undefined));
  const anyOutside = !pickup && feeStates.some(f => f === 'outside');
  const perShopFees = shops.reduce((sum, s) => { const f = fees[s.id]; return sum + (f && f !== 'outside' ? f.fee_usd : 0); }, 0);
  const maxZoneFee = shops.reduce((m, s) => { const f = fees[s.id]; return Math.max(m, f && f !== 'outside' ? f.fee_usd : 0); }, 0);
  const courier = shops.length > 1 && deliveryMode === 'courier';
  const feeUsd = pickup ? 0 : courier ? (courierFee ?? maxZoneFee) : perShopFees;
  const canOrder = (pickup || !!selected) && phoneOk && feesReady && !anyOutside && !busy && (!draft || pickup) && whenOk;
  const addressStep = !pickup && !!draft;          // the address form is open: saving it is the next thing to do
  // why the order cannot be placed yet, in the customer's words (first thing that is missing)
  const blocker = !phoneOk ? (ar ? 'أدخل رقم هاتفك في أعلى الصفحة' : 'Enter your phone number at the top')
    : !pickup && !selected ? (ar ? 'اختر عنوان التوصيل' : 'Choose a delivery address')
    : anyOutside ? labels.outsideZone
    : !whenOk ? (ar ? 'اختر اليوم والوقت' : 'Pick the day and time')
    : !feesReady ? (ar ? 'جارٍ حساب رسوم التوصيل…' : 'Working out the delivery fee…') : '';
  const shopSub = (lines: { price_usd: number; qty: number }[]) => Math.round(lines.reduce((a, l) => a + l.price_usd * l.qty, 0) * 100) / 100;
  // the same sums, shop by shop, for the lira: an order's lira is its own total at its shop's rate (one shared courier fee: the association's rate)
  const feeOf = (shopId: string) => { const f = fees[shopId]; return f && f !== 'outside' ? Number(f.fee_usd) : 0; };
  const subParts = shops.map(s => ({ usd: shopSub(s.lines), rate: rate(s.id) }));
  const feeParts = pickup ? [] : courier ? [{ usd: feeUsd, rate: Number(fx) }] : shops.map(s => ({ usd: feeOf(s.id), rate: rate(s.id) }));
  const totalParts = pickup ? subParts : courier ? [...subParts, ...feeParts] : shops.map(s => ({ usd: shopSub(s.lines) + feeOf(s.id), rate: rate(s.id) }));

  return (
    <div className="stack">
      <h1 style={{ margin: 0, fontSize: 20 }}>{labels.checkout}</h1>

      <section className="card stack">
        {editPhone ? <>
          <label className="label" htmlFor="phone">{labels.phone}</label>
          <input id="phone" className="input" type="tel" inputMode="tel" autoComplete="tel" dir="ltr" placeholder="+961 70 000 000" value={phone} onChange={e => setPhone(e.target.value)}
            style={{ fontSize: 18, letterSpacing: 1 }} aria-invalid={!phoneOk} autoFocus={!phoneOk} />
          <div className="muted" style={{ fontSize: 13 }}>{labels.contactPhone}</div>
        </> : <div className="row spread" style={{ alignItems: 'center' }}><span>📞 <strong dir="ltr">{phone}</strong></span><button className="btn" style={{ padding: '4px 10px', fontSize: 13 }} onClick={() => setEditPhone(true)}>{labels.changePhone}</button></div>}
      </section>

      {pickupOk && (
        <section className="card stack">
          <strong>{labels.fulfillment}</strong>
          <div className="seg" role="tablist">
            <button type="button" role="tab" aria-selected={!pickup} className={!pickup ? 'active' : ''} onClick={() => setPickup(false)}>🛵 {labels.deliveryOption}</button>
            <button type="button" role="tab" aria-selected={pickup} className={pickup ? 'active' : ''} onClick={() => setPickup(true)}>🛍️ {labels.pickup}</button>
          </div>
        </section>
      )}
      {!pickup && <section className="card stack">
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
            {!draft.id && props.suggested && addresses.length === 0 && <div className="pill warn" style={{ alignSelf: 'start' }}>💡 {labels.suggestedFromShop}</div>}
            <div className="muted" style={{ fontSize: 13 }}>{labels.pinLocation}</div>
            <MapPicker value={{ lat: draft.lat, lng: draft.lng }} onChange={p => setDraft(d => d && ({ ...d, ...p }))} useMyLocationLabel={labels.useMyLocation} />
            <div className="muted" style={{ fontSize: 12 }}>{labels.pinHint}</div>
            <div><label className="label">{labels.addressLabel}</label><input className="input" value={draft.label} onChange={e => setDraft({ ...draft, label: e.target.value })} /></div>
            <div><label className="label">{labels.addressLine1}</label><input className="input" value={draft.line1} onChange={e => setDraft({ ...draft, line1: e.target.value })} /></div>
            <div><label className="label">{labels.addressLine2}</label><input className="input" value={draft.line2} onChange={e => setDraft({ ...draft, line2: e.target.value })} /></div>
            <div><label className="label">{labels.addressNotes}</label><input className="input" value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })} /></div>
            <div className="row spread">
              {addresses.length > 0 && <button className="btn" onClick={() => setDraft(null)}>{labels.cancel}</button>}
              <button className="btn primary" disabled={busy} onClick={saveAddress}>📍 {ar ? 'حفظ العنوان والمتابعة' : 'Save address and continue'}</button>
            </div>
          </div>
        )}
      </section>}

      <section className="card stack">
        <strong>{ar ? 'متى تريد الطلب؟' : 'When do you want it?'}</strong>
        {!!limitedNames.length && <div style={{ fontSize: 13, color: '#b45309' }}>📅 {limitedNames.join(ar ? ' · ' : ' · ')}</div>}
        {allowedDays?.length === 0
          ? <div className="error">{ar ? 'في سلتك أصناف لا تُباع في يوم مشترك — اطلبها في طلبين منفصلين.' : 'Your cart has items with no day in common — please order them separately.'}</div>
          : <>
            <div className="seg" role="tablist">
              <button type="button" role="tab" aria-selected={!isLater} disabled={mustSchedule} className={!isLater ? 'active' : ''} onClick={() => setLater(false)}>⚡ {ar ? 'في أقرب وقت' : 'As soon as possible'}</button>
              <button type="button" role="tab" aria-selected={isLater} className={isLater ? 'active' : ''} onClick={() => setLater(true)}>📅 {ar ? 'اختر يوماً ووقتاً' : 'Pick a day and time'}</button>
            </div>
            {mustSchedule && <div className="muted" style={{ fontSize: 13 }}>{ar ? 'هذا الطلب غير متوفّر اليوم — اختر يوماً من الأيام المتاحة.' : 'This order is not available today — pick one of the available days.'}</div>}
            {isLater && <>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {dayOptions.map((d, i) => <button type="button" key={i} className={`btn ${day === i ? 'primary' : ''}`} disabled={!dayOk(d)} style={{ padding: '6px 10px', fontSize: 14, opacity: dayOk(d) ? 1 : .4 }} onClick={() => setDay(i)}>
                  {i === 0 ? (ar ? 'اليوم' : 'Today') : i === 1 ? (ar ? 'غداً' : 'Tomorrow') : weekdayName(d.getDay(), L)} <span className="muted" dir="ltr" style={{ fontSize: 12 }}>{d.getDate()}/{d.getMonth() + 1}</span>
                </button>)}
              </div>
              {day != null && <select className="input" value={time} onChange={e => setTime(e.target.value)} aria-label={ar ? 'الوقت' : 'Time'}>
                <option value="">{ar ? 'اختر الوقت' : 'Choose a time'}</option>
                {timeOptions.map(t => <option key={t} value={t}>{t}</option>)}
              </select>}
              <div className="muted" style={{ fontSize: 12 }}>{ar ? 'المتجر يؤكّد الموعد عند قبول الطلب.' : 'The shop confirms the time when it accepts the order.'}</div>
            </>}
          </>}
      </section>

      {shops.map(s => {
        const f = fees[s.id]; const money = moneyAt(s.id);
        return (
          <section className="card stack" key={s.id}>
            <div className="row spread"><strong>{tr(s.name, L)}</strong><span>{money(shopSub(s.lines))}</span></div>
            {s.lines.map(l => <div className="row spread" key={l.product_id} style={{ fontSize: 14 }}><span><span className="qty">{l.qty}×</span> {l.bundle ? '🎁 ' : ''}{tr(l.name, L)}{l.bundle && <span className="muted"> ({l.bundle.items.map(i => `${i.qty}× ${tr(i.name, L)}`).join(' · ')})</span>}{l.notes && <span className="muted"> · 📝 {l.notes}</span>}</span><span>{formatMoney(l.price_usd * l.qty, rate(s.id), displayCurrency, L, l.lbp ? l.lbp * l.qty : null)}</span></div>)}
            {f === 'outside' && <div className="error">{labels.outsideZone}</div>}
            {f && f !== 'outside' && !courier && !pickup && (
              <div className="row spread muted" style={{ fontSize: 13 }}>
                <span>{labels.deliveryFee}: {money(f.fee_usd)}</span>{f.eta_minutes != null && <span>{labels.eta} ~{f.eta_minutes} min</span>}
              </div>
            )}
          </section>
        );
      })}

      <section className="card stack">
        <textarea className="input" rows={2} placeholder={labels.orderNotes} value={notes} onChange={e => setNotes(e.target.value)} />
        <div className="row spread"><span>{labels.subtotal}</span><span>{sumMoney(subParts)}</span></div>
        {!pickup && <div className="row spread"><span>{labels.deliveryFee}{shops.length > 1 && <span className="muted" style={{ fontSize: 12 }}> · {courier ? labels.oneFeeCourier : labels.feePerShop}</span>}</span><span>{feesReady && !anyOutside ? sumMoney(feeParts) : '—'}</span></div>}
        {pickup && <div className="muted" style={{ fontSize: 13 }}>🛍️ {labels.pickup}</div>}
        {courier && !pickup && <div className="muted" style={{ fontSize: 13 }}>🚚 {labels.deliveredTogether}</div>}
        <div className="row spread" style={{ fontSize: 18 }}><strong>{labels.total}</strong><strong>{sumMoney(totalParts)}</strong></div>
        <div className="muted" style={{ fontSize: 13 }}>💵 {labels.payCash}</div>
        {error && <div className="error" role="alert">{error}</div>}
        {addressStep
          ? <button className="btn primary wide checkout-inline" disabled={busy} onClick={saveAddress}>📍 {ar ? 'حفظ العنوان والمتابعة' : 'Save address and continue'}</button>
          : <button className="btn primary wide checkout-inline" disabled={!canOrder} onClick={submit}>{labels.placeOrder}</button>}
      </section>
      {/* One button at the bottom, always the next step: while the address form is open it SAVES THE ADDRESS (people used to
          stare at a greyed-out "confirm" and never find the save button further up); otherwise it places the order, and when
          it cannot, it says what is missing instead of just being grey. */}
      <div className="cart-bar checkout-bar">
        {addressStep
          ? <button className="btn primary wide" disabled={busy} onClick={saveAddress}>📍 {ar ? 'حفظ العنوان والمتابعة' : 'Save address and continue'}</button>
          : <>
            {!canOrder && !busy && blocker && <div style={{ background: '#fff8e6', color: '#92400e', borderRadius: 10, padding: '6px 10px', fontSize: 13, marginBottom: 6, textAlign: 'center' }}>{blocker}</div>}
            <button className="btn primary wide row spread" disabled={!canOrder} onClick={submit}><span>{labels.placeOrder}</span><span>{sumMoney(totalParts)}</span></button>
          </>}
      </div>
    </div>
  );
}
