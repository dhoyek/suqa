'use client';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { addToDraft, lineFromProduct, cancelDraft, commitSale, currentShift, debtLines, draftTotals, dropDraft, fmtBoth, fmtLbp, fmtUsd, listParked, loadCurrentDraft, newDraft, newId, num, saveDraft, searchCustomers, text, editOrder, type ShopCustomer, type Order, type OrderLine,
  type CatalogIndex, type CommitResult, type Currency, type Draft, type DraftLine, type Product, type Rate, type Shift, type Staff, type SyncStatus, scaleConfigs } from '@suqa/pos-core';
import { doPrint, loadPrintSettings, orderSheetHtml, receiptHtml } from '../lib/print';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import { useScanner } from '../lib/useScanner';
import { useShortcuts } from '../lib/useShortcuts';
import CustomerDialog from '../components/CustomerDialog';
import { CategoryChips, CategoryFilter } from '../components/CategoryFilter';
import { can, roleOf } from '../lib/perm';
import Modal, { NumPad } from '../components/Modal';
import LineEditor from '../components/LineEditor';
import PayDialog from '../components/PayDialog';
import Receipt from '../components/Receipt';
import OwnerPin from '../components/OwnerPin';
import CameraScanner from '../components/CameraScanner';
import ItemEditor from '../components/ItemEditor';

type Dialog = null | { k: 'help' } | { k: 'saved'; order: Order; lines: OrderLine[] } | { k: 'oos'; p: Product; avail: number } | { k: 'newItem'; code: string } | { k: 'line'; id: string; field?: 'qty' | 'price' | 'discount' } | { k: 'pay' } | { k: 'park' } | { k: 'cancel' } | { k: 'discount' } | { k: 'open' } | { k: 'camera' } | { k: 'customer' };

/**
 * The sale screen. Left: search / scan / categories / quick buttons / grid. Right: the cart.
 * Everything reads the in-memory index and writes IndexedDB; the network is never awaited here.
 */
export default function Sell({ boot, sb, locale, index, tick, staff, status, busyRef, onGo, onStock, reindex, newOrderRequest, presetCustomer }: { boot: Booted; sb: SupabaseClient; locale: L; index: CatalogIndex; tick: number; staff: Staff; status: SyncStatus | null; busyRef: MutableRefObject<boolean>; onGo: (v: 'shift' | 'orders') => void; onStock?: (productId: string) => void; reindex: () => void; newOrderRequest?: number; presetCustomer?: { phone: string; name: string } | null }) {
  const shop = boot.shop;
  const [draft, setDraft] = useState<Draft>(() => newDraft('walkin'));
  const [q, setQ] = useState(''); const [cats, setCats] = useState<Set<string>>(new Set());
  const [rate, setRate] = useState(89500);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [receipt, setReceipt] = useState<CommitResult | null>(null);
  const [lastSale, setLastSale] = useState<{ r: CommitResult; no: string | null } | null>(null);   // reopen the last receipt (print / QR / WhatsApp / return)
  const [reopened, setReopened] = useState(false);
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
  useEffect(() => { if (newOrderRequest && presetCustomer) { setReceipt(null); setDraft(d => ({ ...(d.lines.length ? d : { ...newDraft('whatsapp'), fulfillment: 'delivery' as const }), channel: 'whatsapp', customer_phone: presetCustomer.phone, customer_name: presetCustomer.name })); setDialog({ k: 'customer' }); return; } if (newOrderRequest) { setReceipt(null); setDraft(d => (d.lines.length ? { ...d, channel: 'whatsapp' } : { ...newDraft('whatsapp'), fulfillment: 'delivery' })); setDialog({ k: 'customer' }); } }, [newOrderRequest]);
  useEffect(() => { boot.db.rates.orderBy('effective_at').reverse().first().then((r: Rate | undefined) => { if (r) setRate(r.lbp_per_usd); }); listParked(boot.db).then(setParked); boot.db.staff.toArray().then(setMembers); currentShift(boot.db).then(setShift); }, [boot, tick]);
  // persist the cart (debounced) and flag "busy" so a SW update never lands mid-sale
  // A sold / saved cart must never be written back: the autosave below used to fire again when the pay dialog closed, so the
  // sold items came back as the "current cart" after leaving the receipt for another view or reloading.
  const committed = useRef<Set<string>>(new Set());
  useEffect(() => { busyRef.current = draft.lines.length > 0 || !!dialog; const t = setTimeout(() => { if (draft.lines.length && !committed.current.has(draft.id)) void saveDraft(boot.db, draft); }, 400); return () => clearTimeout(t); }, [draft, dialog, boot.db, busyRef]);
  // the sold order's server number arrives through the feed
  useEffect(() => { if (receipt) boot.db.orders.get(receipt.order.id).then(o => { if (o?.number) setServerNo(o.number); }); }, [tick, receipt, boot.db]);

  const totals = useMemo(() => draftTotals(draft, rate, lbpStep), [draft, rate, lbpStep]);
  const isOrder = draft.channel !== 'walkin';
  const feeCents = isOrder && draft.fulfillment === 'delivery' ? fee : 0;
  const grand = totals.total_cents + feeCents;
  const [pop, setPop] = useState<Map<string, number>>(new Map());
  const [pop30, setPop30] = useState<Map<string, number>>(new Map());
  useEffect(() => { void (async () => {
    const since = new Date(Date.now() - 30 * 86400e3).toISOString();
    const recent = new Set((await boot.db.orders.toArray()).filter(o => o.placed_at >= since && o.status !== 'cancelled' && o.status !== 'rejected').map(o => o.id));
    const m = new Map<string, number>(), m30 = new Map<string, number>();
    for (const l of await boot.db.orderLines.toArray()) { if (!l.product_id || l.voided) continue; const u = Math.max(0, num(l.quantity)); m.set(l.product_id, (m.get(l.product_id) ?? 0) + u); if (recent.has(l.order_id)) m30.set(l.product_id, (m30.get(l.product_id) ?? 0) + u); }
    setPop(m); setPop30(m30);
  })(); }, [boot, tick]);
  // open debt of the customer on the cart (shown next to 👤 so the cashier knows before "pay")
  const [debt, setDebt] = useState(0);
  useEffect(() => { if (!draft.customer_phone) { setDebt(0); return; } let on = true; debtLines(boot.db, { openOnly: true, phones: [draft.customer_phone] }).then(ls => { if (on) setDebt(ls.reduce((s, l) => s + l.outstanding_cents, 0)); }); return () => { on = false; }; }, [draft.customer_phone, boot.db, tick]);
  const [noteFor, setNoteFor] = useState<string | null>(null);        // cart line whose note input is open
  // The whole catalog (it is all on the device), most ordered first: units sold in the last 30 days, then all-time, then the shop's own order.
  // Typing searches everything; the category filter narrows the same list. Nothing is cut off — tiles are drawn in batches as you scroll.
  const all = useMemo(() => {
    const list = q.trim() ? index.search(q, 100000, cats) : index.byCategory(cats, 100000);
    return list.filter(p => p.is_active !== false).sort((a, b) => (pop30.get(b.id) ?? 0) - (pop30.get(a.id) ?? 0) || (pop.get(b.id) ?? 0) - (pop.get(a.id) ?? 0) || (a.sort_order ?? 0) - (b.sort_order ?? 0));
  }, [q, cats, index, tick, pop, pop30]);
  const BATCH = 120;
  const [shown, setShown] = useState(BATCH);
  const paneRef = useRef<HTMLDivElement>(null);
  const catKey = [...cats].join(',');
  useEffect(() => { setShown(BATCH); paneRef.current?.scrollTo({ top: 0 }); }, [q, catKey]);
  const growIfNear = useCallback(() => { const el = paneRef.current; if (el && el.scrollTop + el.clientHeight > el.scrollHeight - 1200) setShown(n => (n < all.length ? n + BATCH : n)); }, [all.length]);
  useEffect(() => { growIfNear(); }, [shown, all.length, growIfNear]);     // tall screens: keep filling until there is something to scroll
  const results = useMemo(() => all.slice(0, shown), [all, shown]);
  const catList = useMemo(() => [...index.categories.values()].sort((a, b) => a.sort_order - b.sort_order), [index, tick]);
  const quick = useMemo(() => index.quickButtons.map(b => ({ b, p: b.product_id ? index.byId.get(b.product_id) : undefined })), [index, tick]);
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 1800); };

  const add = useCallback((p: Product, quantity = 1, opts: { weigh?: boolean; ask?: boolean } = {}) => {
    if (p.track_stock) {
      const avail = num(p.on_hand) - num(p.reserved);
      const inCart = draft.lines.filter(l => l.product_id === p.id && !l.voided).reduce((s, l) => s + l.quantity, 0);
      if (avail - inCart - quantity < 0) {
        if (!shop.allow_negative_stock) { flash(pt('outOfStock', locale)); return; }
        if (opts.ask && loadPrintSettings().confirmOos) { setDialog({ k: 'oos', p, avail: avail - inCart }); return; }
        flash(`${pt('outOfStock', locale)} (${avail})`);
      }
      else if (avail - inCart - quantity <= num(p.min_stock)) flash(`${pt('lowStock', locale)}: ${avail - inCart - quantity} ${pt('available', locale)}`);
    }
    if (opts.weigh && p.decimal_qty) {                                  // kg/g item tapped on the grid → ask for the weight (or the amount) right away
      const line = lineFromProduct(p, quantity);
      setDraft(d => ({ ...d, lines: [...d.lines, line] })); setQ(''); setDialog({ k: 'line', id: line.id, field: 'qty' }); return;
    }
    setDraft(d => addToDraft(d, p, quantity)); setQ('');
  }, [draft.lines, shop.allow_negative_stock, locale]);

  const onScan = useCallback((code: string): string | void => {
    if (receipt) return;
    const hit = index.scanEx(code, scaleConfigs(shop));
    if (!hit) { if (can(roleOf(staff), 'newItemOnScan')) setDialog({ k: 'newItem', code }); else flash(`${pt('unknownBarcode', locale)}: ${code}`); return; }
    if (!hit.pack && !hit.scale) { add(hit.product); return text(hit.product.name, locale); }
    // pack barcode or scale label → its own line (quantity / price come from the barcode)
    const base = lineFromProduct(hit.product, hit.qty);
    const line: DraftLine = { ...base,
      ...(hit.unit_price_cents != null ? { unit_price_cents: hit.unit_price_cents, price_currency: 'usd' as const } : {}), ...(hit.unit_price_lbp != null && hit.unit_price_cents == null ? { unit_price_lbp: hit.unit_price_lbp, price_currency: 'lbp' as const } : {}),
      ...(hit.fixed_total_cents != null ? { unit_price_cents: hit.fixed_total_cents, price_currency: 'usd' as const, quantity: 1 } : {}), ...(hit.fixed_total_lbp != null ? { unit_price_lbp: hit.fixed_total_lbp, price_currency: 'lbp' as const, quantity: 1 } : {}),
      decimal_qty: base.decimal_qty || !!hit.scale, notes: hit.pack ? `${pt('pack', locale)} ${hit.pack.qty}` : hit.scale ? '⚖' : undefined };
    setDraft(d => ({ ...d, lines: [...d.lines, line] })); setQ('');
    return text(hit.product.name, locale);
  }, [index, add, locale, receipt, boot.role, shop]);
  useScanner(onScan);

  const updateLine = (l: DraftLine) => setDraft(d => ({ ...d, lines: d.lines.map(x => (x.id === l.id ? l : x)) }));
  const voidLine = (id: string, reason: string) => setDraft(d => ({ ...d, lines: d.lines.map(x => (x.id === id ? { ...x, voided: true, void_reason: reason } : x)) }));
  const live = draft.lines.filter(l => !l.voided);

  const startNew = useCallback(async () => { setReceipt(r => { if (r) setLastSale({ r, no: serverNo }); return null; }); setReopened(false); setServerNo(null); setDraft(newDraft('walkin')); setDialog(null); searchRef.current?.focus(); }, [serverNo]);
  const park = async (label: string, c?: { name: string; phone: string } | null) => { const d = c === undefined ? draft : { ...draft, customer_name: c?.name ?? '', customer_phone: c?.phone ?? '' }; await saveDraft(boot.db, d, true, label || d.customer_name || ''); setParked(await listParked(boot.db)); await startNew(); };
  const resume = async (id: string) => { const row = parked.find(p => p.id === id); if (!row) return; if (live.length) await saveDraft(boot.db, draft, true); await dropDraft(boot.db, id); setDraft(row.draft); setParked(await listParked(boot.db)); setDialog(null); };
  const cancel = async (reason: string) => { committed.current.add(draft.id); await cancelDraft(boot.db, draft, reason, staff.user_id); boot.engine.poke(); await startNew(); };

  const confirmPay = async (payments: Parameters<typeof commitSale>[1]['payments'], changeIn: Currency) => {
    committed.current.add(draft.id);
    const r = await commitSale(boot.db, { draft, payments, rate, lbpStep, changeIn, staff_user_id: staff.user_id, shift_id: shift?.id ?? null, delivery_fee_cents: feeCents, status: isOrder ? 'accepted' : undefined }).catch(e => { committed.current.delete(draft.id); throw e; });
    await dropDraft(boot.db, draft.id);
    setDraft(newDraft('walkin'));                  // the receipt shows the sold order; the cart behind it is empty from here on
    setDialog(null); setReceipt(r); boot.engine.poke();
    const ps = loadPrintSettings();
    if (ps.autoPrint) doPrint(receiptHtml(r.order, r.lines, r.payments, shop, locale, ps, { cashier: staff.display_name || staff.full_name || '' }));
  };

  const addCartToOrder = async (o: Order) => {
    const adds = live.filter(l => l.product_id && index.byId.get(l.product_id)).map(l => ({ product: index.byId.get(l.product_id!)!, new_qty: l.quantity }));
    if (!adds.length) { flash(pt('cartEmptyHint', locale)); return; }
    committed.current.add(draft.id);
    await editOrder(boot.db, o, adds, undefined, o.notify_customer !== false);
    await dropDraft(boot.db, draft.id); boot.engine.poke(); await startNew(); flash(`${pt('addedToOrder', locale)} ${o.number ?? o.local_number ?? ''}`);
  };
  const saveToOrders = async () => {
    if (!live.length || !isOrder) return;
    if (!draft.customer_phone) { setDialog({ k: 'customer' }); return; }
    committed.current.add(draft.id);
    const r = await commitSale(boot.db, { draft, payments: [], rate, lbpStep, changeIn: 'usd', staff_user_id: staff.user_id, shift_id: shift?.id ?? null, delivery_fee_cents: feeCents, status: 'accepted' }).catch(e => { committed.current.delete(draft.id); throw e; });
    await dropDraft(boot.db, draft.id); boot.engine.poke(); await startNew(); setDialog({ k: 'saved', order: r.order, lines: r.lines });
  };
  useShortcuts({
    F2: () => { setDialog(null); searchRef.current?.focus(); searchRef.current?.select(); },
    F4: () => { const l = live[live.length - 1]; if (l) setDialog({ k: 'line', id: l.id, field: 'qty' }); },
    F6: () => { if (live.length) setDialog({ k: 'discount' }); },
    F8: () => { if (live.length) setDialog({ k: 'pay' }); },
    F9: () => { if (live.length) setDialog({ k: 'park' }); },
    'ctrl+Delete': () => { if (live.length) setDialog({ k: 'cancel' }); },
    Escape: () => { if (dialog) setDialog(null); else if (live.length) setDialog({ k: 'cancel' }); },
    F1: () => setDialog(d => (d?.k === 'help' ? null : { k: 'help' })),
  }, !receipt);

  if (receipt) return <Receipt result={receipt} shop={shop} locale={locale} cashier={staff.display_name || staff.full_name || ''} serverNumber={serverNo} onNew={startNew} boot={boot} staff={staff} again={reopened} />;
  if (shift === null) return (
    <div className="pos-center" style={{ minHeight: '60dvh' }}><div className="card stack" style={{ textAlign: 'center', maxWidth: 420 }}>
      <h3 style={{ margin: 0 }}>{pt('shiftRequired', locale)}</h3>
      <button className="btn primary big" onClick={() => onGo('shift')}>{pt('openShift', locale)}</button>
    </div></div>
  );

  return (
    <div className="pos-sell">
      <div className="pos-pane" ref={paneRef} onScroll={growIfNear}>
        <div className="row" style={{ gap: 8 }}>
          <input ref={searchRef} className="input big" style={{ flex: 1 }} placeholder={pt('searchItems', locale)} value={q} onChange={e => setQ(e.target.value)} autoFocus={typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches}
            onKeyDown={e => { if (e.key === 'Enter' && q.trim()) { const p = index.scan(q.trim()) ?? (all.length === 1 ? all[0] : null); if (p) add(p); } }} />
          <button className="btn big" style={{ width: 'auto' }} title={pt('cameraScan', locale)} onClick={() => setDialog({ k: 'camera' })}>📷</button>
          <button className="btn big" style={{ width: 'auto' }} title={pt('openItem', locale)} onClick={() => setDialog({ k: 'open' })}>＋</button>
          {typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches && <button className="btn big" style={{ width: 'auto' }} title={pt('shortcuts', locale)} onClick={() => setDialog({ k: 'help' })}>?</button>}
          <CategoryFilter cats={catList} selected={cats} onChange={setCats} locale={locale} big />
        </div>
        <CategoryChips cats={catList} selected={cats} onChange={setCats} locale={locale} />
        <div className="muted num" style={{ fontSize: 12, flexShrink: 0 }}>{all.length.toLocaleString('en-US')} {pt('itemsCount', locale)}{q.trim() || cats.size ? ` / ${index.size.toLocaleString('en-US')}` : ''} · {pt('sortedByTop', locale)}</div>
        {!!quick.length && <div className="quick-row">{quick.map(({ b, p }) => p ? <button key={b.id} className="quick" style={{ background: b.color ?? undefined }} onClick={() => add(p, 1, { weigh: true })}>{b.label || text(p.name, locale)}</button> : null)}</div>}
        <div className="grid-items">
          {results.map(p => {
            const avail = num(p.on_hand) - num(p.reserved);
            const stock = !p.track_stock ? null : avail < 0 ? 'neg' : avail <= 0 ? 'out' : avail <= num(p.min_stock) ? 'low' : 'ok';
            return (
              <button key={p.id} className={`item-tile ${stock === 'out' || stock === 'neg' ? 'oos' : ''}`} onClick={() => add(p, 1, { weigh: true, ask: true })}>
                <div className="item-name">{text(p.name, locale)}</div>
                <div className="row spread" style={{ alignItems: 'center', marginTop: 'auto' }}>
                  <div className="item-price">{p.price_currency === 'lbp' ? fmtLbp(num(p.price_lbp), locale) : fmtUsd(Math.round(num(p.price_usd) * 100))}{p.decimal_qty && p.unit ? <span className="muted" style={{ fontWeight: 400 }}> /{p.unit}</span> : ''}</div>
                  {stock && (stock === 'neg' && onStock
                    ? <span role="button" tabIndex={-1} className="stock neg fix" title={pt('fixStock', locale)} onClick={e => { e.stopPropagation(); onStock(p.id); }}>⚠{avail} ✎</span>
                    : <span className={`stock ${stock}`} title={`${avail} ${pt('available', locale)}`}>{stock === 'neg' ? '⚠' : ''}{avail}</span>)}
                </div>
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
            {lastSale && !live.length && <button className="btn ghost" title={pt('lastSale', locale)} onClick={() => { setReopened(true); setServerNo(lastSale.no); setReceipt(lastSale.r); }}>🧾 {pt('lastSale', locale)}</button>}
            {!!parked.length && <button className="btn" onClick={() => setDialog({ k: 'park' })}>⏸ {parked.length}</button>}
            <button className={`btn ${isOrder ? 'primary' : draft.customer_phone ? '' : 'icon'}`} title={pt('customer', locale)} onClick={() => setDialog({ k: 'customer' })}>
              {isOrder ? `${pt(draft.channel as 'whatsapp', locale)} · ${draft.customer_name || draft.customer_phone || '👤'}` : draft.customer_phone ? `👤 ${draft.customer_name || draft.customer_phone}` : '👤'}
              {debt > 0 && <span className="pill bad" style={{ marginInlineStart: 6, padding: '1px 7px', fontSize: 12 }}>{pt('debtShort', locale)} {fmtUsd(debt)}</span>}
            </button>
          </span>
        </div>
        <div className="cart-lines">
          {!live.length && <p className="muted" style={{ padding: 20, textAlign: 'center' }}>{pt('emptyCart', locale)}</p>}
          {live.map(l => {
            const step = l.decimal_qty ? 0.1 : 1, min = l.decimal_qty ? 0.01 : 1;
            const lineUsd = Math.max(0, (l.price_currency === 'usd' ? Math.round(l.unit_price_cents * l.quantity) : Math.round((Math.round(l.unit_price_lbp * l.quantity) * 100) / rate)) - l.discount_cents);
            return (
            <div key={l.id} className={`cart-line ${l.notes ? 'noted' : ''}`} onClick={() => setDialog({ k: 'line', id: l.id })}>
              <div className="cart-line-top">
                <div className="cart-name">{text(l.name, locale)}</div>
                <strong className="num">{fmtUsd(lineUsd)}</strong>
              </div>
              <div className="cart-line-bottom" onClick={e => e.stopPropagation()}>
                <span className="muted num" style={{ fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.price_currency === 'usd' ? fmtUsd(l.unit_price_cents) : fmtLbp(l.unit_price_lbp, locale)}{l.unit ? ` /${l.unit}` : ''}{l.discount_cents ? ` − ${fmtUsd(l.discount_cents)}` : ''}</span>
                <div className="qty-btns">
                  <button onClick={() => updateLine({ ...l, quantity: Math.max(min, Math.round((l.quantity - step) * 1000) / 1000) })}>−</button>
                  <span onClick={() => setDialog({ k: 'line', id: l.id, field: 'qty' })}>{l.quantity}{l.unit ? <small className="muted"> {l.unit}</small> : ''}</span>
                  <button onClick={() => updateLine({ ...l, quantity: Math.round((l.quantity + step) * 1000) / 1000 })}>+</button>
                  <button className={l.notes ? 'noted' : ''} title={pt('note', locale)} onClick={() => setNoteFor(noteFor === l.id ? null : l.id)}>✎</button>
                  <button className="rm" title={pt('voidLine', locale)} onClick={() => updateLine({ ...l, voided: true })}>✕</button>
                </div>
              </div>
              {(noteFor === l.id || (l.notes && noteFor !== l.id)) && (noteFor === l.id
                ? <input className="input cart-note" autoFocus placeholder={pt('lineNoteHint', locale)} value={l.notes ?? ''} onClick={e => e.stopPropagation()} onChange={e => updateLine({ ...l, notes: e.target.value || null })} onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') { e.stopPropagation(); setNoteFor(null); } }} onBlur={() => setNoteFor(null)} />
                : <div className="cart-note-text" onClick={e => { e.stopPropagation(); setNoteFor(l.id); }}>📝 {l.notes}</div>)}
            </div>);
          })}
        </div>
        <div className="cart-totals">
          {(totals.discount_cents > 0 || feeCents > 0) && <div className="muted"><span>{pt('subtotal', locale)}</span><span>{fmtUsd(totals.subtotal_cents)}</span></div>}
          {totals.discount_cents > 0 && <div><span>{pt('discount', locale)}{draft.discount_reason ? ` · ${draft.discount_reason}` : ''}</span><span>−{fmtUsd(totals.discount_cents)}</span></div>}
          {feeCents > 0 && <div><span>{pt('deliveryFee', locale)}</span><span>{fmtUsd(feeCents)}</span></div>}
          <div className="big"><span>{pt('total', locale)}</span><span>{fmtUsd(grand)}</span></div>
          <div className="big lbp"><span></span><span>{fmtLbp(Math.round((grand * rate) / 100 / lbpStep) * lbpStep, locale)}</span></div>
          <div className="muted num" style={{ fontSize: 11 }}><span>{pt('rate', locale)}</span><span>$1 = {rate.toLocaleString('en-US')} ل.ل.</span></div>
        </div>
        <div className="cart-actions">
          <button className="btn" disabled={!live.length} onClick={() => setDialog({ k: 'discount' })}>{pt('discount', locale)} <kbd>F6</kbd></button>
          <button className="btn" disabled={!live.length && !parked.length} onClick={() => setDialog({ k: 'park' })}>{pt('park', locale)}{!!parked.length && <span className="badge">{parked.length}</span>} <kbd>F9</kbd></button>
          <button className="btn danger" disabled={!live.length} onClick={() => setDialog({ k: 'cancel' })}>✕</button>
          {isOrder && <button className="btn primary pay" disabled={!live.length} onClick={saveToOrders}>📥 {pt('saveToOrders', locale)} · {fmtUsd(grand)} <span style={{ fontSize: 12, opacity: .85, fontWeight: 400 }}>({pt('payAtHandover', locale)})</span></button>}
          <button className={`btn ${isOrder ? '' : 'primary'} pay`} disabled={!live.length} onClick={() => setDialog({ k: 'pay' })}>{pt('pay', locale)} {fmtUsd(grand)} <kbd>F8</kbd></button>
        </div>
      </aside>

      {toast && <div className="pos-toast">{toast}</div>}

      {dialog?.k === 'line' && (() => { const l = draft.lines.find(x => x.id === dialog.id); return l ? (
        <LineEditor line={l} locale={locale} rate={rate} maxDiscountPct={maxDisc} staff={members} me={staff} initialField={dialog.field}
          onChange={updateLine} onVoid={r => voidLine(l.id, r)} onClose={() => setDialog(null)} />) : null; })()}
      {dialog?.k === 'pay' && <PayDialog totalCents={grand} rate={rate} lbpStep={lbpStep} locale={locale} customer={{ name: draft.customer_name, phone: draft.customer_phone }} onCustomer={c => setDraft(d => ({ ...d, customer_name: c?.name ?? '', customer_phone: c?.phone ?? '' }))} boot={boot} isOwner={boot.role === 'owner'} onConfirm={confirmPay} onClose={() => setDialog(null)} />}
      {dialog?.k === 'newItem' && <ItemEditor boot={boot} locale={locale} index={index} product={null} presetBarcode={dialog.code} staff={members} me={staff} onDone={p => { setDialog(null); reindex(); add(p); }} onClose={() => setDialog(null)} />}
      {dialog?.k === 'oos' && <Modal open onClose={() => setDialog(null)} title={text(dialog.p.name, locale)}
        footer={<><button className="btn ghost" onClick={() => setDialog(null)}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} /><button className="btn primary" autoFocus onClick={() => { const p = dialog.p; setDialog(null); add(p, 1, { weigh: true }); }}>＋ {pt('addAnyway', locale)}</button></>}>
        <p style={{ margin: 0 }}>⚠ {pt('oosAsk', locale)} <span className="muted num">({dialog.avail} {pt('available', locale)})</span></p>
      </Modal>}
      {dialog?.k === 'saved' && <Modal open onClose={() => setDialog(null)} title={`✓ ${pt('orderSavedTitle', locale)} · ${dialog.order.number ?? dialog.order.local_number ?? ''}`}
        footer={<><button className="btn" onClick={() => { setDialog(null); onGo('orders'); }}>📥 {pt('goToOrders', locale)}</button><span style={{ flex: 1 }} /><button className="btn primary" autoFocus onClick={() => { setDraft({ ...newDraft('whatsapp'), fulfillment: 'delivery' }); setDialog({ k: 'customer' }); }}>＋ {pt('newOrderBtn', locale)}</button></>}>
        <div className="stack" style={{ gap: 8 }}>
          <div>👤 <strong>{dialog.order.customer_name || '—'}</strong> <span className="muted" dir="ltr">{dialog.order.customer_phone}</span> · {dialog.order.fulfillment === 'pickup' ? '🛍 ' + pt('pickupBadge', locale) : '🛵 ' + pt('deliveryBadge', locale)} · <strong className="num">{fmtUsd(num(dialog.order.total_cents))}</strong></div>
          <div className="order-items-line" style={{ maxWidth: 'none' }}>{dialog.lines.filter(l => !l.voided).map(l => `${num(l.quantity)}${l.unit ? ' ' + l.unit : '×'} ${text(l.name, locale)}`).join('، ')}</div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => doPrint(orderSheetHtml(dialog.order, dialog.lines, shop, locale, loadPrintSettings()))}>📋 {pt('printSheet', locale)}</button>
            <button className="btn" onClick={() => doPrint(receiptHtml(dialog.order, dialog.lines, [], shop, locale, loadPrintSettings(), { cashier: staff.display_name || staff.full_name || '' }))}>🖨 {pt('print', locale)}</button>
          </div>
        </div>
      </Modal>}
      {dialog?.k === 'help' && <Modal open onClose={() => setDialog(null)} title={`⌨ ${pt('shortcuts', locale)}`}>
        <table className="table"><tbody>
          {([['F1', 'shortcuts'], ['F2', 'searchItems'], ['F4', 'qty'], ['F6', 'discount'], ['F8', 'pay'], ['F9', 'park'], ['Esc', 'cancelSale'], ['Ctrl+Del', 'cancelSale'], ['Enter', 'enterAdds']] as const).map(([k, t]) => <tr key={k}><td><kbd className="kbd">{k}</kbd></td><td>{pt(t, locale)}</td></tr>)}
        </tbody></table>
      </Modal>}
      {dialog?.k === 'camera' && <CameraScanner open locale={locale} onScan={onScan} onClose={() => setDialog(null)} />}
      {dialog?.k === 'open' && <OpenItem locale={locale} rate={rate} onAdd={l => { setDraft(d => ({ ...d, lines: [...d.lines, l] })); setDialog(null); }} onClose={() => setDialog(null)} />}
      {dialog?.k === 'discount' && <OrderDiscount locale={locale} draft={draft} subtotal={totals.subtotal_cents} maxPct={maxDisc} staff={members} me={staff} onApply={(cents, reason, by) => { setDraft(d => ({ ...d, discount_cents: cents, discount_reason: reason, approved_by: by ?? d.approved_by })); setDialog(null); }} onClose={() => setDialog(null)} />}
      {dialog?.k === 'park' && <ParkDialog boot={boot} locale={locale} parked={parked} canPark={!!live.length} customer={draft.customer_phone ? { name: draft.customer_name ?? '', phone: draft.customer_phone } : null} onCustomer={c => setDraft(d => ({ ...d, customer_name: c?.name ?? '', customer_phone: c?.phone ?? '' }))} onPark={park} onResume={resume} onClose={() => setDialog(null)} />}
      {dialog?.k === 'cancel' && <ReasonDialog locale={locale} title={pt('cancelSale', locale)} onDone={cancel} onClose={() => setDialog(null)} />}
      {dialog?.k === 'customer' && <CustomerDialog boot={boot} sb={sb} locale={locale} draft={draft} fee={fee} online={status?.online ?? true} cartCount={live.length} onAddToOrder={addCartToOrder} onOpenOrders={() => { setDialog(null); onGo('orders'); }} onDone={r => {
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
  const [mode, setMode] = useState<'pct' | 'amt'>(draft.discount_cents ? 'amt' : 'pct'); const [v, setV] = useState(draft.discount_cents ? (draft.discount_cents / 100).toString() : ''); const [reason, setReason] = useState(draft.discount_reason ?? ''); const [gate, setGate] = useState(false);
  const cents = mode === 'pct' ? Math.round((subtotal * Math.min(100, Number(v) || 0)) / 100) : Math.min(subtotal, Math.round((Number(v) || 0) * 100));
  const pct = subtotal ? (cents / subtotal) * 100 : 0;
  const needsOwner = me.role !== 'owner' && pct > maxPct && !draft.approved_by;
  const apply = (by?: string | null) => onApply(cents, reason.trim(), by);
  return (
    <>
      <Modal open onClose={onClose} title={pt('orderDiscount', locale)} footer={<>{draft.discount_cents > 0 && <button className="btn ghost" onClick={() => onApply(0, '', null)}>✕ {pt('removeDiscount', locale)}</button>}<span style={{ flex: 1 }} /><button className="btn primary" disabled={!cents} onClick={() => (needsOwner ? setGate(true) : apply())}>{pt('ok', locale)}</button></>}>
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

function ParkDialog({ boot, locale, parked, canPark, customer, onCustomer, onPark, onResume, onClose }: { boot: Booted; locale: L; parked: Awaited<ReturnType<typeof listParked>>; canPark: boolean; customer: { name: string; phone: string } | null; onCustomer: (c: { name: string; phone: string } | null) => void; onPark: (label: string, c?: { name: string; phone: string } | null) => void; onResume: (id: string) => void; onClose: () => void }) {
  // held under the cart's customer when there is one; otherwise pick a customer (📇) or just type a name for the ticket
  const [cust, setCust] = useState(customer); const [label, setLabel] = useState('');
  const [pick, setPick] = useState(false); const [q, setQ] = useState(''); const [list, setList] = useState<ShopCustomer[]>([]);
  useEffect(() => { if (!pick) return; let on = true; searchCustomers(boot.db, q, 20).then(r => { if (on) setList(r); }); return () => { on = false; }; }, [pick, q, boot.db]);
  const choose = (c: { name: string; phone: string } | null) => { setCust(c); onCustomer(c); setPick(false); };
  const go = () => onPark(cust ? (cust.name || cust.phone) : label.trim(), cust);
  return (
    <Modal open onClose={onClose} title={pt('park', locale)}>
      {canPark && <div className="stack" style={{ gap: 8 }}>
        {cust
          ? <div className="pay-customer" style={{ marginBottom: 0 }}><span>👤 <strong>{cust.name || '—'}</strong> <span className="muted" dir="ltr">{cust.phone}</span></span><span style={{ flex: 1 }} /><button className="btn" onClick={() => { setQ(''); setPick(true); }}>📇 {pt('changeCustomer', locale)}</button><button className="btn icon" title={pt('removeCustomer', locale)} onClick={() => choose(null)}>✕</button></div>
          : <div className="row" style={{ gap: 8 }}><input className="input" placeholder={pt('parkLabel', locale)} value={label} onChange={e => setLabel(e.target.value)} autoFocus onKeyDown={e => { if (e.key === 'Enter') go(); }} /><button className="btn" onClick={() => { setQ(label); setPick(true); }}>📇 {pt('pickCustomer', locale)}</button></div>}
        <button className="btn primary" onClick={go}>⏸ {pt('park', locale)}</button>
      </div>}
      {!!parked.length && <h4>{pt('parked', locale)}</h4>}
      <ul className="tender-list">{parked.map(p => <li key={p.id}><span>{p.label || p.draft.customer_name || '—'} <span className="muted">· {p.draft.lines.filter(l => !l.voided).length} · {new Date(p.updated_at).toLocaleTimeString(locale === 'ar' ? 'ar-LB-u-nu-latn' : 'en-GB', { hour: '2-digit', minute: '2-digit' })}</span></span><button className="btn" onClick={() => onResume(p.id)}>{pt('resume', locale)}</button></li>)}</ul>
      {pick && <Modal open onClose={() => setPick(false)} title={`📇 ${pt('pickCustomer', locale)}`}>
        <input className="input" autoFocus placeholder={pt('searchCustomer', locale)} value={q} onChange={e => setQ(e.target.value)} />
        <ul className="tender-list" style={{ marginTop: 8 }}>{list.map(c => <li key={c.id}><span>👤 {c.name || '—'} <span className="muted" dir="ltr">{c.phone}</span></span><button className="btn" onClick={() => choose({ name: c.name || '', phone: c.phone })}>✓</button></li>)}</ul>
        {!list.length && <p className="muted">{pt('noResults', locale)}</p>}
      </Modal>}
    </Modal>
  );
}

function ReasonDialog({ locale, title, onDone, onClose }: { locale: L; title: string; onDone: (reason: string) => void; onClose: () => void }) {
  const [r, setR] = useState('');
  return <Modal open onClose={onClose} title={title} footer={<><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><button className="btn danger" onClick={() => onDone(r.trim())}>{title}</button></>}>
    <label className="label">{pt('cancelReason', locale)}</label><input className="input" value={r} onChange={e => setR(e.target.value)} autoFocus onKeyDown={e => { if (e.key === 'Enter') onDone(r.trim()); }} />
  </Modal>;
}
