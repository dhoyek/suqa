'use client';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { addToDraft, lineFromProduct, cancelDraft, commitSale, currentShift, draftTotals, dropDraft, fmtBoth, fmtLbp, fmtUsd, listParked, loadCurrentDraft, newDraft, newId, num, saveDraft, text,
  type CatalogIndex, type CommitResult, type Currency, type Draft, type DraftLine, type Product, type Rate, type Shift, type Staff, type SyncStatus } from '@suqa/pos-core';
import { doPrint, loadPrintSettings, receiptHtml } from '../lib/print';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import { useScanner } from '../lib/useScanner';
import { useShortcuts } from '../lib/useShortcuts';
import CustomerDialog from '../components/CustomerDialog';
import Modal, { NumPad } from '../components/Modal';
import LineEditor from '../components/LineEditor';
import PayDialog from '../components/PayDialog';
import Receipt from '../components/Receipt';
import OwnerPin from '../components/OwnerPin';
import CameraScanner from '../components/CameraScanner';
import ItemEditor from '../components/ItemEditor';

type Dialog = null | { k: 'newItem'; code: string } | { k: 'line'; id: string; field?: 'qty' | 'price' | 'discount' } | { k: 'pay' } | { k: 'park' } | { k: 'cancel' } | { k: 'discount' } | { k: 'open' } | { k: 'camera' } | { k: 'customer' };

/**
 * The sale screen. Left: search / scan / categories / quick buttons / grid. Right: the cart.
 * Everything reads the in-memory index and writes IndexedDB; the network is never awaited here.
 */
export default function Sell({ boot, sb, locale, index, tick, staff, status, busyRef, onGo, reindex, newOrderRequest, presetCustomer }: { boot: Booted; sb: SupabaseClient; locale: L; index: CatalogIndex; tick: number; staff: Staff; status: SyncStatus | null; busyRef: MutableRefObject<boolean>; onGo: (v: 'shift' | 'orders') => void; reindex: () => void; newOrderRequest?: number; presetCustomer?: { phone: string; name: string } | null }) {
  const shop = boot.shop;
  const [draft, setDraft] = useState<Draft>(() => newDraft('walkin'));
  const [q, setQ] = useState(''); const [cat, setCat] = useState<string | null>(null);
  const [rate, setRate] = useState(89500);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [receipt, setReceipt] = useState<CommitResult | null>(null);
  const [serverNo, setServerNo] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [parked, setParked] = useState<Awaited<ReturnType<typeof listParked>>>([]);
  const [members, setMembers] = useState<Staff[]>([]);
  const [shift, setShift] = useState<Shift | null | undefined>(undefined);
  const [fee, setFee] = useState(0);                                         // delivery fee (cents) for whatsapp/phone delivery orders
  const searchRef = useRef<HTMLInputElement>(null);
  const lbpStep = shop.lbp_rounding_step ?? 5000;
  const maxDisc = num(shop.max_discount_pct);

  // restore an unfinished cart (crash / tab close), rate, parked list, staff (for owner PIN)
  useEffect(() => { loadCurrentDraft(boot.db).then(d => { if (d) setDraft(d); }); }, [boot]);
  // "＋ new order" from the inbox: start a WhatsApp order and open the customer dialog
  useEffect(() => { if (newOrderRequest && presetCustomer) { setReceipt(null); setDraft(d => ({ ...(d.lines.length ? d : newDraft('whatsapp')), channel: 'whatsapp', customer_phone: presetCustomer.phone, customer_name: presetCustomer.name })); setDialog({ k: 'customer' }); return; } if (newOrderRequest) { setReceipt(null); setDraft(d => (d.lines.length ? { ...d, channel: 'whatsapp' } : { ...newDraft('whatsapp'), fulfillment: 'pickup' })); setDialog({ k: 'customer' }); } }, [newOrderRequest]);
  useEffect(() => { boot.db.rates.orderBy('effective_at').reverse().first().then((r: Rate | undefined) => { if (r) setRate(r.lbp_per_usd); }); listParked(boot.db).then(setParked); boot.db.staff.toArray().then(setMembers); currentShift(boot.db).then(setShift); }, [boot, tick]);
  // persist the cart (debounced) and flag "busy" so a SW update never lands mid-sale
  useEffect(() => { busyRef.current = draft.lines.length > 0 || !!dialog; const t = setTimeout(() => { if (draft.lines.length) void saveDraft(boot.db, draft); }, 400); return () => clearTimeout(t); }, [draft, dialog, boot.db, busyRef]);
  // the sold order's server number arrives through the feed
  useEffect(() => { if (receipt) boot.db.orders.get(receipt.order.id).then(o => { if (o?.number) setServerNo(o.number); }); }, [tick, receipt, boot.db]);

  const totals = useMemo(() => draftTotals(draft, rate, lbpStep), [draft, rate, lbpStep]);
  const isOrder = draft.channel !== 'walkin';
  const feeCents = isOrder && draft.fulfillment === 'delivery' ? fee : 0;
  const grand = totals.total_cents + feeCents;
  const results = useMemo(() => (q.trim() ? index.search(q, 60, cat) : index.byCategory(cat, 60)), [q, cat, index, tick]);
  const cats = useMemo(() => [...index.categories.values()].sort((a, b) => a.sort_order - b.sort_order), [index, tick]);
  const quick = useMemo(() => index.quickButtons.map(b => ({ b, p: b.product_id ? index.byId.get(b.product_id) : undefined })), [index, tick]);
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 1800); };

  const add = useCallback((p: Product, quantity = 1) => {
    if (p.track_stock) {
      const avail = num(p.on_hand) - num(p.reserved);
      const inCart = draft.lines.filter(l => l.product_id === p.id && !l.voided).reduce((s, l) => s + l.quantity, 0);
      if (avail - inCart - quantity < 0) { if (!shop.allow_negative_stock) { flash(pt('outOfStock', locale)); return; } flash(`${pt('outOfStock', locale)} (${avail})`); }
      else if (avail - inCart - quantity <= num(p.min_stock)) flash(`${pt('lowStock', locale)}: ${avail - inCart - quantity} ${pt('available', locale)}`);
    }
    setDraft(d => addToDraft(d, p, quantity)); setQ('');
  }, [draft.lines, shop.allow_negative_stock, locale]);

  const onScan = useCallback((code: string) => {
    if (receipt) return;
    const hit = index.scanEx(code, shop.scale_prefix ? { prefix: shop.scale_prefix, code_len: shop.scale_code_len, value_kind: shop.scale_value_kind, value_divisor: shop.scale_value_divisor } : null);
    if (!hit) { if (boot.role === 'owner' || boot.role === 'stock') setDialog({ k: 'newItem', code }); else flash(`${pt('unknownBarcode', locale)}: ${code}`); return; }
    if (!hit.pack && !hit.scale) { add(hit.product); return; }
    // pack barcode or scale label → its own line (quantity / price come from the barcode)
    const base = lineFromProduct(hit.product, hit.qty);
    const line: DraftLine = { ...base,
      ...(hit.unit_price_cents != null ? { unit_price_cents: hit.unit_price_cents, price_currency: 'usd' as const } : {}), ...(hit.unit_price_lbp != null && hit.unit_price_cents == null ? { unit_price_lbp: hit.unit_price_lbp, price_currency: 'lbp' as const } : {}),
      ...(hit.fixed_total_cents != null ? { unit_price_cents: hit.fixed_total_cents, price_currency: 'usd' as const, quantity: 1 } : {}), ...(hit.fixed_total_lbp != null ? { unit_price_lbp: hit.fixed_total_lbp, price_currency: 'lbp' as const, quantity: 1 } : {}),
      decimal_qty: base.decimal_qty || !!hit.scale, notes: hit.pack ? `${pt('pack', locale)} ${hit.pack.qty}` : hit.scale ? '⚖' : undefined };
    setDraft(d => ({ ...d, lines: [...d.lines, line] })); setQ('');
  }, [index, add, locale, receipt, boot.role, shop]);
  useScanner(onScan);

  const updateLine = (l: DraftLine) => setDraft(d => ({ ...d, lines: d.lines.map(x => (x.id === l.id ? l : x)) }));
  const voidLine = (id: string, reason: string) => setDraft(d => ({ ...d, lines: d.lines.map(x => (x.id === id ? { ...x, voided: true, void_reason: reason } : x)) }));
  const live = draft.lines.filter(l => !l.voided);

  const startNew = useCallback(async () => { setReceipt(null); setServerNo(null); setDraft(newDraft('walkin')); setDialog(null); searchRef.current?.focus(); }, []);
  const park = async (label: string) => { await saveDraft(boot.db, draft, true, label); setParked(await listParked(boot.db)); await startNew(); };
  const resume = async (id: string) => { const row = parked.find(p => p.id === id); if (!row) return; if (live.length) await saveDraft(boot.db, draft, true); await dropDraft(boot.db, id); setDraft(row.draft); setParked(await listParked(boot.db)); setDialog(null); };
  const cancel = async (reason: string) => { await cancelDraft(boot.db, draft, reason, staff.user_id); boot.engine.poke(); await startNew(); };

  const confirmPay = async (payments: Parameters<typeof commitSale>[1]['payments'], changeIn: Currency) => {
    const r = await commitSale(boot.db, { draft, payments, rate, lbpStep, changeIn, staff_user_id: staff.user_id, shift_id: shift?.id ?? null, delivery_fee_cents: feeCents, status: isOrder ? 'accepted' : undefined });
    await dropDraft(boot.db, draft.id);
    setDialog(null); setReceipt(r); boot.engine.poke();
    const ps = loadPrintSettings();
    if (ps.autoPrint) doPrint(receiptHtml(r.order, r.lines, r.payments, shop, locale, ps, { cashier: staff.display_name || staff.full_name || '' }));
  };

  const saveToOrders = async () => {
    if (!live.length || !isOrder) return;
    if (!draft.customer_phone) { setDialog({ k: 'customer' }); return; }
    await commitSale(boot.db, { draft, payments: [], rate, lbpStep, changeIn: 'usd', staff_user_id: staff.user_id, shift_id: shift?.id ?? null, delivery_fee_cents: feeCents, status: 'accepted' });
    await dropDraft(boot.db, draft.id); boot.engine.poke(); flash(pt('orderSaved', locale)); await startNew(); onGo('orders');
  };
  useShortcuts({
    F2: () => { setDialog(null); searchRef.current?.focus(); searchRef.current?.select(); },
    F4: () => { const l = live[live.length - 1]; if (l) setDialog({ k: 'line', id: l.id, field: 'qty' }); },
    F6: () => { if (live.length) setDialog({ k: 'discount' }); },
    F8: () => { if (live.length) setDialog({ k: 'pay' }); },
    F9: () => { if (live.length) setDialog({ k: 'park' }); },
    'ctrl+Delete': () => { if (live.length) setDialog({ k: 'cancel' }); },
  }, !receipt);

  if (receipt) return <Receipt result={receipt} shop={shop} locale={locale} cashier={staff.display_name || staff.full_name || ''} serverNumber={serverNo} onNew={startNew} />;
  if (shift === null) return (
    <div className="pos-center" style={{ minHeight: '60dvh' }}><div className="card stack" style={{ textAlign: 'center', maxWidth: 420 }}>
      <h3 style={{ margin: 0 }}>{pt('shiftRequired', locale)}</h3>
      <button className="btn primary big" onClick={() => onGo('shift')}>{pt('openShift', locale)}</button>
    </div></div>
  );

  return (
    <div className="pos-sell">
      <div className="pos-pane">
        <div className="row" style={{ gap: 8 }}>
          <input ref={searchRef} className="input big" style={{ flex: 1 }} placeholder={pt('searchItems', locale)} value={q} onChange={e => setQ(e.target.value)} autoFocus={typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches}
            onKeyDown={e => { if (e.key === 'Enter' && q.trim()) { const p = index.scan(q.trim()) ?? (results.length === 1 ? results[0] : null); if (p) add(p); } }} />
          <button className="btn big" style={{ width: 'auto' }} title={pt('cameraScan', locale)} onClick={() => setDialog({ k: 'camera' })}>📷</button>
          <button className="btn big" style={{ width: 'auto' }} title={pt('openItem', locale)} onClick={() => setDialog({ k: 'open' })}>＋</button>
        </div>
        {!!quick.length && <div className="quick-row">{quick.map(({ b, p }) => p ? <button key={b.id} className="quick" style={{ background: b.color ?? undefined }} onClick={() => add(p)}>{b.label || text(p.name, locale)}</button> : null)}</div>}
        <div className="chips">
          <button className={`chip ${cat === null ? 'active' : ''}`} onClick={() => setCat(null)}>{pt('all', locale)}</button>
          {cats.map(c => <button key={c.id} className={`chip ${cat === c.id ? 'active' : ''}`} onClick={() => setCat(c.id)}>{text(c.name, locale)}</button>)}
        </div>
        <div className="grid-items">
          {results.map(p => {
            const avail = num(p.on_hand) - num(p.reserved);
            return (
              <button key={p.id} className="item-tile" onClick={() => add(p)}>
                <div className="item-name">{text(p.name, locale)}</div>
                <div className="item-price">{p.price_currency === 'lbp' ? fmtLbp(num(p.price_lbp), locale) : fmtUsd(Math.round(num(p.price_usd) * 100))}</div>
                {p.track_stock && <div className={`muted ${avail <= num(p.min_stock) ? 'bad' : ''}`} style={{ fontSize: 12 }}>{avail} {pt('available', locale)}</div>}
              </button>
            );
          })}
          {!results.length && <p className="muted">{pt('noResults', locale)}</p>}
        </div>
      </div>

      <aside className="pos-pane cart">
        <div className="row spread" style={{ alignItems: 'center' }}>
          <strong>{pt('cart', locale)} {live.length ? `(${live.length})` : ''}</strong>
          <span className="row" style={{ gap: 6 }}>
            {!!parked.length && <button className="btn" onClick={() => setDialog({ k: 'park' })}>⏸ {parked.length}</button>}
            <button className={`btn ${isOrder ? 'primary' : 'icon'}`} title={pt('customer', locale)} onClick={() => setDialog({ k: 'customer' })}>{isOrder ? `${pt(draft.channel as 'whatsapp', locale)} · ${draft.customer_name || draft.customer_phone || '👤'}` : draft.customer_phone ? '👤✓' : '👤'}</button>
          </span>
        </div>
        <div className="cart-lines">
          {!live.length && <p className="muted" style={{ padding: 20, textAlign: 'center' }}>{pt('emptyCart', locale)}</p>}
          {live.map(l => (
            <div key={l.id} className="cart-line" onClick={() => setDialog({ k: 'line', id: l.id })}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="cart-name">{text(l.name, locale)}{l.notes ? <span className="muted"> · {l.notes}</span> : ''}</div>
                <div className="muted" style={{ fontSize: 12 }}>{l.quantity}{l.unit ? ` ${l.unit}` : ''} × {l.price_currency === 'usd' ? fmtUsd(l.unit_price_cents) : fmtLbp(l.unit_price_lbp, locale)}{l.discount_cents ? ` − ${fmtUsd(l.discount_cents)}` : ''}</div>
              </div>
              <div className="qty-btns" onClick={e => e.stopPropagation()}>
                <button onClick={() => updateLine({ ...l, quantity: Math.max(l.decimal_qty ? 0.001 : 1, l.quantity - 1) })}>−</button>
                <span>{l.quantity}</span>
                <button onClick={() => updateLine({ ...l, quantity: l.quantity + 1 })}>+</button>
                <button className="rm" title={pt('voidLine', locale)} onClick={() => updateLine({ ...l, voided: true })}>✕</button>
              </div>
              <strong className="num">{fmtUsd(Math.max(0, (l.price_currency === 'usd' ? Math.round(l.unit_price_cents * l.quantity) : Math.round((Math.round(l.unit_price_lbp * l.quantity) * 100) / rate)) - l.discount_cents))}</strong>
            </div>
          ))}
        </div>
        <div className="cart-totals">
          {totals.discount_cents > 0 && <div><span>{pt('discount', locale)}{draft.discount_reason ? ` · ${draft.discount_reason}` : ''}</span><span>−{fmtUsd(totals.discount_cents)}</span></div>}
          {feeCents > 0 && <div><span>{pt('deliveryFee', locale)}</span><span>{fmtUsd(feeCents)}</span></div>}
          <div className="big"><span>{pt('total', locale)}</span><span>{fmtUsd(grand)}</span></div>
          <div className="big lbp"><span></span><span>{fmtLbp(Math.round((grand * rate) / 100 / lbpStep) * lbpStep, locale)}</span></div>
          <div className="muted" style={{ fontSize: 11 }}>{rate.toLocaleString('en-US')} / $1</div>
        </div>
        <div className="cart-actions">
          <button className="btn" disabled={!live.length} onClick={() => setDialog({ k: 'discount' })}>{pt('discount', locale)} <kbd>F6</kbd></button>
          <button className="btn" disabled={!live.length} onClick={() => setDialog({ k: 'park' })}>{pt('park', locale)} <kbd>F9</kbd></button>
          <button className="btn danger" disabled={!live.length} onClick={() => setDialog({ k: 'cancel' })}>✕</button>
          {isOrder && <button className="btn primary pay" disabled={!live.length} onClick={saveToOrders}>📥 {pt('saveToOrders', locale)} · {fmtUsd(grand)} <span className="muted" style={{ fontSize: 11 }}>({pt('payAtHandover', locale)})</span></button>}
          <button className={`btn ${isOrder ? '' : 'primary'} pay`} disabled={!live.length} onClick={() => setDialog({ k: 'pay' })}>{pt('pay', locale)} {fmtUsd(grand)} <kbd>F8</kbd></button>
        </div>
      </aside>

      {toast && <div className="pos-toast">{toast}</div>}

      {dialog?.k === 'line' && (() => { const l = draft.lines.find(x => x.id === dialog.id); return l ? (
        <LineEditor line={l} locale={locale} rate={rate} maxDiscountPct={maxDisc} staff={members} me={staff} initialField={dialog.field}
          onChange={updateLine} onVoid={r => voidLine(l.id, r)} onClose={() => setDialog(null)} />) : null; })()}
      {dialog?.k === 'pay' && <PayDialog totalCents={grand} rate={rate} lbpStep={lbpStep} locale={locale} customer={{ name: draft.customer_name, phone: draft.customer_phone }} boot={boot} isOwner={boot.role === 'owner'} onConfirm={confirmPay} onClose={() => setDialog(null)} />}
      {dialog?.k === 'newItem' && <ItemEditor boot={boot} locale={locale} index={index} product={null} presetBarcode={dialog.code} staff={members} me={staff} onDone={p => { setDialog(null); reindex(); add(p); }} onClose={() => setDialog(null)} />}
      {dialog?.k === 'camera' && <CameraScanner open locale={locale} onScan={onScan} onClose={() => setDialog(null)} />}
      {dialog?.k === 'open' && <OpenItem locale={locale} rate={rate} onAdd={l => { setDraft(d => ({ ...d, lines: [...d.lines, l] })); setDialog(null); }} onClose={() => setDialog(null)} />}
      {dialog?.k === 'discount' && <OrderDiscount locale={locale} draft={draft} subtotal={totals.subtotal_cents} maxPct={maxDisc} staff={members} me={staff} onApply={(cents, reason, by) => { setDraft(d => ({ ...d, discount_cents: cents, discount_reason: reason, approved_by: by ?? d.approved_by })); setDialog(null); }} onClose={() => setDialog(null)} />}
      {dialog?.k === 'park' && <ParkDialog locale={locale} parked={parked} canPark={!!live.length} onPark={park} onResume={resume} onClose={() => setDialog(null)} />}
      {dialog?.k === 'cancel' && <ReasonDialog locale={locale} title={pt('cancelSale', locale)} onDone={cancel} onClose={() => setDialog(null)} />}
      {dialog?.k === 'customer' && <CustomerDialog boot={boot} sb={sb} locale={locale} draft={draft} fee={fee} online={status?.online ?? true} onDone={r => {
        setDraft(d => { let n = { ...d, ...r.patch }; if (r.repeat) for (const l of r.repeat) { const p = l.product_id ? index.byId.get(l.product_id) : undefined; if (p) n = addToDraft(n, p, num(l.quantity)); } return n; });
        setFee(r.feeCents); setDialog(null); }} onClose={() => setDialog(null)} />}
    </div>
  );
}

function OpenItem({ locale, rate, onAdd, onClose }: { locale: L; rate: number; onAdd: (l: DraftLine) => void; onClose: () => void }) {
  const [name, setName] = useState(''); const [price, setPrice] = useState(''); const [cur, setCur] = useState<Currency>('usd');
  const ok = name.trim() && Number(price) > 0;
  const submit = () => { if (!ok) return; onAdd({ id: newId(), product_id: null, name: { ar: name.trim(), en: name.trim() }, quantity: 1, price_currency: cur, unit_price_cents: cur === 'usd' ? Math.round(Number(price) * 100) : 0, unit_price_lbp: cur === 'lbp' ? Math.round(Number(price)) : 0, discount_cents: 0, track_stock: false, decimal_qty: true }); };
  return (
    <Modal open onClose={onClose} title={pt('openItem', locale)} footer={<><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><button className="btn primary" disabled={!ok} onClick={submit}>{pt('ok', locale)}</button></>}>
      <label className="label">{pt('itemName', locale)}</label><input className="input" value={name} onChange={e => setName(e.target.value)} autoFocus onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
      <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 8 }}>
        <label className="label" style={{ margin: 0 }}>{pt('price', locale)}</label>
        <div className="seg"><button className={cur === 'usd' ? 'active' : ''} onClick={() => setCur('usd')}>$</button><button className={cur === 'lbp' ? 'active' : ''} onClick={() => setCur('lbp')}>ل.ل.</button></div>
        <strong style={{ marginInlineStart: 'auto' }}>{price || '0'}</strong>
      </div>
      <NumPad value={price} onChange={setPrice} decimal={cur === 'usd'} onEnter={submit} />
      <p className="muted" style={{ fontSize: 12 }}>{cur === 'usd' ? fmtBoth(Math.round(Number(price || 0) * 100), rate, locale) : ''}</p>
    </Modal>
  );
}

function OrderDiscount({ locale, draft, subtotal, maxPct, staff, me, onApply, onClose }: { locale: L; draft: Draft; subtotal: number; maxPct: number; staff: Staff[]; me: Staff; onApply: (cents: number, reason: string, approvedBy?: string | null) => void; onClose: () => void }) {
  const [mode, setMode] = useState<'pct' | 'amt'>('pct'); const [v, setV] = useState(draft.discount_cents ? (draft.discount_cents / 100).toString() : ''); const [reason, setReason] = useState(draft.discount_reason ?? ''); const [gate, setGate] = useState(false);
  const cents = mode === 'pct' ? Math.round((subtotal * Math.min(100, Number(v) || 0)) / 100) : Math.min(subtotal, Math.round((Number(v) || 0) * 100));
  const pct = subtotal ? (cents / subtotal) * 100 : 0;
  const needsOwner = me.role !== 'owner' && pct > maxPct && !draft.approved_by;
  const apply = (by?: string | null) => onApply(cents, reason.trim(), by);
  return (
    <>
      <Modal open onClose={onClose} title={pt('orderDiscount', locale)} footer={<><button className="btn ghost" onClick={() => onApply(0, '', null)}>0</button><span style={{ flex: 1 }} /><button className="btn primary" disabled={!cents} onClick={() => (needsOwner ? setGate(true) : apply())}>{pt('ok', locale)}</button></>}>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <div className="seg"><button className={mode === 'pct' ? 'active' : ''} onClick={() => { setMode('pct'); setV(''); }}>%</button><button className={mode === 'amt' ? 'active' : ''} onClick={() => { setMode('amt'); setV(''); }}>$</button></div>
          <strong style={{ marginInlineStart: 'auto', fontSize: 22 }}>{v || '0'}{mode === 'pct' ? '%' : '$'}</strong>
        </div>
        <NumPad value={v} onChange={setV} />
        <div className="muted" style={{ fontSize: 13, margin: '6px 0' }}>= {fmtUsd(cents)} ({pct.toFixed(1)}%){needsOwner && <span className="bad"> · {pt('ownerPin', locale)} (&gt; {maxPct}%)</span>}</div>
        <label className="label">{pt('discountReason', locale)}</label><input className="input" value={reason} onChange={e => setReason(e.target.value)} />
      </Modal>
      {gate && <OwnerPin open locale={locale} staff={staff} me={me} reason={`${pt('discount', locale)} ${pct.toFixed(0)}%`} onDone={id => { setGate(false); if (id) apply(id); }} />}
    </>
  );
}

function ParkDialog({ locale, parked, canPark, onPark, onResume, onClose }: { locale: L; parked: Awaited<ReturnType<typeof listParked>>; canPark: boolean; onPark: (label: string) => void; onResume: (id: string) => void; onClose: () => void }) {
  const [label, setLabel] = useState('');
  return (
    <Modal open onClose={onClose} title={pt('park', locale)}>
      {canPark && <div className="row" style={{ gap: 8 }}><input className="input" placeholder={pt('customerName', locale)} value={label} onChange={e => setLabel(e.target.value)} autoFocus onKeyDown={e => { if (e.key === 'Enter') onPark(label); }} /><button className="btn primary" onClick={() => onPark(label)}>⏸ {pt('park', locale)}</button></div>}
      {!!parked.length && <h4>{pt('parked', locale)}</h4>}
      <ul className="tender-list">{parked.map(p => <li key={p.id}><span>{p.label || '—'} <span className="muted">· {p.draft.lines.filter(l => !l.voided).length} · {new Date(p.updated_at).toLocaleTimeString(locale === 'ar' ? 'ar-LB-u-nu-latn' : 'en-GB', { hour: '2-digit', minute: '2-digit' })}</span></span><button className="btn" onClick={() => onResume(p.id)}>{pt('resume', locale)}</button></li>)}</ul>
    </Modal>
  );
}

function ReasonDialog({ locale, title, onDone, onClose }: { locale: L; title: string; onDone: (reason: string) => void; onClose: () => void }) {
  const [r, setR] = useState('');
  return <Modal open onClose={onClose} title={title} footer={<><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><button className="btn danger" onClick={() => onDone(r.trim())}>{title}</button></>}>
    <label className="label">{pt('cancelReason', locale)}</label><input className="input" value={r} onChange={e => setR(e.target.value)} autoFocus onKeyDown={e => { if (e.key === 'Enter') onDone(r.trim()); }} />
  </Modal>;
}
