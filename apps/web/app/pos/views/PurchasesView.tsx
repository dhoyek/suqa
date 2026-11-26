'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { compressImage } from '@/lib/upload';
import { adjustSupplierBalance, commitPurchase, currentShift, fmtLbp, fmtPhone, fmtUsd, num, paySupplier, purchaseLineAmounts, purchaseTotals, roundLbp, supplierStatement, text, upsertSupplier, mergeSuppliers, deleteSupplier, supplierHasHistory, usdToLbp, voidPurchase, type CatalogIndex, type Currency, type Product, type Purchase, type PurchaseDraftLine, type PurchaseLine, type Rate, type Staff, type Supplier, type SupplierPayment } from '@suqa/pos-core';
import { MergeDialog } from './CustomersView';
import { pt, type L, type Key } from '../i18n';
import type { Booted } from '../lib/boot';
import { fmtTime } from '../lib/boot';
import { useScanner } from '../lib/useScanner';
import Modal, { NumPad } from '../components/Modal';
import OwnerPin from '../components/OwnerPin';
import { doPrint, loadPrintSettings, supplierStatementHtml } from '../lib/print';
import { useConfirm } from '@/components/ConfirmProvider';

type Tab = 'invoices' | 'suppliers';

/** المشتريات — suppliers with balances, purchase invoices (stock in at cost), returns, payments, statements. */
export default function PurchasesView({ boot, locale, index, tick, staff, reindex, preset }: { boot: Booted; locale: L; index: CatalogIndex; tick: number; staff: Staff; reindex: () => void; /** from Stock → reorder list: open a purchase invoice for this supplier with these items */ preset?: { supplierId: string | null; items: { id: string; qty: number }[]; n: number } | null }) {
  const [tab, setTab] = useState<Tab>('invoices'); const [supQ, setSupQ] = useState('');
  const supMatch = (s: Supplier) => { const n = supQ.trim().toLowerCase(); const d = supQ.replace(/\D/g, ''); return !n || s.name.toLowerCase().includes(n) || (s.contact ?? '').toLowerCase().includes(n) || (!!d && (s.phone_key ?? '').includes(d)); };
  const [suppliers, setSuppliers] = useState<Supplier[]>([]); const [purchases, setPurchases] = useState<Purchase[]>([]); const [rate, setRate] = useState(89500);
  const [entry, setEntry] = useState<{ kind: 'purchase' | 'return' } | null>(null); const [selSup, setSelSup] = useState<Supplier | null>(null); const [editSup, setEditSup] = useState<Supplier | 'new' | null>(null); const [lastSup, setLastSup] = useState<string | null>(null);
  const [openPur, setOpenPur] = useState<Purchase | null>(null); const [lines, setLines] = useState<PurchaseLine[]>([]);
  const canEdit = staff.role !== 'cashier';
  const [initial, setInitial] = useState<{ product: Product; qty: number }[] | null>(null);
  useEffect(() => {
    if (!preset || !canEdit) return;
    setInitial(preset.items.map(i => ({ product: index.byId.get(i.id)!, qty: i.qty })).filter(r => r.product));
    setLastSup(preset.supplierId); setOpenPur(null); setSelSup(null); setEntry({ kind: 'purchase' });
  }, [preset?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    boot.db.suppliers.orderBy('name').toArray().then(setSuppliers);
    boot.db.purchases.orderBy('at').reverse().limit(200).toArray().then(setPurchases);
    boot.db.rates.orderBy('effective_at').reverse().first().then((r: Rate | undefined) => { if (r) setRate(r.lbp_per_usd); });
  }, [boot, tick]);
  useEffect(() => { if (openPur) boot.db.purchaseLines.where('purchase_id').equals(openPur.id).toArray().then(ls => setLines(ls.sort((a, b) => a.sort - b.sort))); }, [openPur, boot]);
  const supName = (id: string) => suppliers.find(s => s.id === id)?.name ?? '—';
  const owed = suppliers.reduce((s, x) => s + Math.max(0, num(x.balance_cents)), 0);
  return (
    <div className="stack" style={{ padding: 12 }}>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="seg"><button className={tab === 'invoices' ? 'active' : ''} onClick={() => setTab('invoices')}>{pt('purchasesNav', locale)}</button><button className={tab === 'suppliers' ? 'active' : ''} onClick={() => setTab('suppliers')}>{pt('suppliers', locale)} <span className="muted">{suppliers.length}</span></button></div>
        <span className="pill warn">{pt('suppliersBalance', locale)} {fmtUsd(owed)}</span>
        <span style={{ flex: 1 }} />
        {canEdit && <><button className="btn primary" onClick={() => setEntry({ kind: 'purchase' })}>＋ {pt('newPurchase', locale)}</button><button className="btn" onClick={() => setEntry({ kind: 'return' })}>↩ {pt('purchaseReturn', locale)}</button><button className="btn" onClick={() => setEditSup('new')}>＋ {pt('newSupplier', locale)}</button></>}
      </div>

      {tab === 'invoices' && <section className="card">
        {!purchases.length && <p className="muted">—</p>}
        <table className="table stack-sm"><tbody>
          {purchases.map(p => <tr key={p.id} className={p.status === 'void' ? 'muted' : ''} style={{ cursor: 'pointer' }} onClick={() => setOpenPur(p)}>
            <td><strong>{p.number.replace('~', '')}</strong>{p.invoice_no ? <span className="muted"> · {p.invoice_no}</span> : ''}</td><td className="muted">{fmtTime(p.at, locale)}</td><td>{supName(p.supplier_id)}</td>
            <td><span className={`pill ${p.kind === 'return' ? 'warn' : ''}`}>{pt(p.kind === 'return' ? 'purchaseReturn' : 'newPurchase', locale)}</span>{p.status === 'void' && <span className="pill bad" style={{ marginInlineStart: 4 }}>{pt('voided', locale)}</span>}</td>
            <td className="num">{p.currency === 'lbp' ? fmtLbp(num(p.total), locale) : fmtUsd(Math.round(num(p.total) * 100))}<div className="muted" style={{ fontSize: 11 }}>{fmtUsd(num(p.total_cents))}</div></td>
          </tr>)}
        </tbody></table>
      </section>}

      {tab === 'suppliers' && <section className="card">
        <input className="input" placeholder={pt('searchSupplier', locale)} value={supQ} onChange={e => setSupQ(e.target.value)} style={{ marginBottom: 8 }} />
        {!suppliers.length && <p className="muted">—</p>}
        <table className="table stack-sm"><tbody>
          {suppliers.filter(supMatch).map(s => <tr key={s.id} className={s.active ? '' : 'muted'} style={{ cursor: 'pointer' }} onClick={() => setSelSup(s)}>
            <td><strong>{s.name}</strong>{s.contact ? <span className="muted"> · {s.contact}</span> : ''}</td><td className="muted" dir="ltr">{s.phone ? fmtPhone(s.phone) : ''}</td>
            <td className="num"><strong className={num(s.balance_cents) > 0 ? 'bad' : num(s.balance_cents) < 0 ? 'ok' : ''}>{fmtUsd(num(s.balance_cents))}</strong></td>
          </tr>)}
        </tbody></table>
      </section>}

      {entry && <PurchaseEntry key={initial ? `r${preset?.n}` : 'e'} boot={boot} locale={locale} index={index} staff={staff} suppliers={suppliers} rate={rate} kind={entry.kind} preferId={lastSup} initial={initial} onNewSupplier={() => setEditSup('new')} onClose={() => { setEntry(null); setInitial(null); }} onDone={() => { setEntry(null); setInitial(null); reindex(); }} />}
      {editSup && <SupplierDialog boot={boot} locale={locale} supplier={editSup === 'new' ? null : editSup} onClose={() => setEditSup(null)} onDone={s => { setEditSup(null); setLastSup(s.id); setSuppliers(x => [...x.filter(y => y.id !== s.id), s].sort((a, b) => a.name.localeCompare(b.name))); }} />}
      {selSup && <SupplierCard boot={boot} locale={locale} supplier={suppliers.find(s => s.id === selSup.id) ?? selSup} staff={staff} rate={rate} canEdit={canEdit} onEdit={() => setEditSup(selSup)} onClose={() => setSelSup(null)} onChanged={() => boot.db.suppliers.orderBy('name').toArray().then(setSuppliers)} />}
      {openPur && <PurchaseDetail boot={boot} locale={locale} purchase={purchases.find(p => p.id === openPur.id) ?? openPur} lines={lines} supplier={supName(openPur.supplier_id)} staff={staff} canEdit={canEdit} onClose={() => setOpenPur(null)} onChanged={() => { boot.db.purchases.orderBy('at').reverse().limit(200).toArray().then(setPurchases); reindex(); }} />}
    </div>
  );
}

function SupplierDialog({ boot, locale, supplier, onClose, onDone }: { boot: Booted; locale: L; supplier: Supplier | null; onClose: () => void; onDone: (s: Supplier) => void }) {
  const [name, setName] = useState(supplier?.name ?? ''); const [phone, setPhone] = useState(supplier?.phone ?? ''); const [contact, setContact] = useState(supplier?.contact ?? ''); const [notes, setNotes] = useState(supplier?.notes ?? ''); const [active, setActive] = useState(supplier?.active ?? true);
  const save = async () => { const s = await upsertSupplier(boot.db, boot.shop.id, { id: supplier?.id, name, phone, contact, notes, active }); boot.engine.poke(); onDone(s); };
  return <Modal open onClose={onClose} title={supplier ? supplier.name : pt('newSupplier', locale)} footer={<><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} /><button className="btn primary" disabled={!name.trim()} onClick={save}>{pt('save', locale)}</button></>}>
    <label className="label">{pt('supplier', locale)} *</label><input className="input" value={name} onChange={e => setName(e.target.value)} autoFocus />
    <label className="label">{pt('customerPhone', locale)}</label><input className="input" dir="ltr" inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} />
    <label className="label">{pt('contactPerson', locale)}</label><input className="input" value={contact} onChange={e => setContact(e.target.value)} />
    <label className="label">{pt('customerNotes', locale)}</label><input className="input" value={notes} onChange={e => setNotes(e.target.value)} />
    {supplier && <label className="row" style={{ gap: 8, alignItems: 'center', marginTop: 8 }}><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} /> {pt('active', locale)}</label>}
  </Modal>;
}

function PurchaseEntry({ boot, locale, index, staff, suppliers, rate, kind, preferId, initial, onNewSupplier, onClose, onDone }: { initial?: { product: Product; qty: number }[] | null; boot: Booted; locale: L; index: CatalogIndex; staff: Staff; suppliers: Supplier[]; rate: number; kind: 'purchase' | 'return'; preferId: string | null; onNewSupplier: () => void; onClose: () => void; onDone: () => void }) {
  const [supplier, setSupplier] = useState<Supplier | null>(suppliers.length === 1 ? suppliers[0] : null);
  useEffect(() => { if (preferId) { const s = suppliers.find(x => x.id === preferId); if (s) setSupplier(s); } }, [preferId, suppliers]); // a supplier just created from ＋ becomes the selected one
  const [currency, setCurrency] = useState<Currency>('usd'); const [invNo, setInvNo] = useState(''); const [invDate, setInvDate] = useState(new Date().toISOString().slice(0, 10)); const [discount, setDiscount] = useState(''); const [discPct, setDiscPct] = useState(false); const [note, setNote] = useState(''); const [nextNo, setNextNo] = useState('');
  const [rows, setRows] = useState<PurchaseDraftLine[]>(() => (initial ?? []).map(r => ({ product: r.product, qty: r.qty, unit_cost: num(r.product.cost_cents) / 100 || 0 }))); const [q, setQ] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [members, setMembers] = useState<Staff[]>([]); const [gate, setGate] = useState(false);
  useEffect(() => { boot.db.staff.toArray().then(setMembers); }, [boot]);
  // 📷✨ a photo of the supplier's invoice → rows. The model reads the paper; the till matches each line to the shop's own items
  // HERE (barcode first, then the same search as the box above). A line it cannot match waits in "not matched" for the person
  // to pick its item. Nothing is posted until "Receive & post"; every filled row shows the name as printed, to check.
  type PhotoLine = { name: string; barcode: string; qty: number; unit_cost: number; discount: number | null; discount_pct: number | null; total: number | null };
  const fileRef = useRef<HTMLInputElement>(null);
  const [photo, setPhoto] = useState<{ busy: boolean; msg: string | null; supplier: string; total: number | null; left: PhotoLine[]; pending: PhotoLine | null }>({ busy: false, msg: null, supplier: '', total: null, left: [], pending: null });
  const rowOf = (p: Product, l: PhotoLine): PurchaseDraftLine => ({ product: p, qty: l.qty, unit_cost: l.unit_cost, discount: l.discount_pct != null ? null : l.discount, discount_pct: l.discount_pct, photo_name: l.name });
  const readPhoto = async (file: File | undefined) => {
    if (!file || photo.busy) return;
    setPhoto(v => ({ ...v, busy: true, msg: null }));
    try {
      const blob = await compressImage(file, 2000, 0.85);
      const form = new FormData(); form.set('shop_id', boot.shop.id); form.set('image', new File([blob], 'invoice.jpg', { type: 'image/jpeg' }));
      const res = await fetch('/api/pos/purchase-photo', { method: 'POST', body: form });
      const j = await res.json().catch(() => ({})) as { status?: string; reason?: string; error?: string; invoice?: { supplier: string; invoice_no: string; date: string; currency: Currency | null; discount: number | null; total: number | null; lines: PhotoLine[] } };
      if (j.status !== 'ok' || !j.invoice) {
        const why = j.reason === 'nothing' ? 'photoInvNothing' : j.reason === 'too_big' ? 'photoInvTooBig' : j.reason === 'rate' ? 'photoInvRate' : j.reason === 'cap' ? 'photoInvCap' : j.reason === 'off' || j.error === 'forbidden' ? 'photoInvOff' : 'photoInvFailed';
        setPhoto(v => ({ ...v, busy: false, msg: pt(why as Key, locale) })); return;
      }
      const inv = j.invoice; const taken = new Set(rows.map(r => r.product.id)); const fresh: PurchaseDraftLine[] = []; const left: PhotoLine[] = [];
      for (const l of inv.lines) {
        const p = (l.barcode ? index.scan(l.barcode) : null) ?? index.search(l.name, 1)[0] ?? null;
        if (p && p.is_active !== false && !taken.has(p.id)) { taken.add(p.id); fresh.push(rowOf(p, l)); } else left.push(l);
      }
      if (inv.currency) setCurrency(inv.currency);
      setRows(rs => [...rs, ...fresh]);
      if (inv.invoice_no && !invNo.trim()) setInvNo(inv.invoice_no);
      if (inv.date) setInvDate(inv.date);
      if (inv.discount && !discount) { setDiscPct(false); setDiscount(String(inv.discount)); }
      if (!supplier && inv.supplier) { const n = inv.supplier.toLowerCase(); const hit = suppliers.filter(x => x.active).find(x => { const m = x.name.toLowerCase().trim(); return m.length >= 3 && (n.includes(m) || m.includes(n)); }); if (hit) setSupplier(hit); }
      setPhoto({ busy: false, msg: null, supplier: inv.supplier, total: inv.total, left, pending: null });
    } catch { setPhoto(v => ({ ...v, busy: false, msg: pt('photoInvFailed', locale) })); }
  };
  // the reference this invoice will get when it is posted (the server confirms it)
  useEffect(() => { boot.db.purchases.filter(p => p.kind === kind).count().then(n => setNextNo(`${kind === 'return' ? 'PR' : 'P'}-${String(n + 1).padStart(5, '0')}`)); }, [boot, kind]);
  const results = q.trim() ? index.search(q, 12) : [];
  const add = (p: Product) => {
    // an invoice line waiting for its item: the picked item takes that line's quantity, price and discount
    if (photo.pending && !rows.some(r => r.product.id === p.id)) { const l = photo.pending; setRows(rs => [...rs, rowOf(p, l)]); setPhoto(v => ({ ...v, pending: null, left: v.left.filter(x => x !== l) })); setQ(''); return; }
    setRows(rs => { const i = rs.findIndex(r => r.product.id === p.id); if (i >= 0) { const c = rs.slice(); c[i] = { ...c[i], qty: c[i].qty + 1 }; return c; }
      const cost = currency === 'lbp' ? Math.round((num(p.cost_cents) / 100) * rate) : num(p.cost_cents) / 100; return [...rs, { product: p, qty: 1, unit_cost: cost || 0 }]; });
    setQ('');
  };
  useScanner(code => { const p = index.scan(code); if (p) add(p); });
  const upd = (i: number, patch: Partial<PurchaseDraftLine>) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const t = useMemo(() => purchaseTotals(rows, currency, rate, discPct ? 0 : Number(discount) || 0, discPct ? Number(discount) || 0 : null), [rows, currency, rate, discount, discPct]);
  const submit = async (approvedBy: string | null) => {
    if (!supplier || !rows.length || busy) return; setBusy(true); setErr(null);
    try { await commitPurchase(boot.db, { supplier, kind, lines: rows.filter(r => r.qty > 0), currency, rate, discount: discPct ? 0 : Number(discount) || 0, discount_pct: discPct && Number(discount) ? Number(discount) : null, invoice_no: invNo.trim() || null, invoice_date: invDate, note: note.trim() || null, user_id: staff.user_id, approved_by: approvedBy }); boot.engine.poke(); onDone(); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  const marginPct = Number(boot.shop.default_margin_pct) || 0;
  const applyMargin = () => setRows(rs => rs.map(r => { const am = purchaseLineAmounts(r); const nu = r.qty ? am.net / r.qty : r.unit_cost; const costUsd = currency === 'lbp' ? nu / rate : nu; const m = r.product.margin_pct != null && r.product.margin_pct !== '' ? Number(r.product.margin_pct) : marginPct; return costUsd > 0 ? { ...r, new_price_usd: Math.ceil((costUsd / (1 - m / 100)) * 4) / 4 } : r; }));
  const supplierItems = useMemo(() => supplier ? index.byCategory(null, 100000).filter(p => p.supplier_id === supplier.id && !rows.some(r => r.product.id === p.id)).slice(0, 40) : [], [supplier, rows, index]);
  const sym = currency === 'lbp' ? 'ل.ل.' : '$';
  const fmtC = (v: number) => (currency === 'lbp' ? fmtLbp(Math.round(v), locale) : fmtUsd(Math.round(v * 100)));
  return (
    <>
      <Modal open onClose={onClose} title={`${pt(kind === 'return' ? 'purchaseReturn' : 'newPurchase', locale)}${nextNo ? ` · ${nextNo}` : ''}`} wide
        footer={<><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} />
          <div className="pur-totals">
            <div><span>{pt('subtotal', locale)}</span><span>{fmtC(t.gross)}</span></div>
            {t.all_discount > 0 && <div className="disc"><span>{pt('discount', locale)}</span><span>− {fmtC(t.all_discount)}</span></div>}
            <div className="tot"><span>{pt('total', locale)}</span><span>{fmtC(t.total)}{currency === 'lbp' && <small className="muted"> {fmtUsd(t.total_cents)}</small>}</span></div>
          </div>
          <button className="btn primary big" style={{ width: 'auto', minWidth: 200 }} disabled={!supplier || !rows.length || busy} onClick={() => (staff.role === 'cashier' ? setGate(true) : submit(null))}>{pt('receiveStock', locale)}</button></>}>
        {kind === 'purchase' && (staff.role === 'owner' || staff.role === 'stock') && <div className="pur-photo">
          <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; void readPhoto(f); }} />
          <button type="button" className="btn" disabled={photo.busy} onClick={() => fileRef.current?.click()}>{photo.busy ? `⏳ ${pt('photoInvReading', locale)}` : `📷✨ ${pt('photoInv', locale)}`}</button>
          <small className="muted">{pt('photoInvHint', locale)}</small>
          {photo.msg && <div className="pill bad" style={{ display: 'block', padding: '6px 10px', whiteSpace: 'normal' }}>{photo.msg}</div>}
          {photo.supplier && !supplier && <div className="pill warn" style={{ display: 'block', padding: '6px 10px', whiteSpace: 'normal' }}>{pt('photoInvSupplier', locale)}: <strong>{photo.supplier}</strong> — {pt('photoInvPickSupplier', locale)}</div>}
        </div>}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: 2, minWidth: 200 }}><label className="label">{pt('supplier', locale)} *</label>
            <div className="row" style={{ gap: 6 }}><select className="input" value={supplier?.id ?? ''} onChange={e => setSupplier(suppliers.find(s => s.id === e.target.value) ?? null)} style={{ flex: 1 }}><option value="">{pt('pickSupplier', locale)}</option>{suppliers.filter(s => s.active).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select><button className="btn" onClick={onNewSupplier}>＋</button></div></div>
          <div style={{ minWidth: 120 }}><label className="label">{pt('invoiceNo', locale)}</label><input className="input" value={invNo} onChange={e => setInvNo(e.target.value)} /></div>
          <div><label className="label">{pt('invoiceDate', locale)}</label><input className="input" type="date" dir="ltr" value={invDate} onChange={e => setInvDate(e.target.value)} /></div>
          <div><label className="label">{pt('currency', locale)}</label><div className="seg"><button className={currency === 'usd' ? 'active' : ''} onClick={() => setCurrency('usd')}>$</button><button className={currency === 'lbp' ? 'active' : ''} onClick={() => setCurrency('lbp')}>ل.ل.</button></div></div>
        </div>
        <div style={{ position: 'relative', marginTop: 10 }}>
          <input className="input" placeholder={pt('scanOrSearchItem', locale)} value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && q.trim()) { const p = index.scan(q.trim()) ?? results[0]; if (p) add(p); } }} autoFocus />
          {results.length > 0 && <div className="cust-list">{results.map(p => <button key={p.id} type="button" onMouseDown={e => e.preventDefault()} onClick={() => add(p)}><strong>{text(p.name, locale)}</strong><small className="muted">{pt('lastCost', locale)} {fmtUsd(num(p.cost_cents))} · {pt('currentPrice', locale)} {fmtUsd(Math.round(num(p.price_usd) * 100))} · {pt('onHand', locale)} {num(p.on_hand)}</small></button>)}</div>}
        </div>
        {supplierItems.length > 0 && <div className="chips" style={{ marginTop: 8 }}><span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>{pt('supplierItems', locale)}:</span>{supplierItems.map(p => <button key={p.id} className="chip" onClick={() => add(p)}>＋ {text(p.name, locale)}</button>)}</div>}
        <div className="pur-scroll"><table className="table pur-lines" style={{ marginTop: 10 }}><tbody>
          <tr><th style={{ textAlign: 'start' }}>{pt('items', locale)}</th><th>{pt('qty', locale)}</th><th>{pt('unitCost', locale)} ({sym})</th><th>{pt('discount', locale)}</th><th>{pt('total', locale)}</th>{kind === 'purchase' && <th>{pt('expiry', locale)}</th>}{kind === 'purchase' && <th>{pt('newSellPrice', locale)} ($)</th>}<th></th></tr>
          {rows.map((r, i) => {
            const am = purchaseLineAmounts(r); const netUnit = r.qty ? am.net / r.qty : r.unit_cost; const costUsd = currency === 'lbp' ? netUnit / rate : netUnit;
              // price check: this cost is above the item's last cost → the price that keeps the margin the item had (rounded up to 5 cents); a tap fills it
              const lastCost = num(r.product.cost_cents) / 100; const oldPrice = num(r.product.price_usd); const rose = kind === 'purchase' && lastCost > 0 && costUsd > lastCost * 1.01;
              const keep = rose && r.product.price_currency !== 'lbp' && oldPrice > lastCost ? Math.ceil((costUsd / (lastCost / oldPrice)) * 20 - 1e-9) / 20 : null;
              const price = r.new_price_usd ?? num(r.product.price_usd); const margin = costUsd > 0 && price > 0 ? Math.round(((price - costUsd) / price) * 100) : null;
            return <tr key={r.product.id}>
              <td>{text(r.product.name, locale)}<div className="muted" style={{ fontSize: 11 }}>{pt('onHand', locale)} {num(r.product.on_hand)} · {pt('lastCost', locale)} {fmtUsd(num(r.product.cost_cents))}</div>
                {r.photo_name && <div className="muted pur-printed" title={pt('photoInvPrinted', locale)}>📷 {r.photo_name}</div>}
                <input className="input pur-note" placeholder={pt('note', locale)} value={r.note ?? ''} onChange={e => upd(i, { note: e.target.value })} /></td>
              <td><input className="input" dir="ltr" inputMode="decimal" value={r.qty} onChange={e => upd(i, { qty: Number(e.target.value) || 0 })} style={{ width: 68 }} /></td>
              <td><input className="input" dir="ltr" inputMode="decimal" value={r.unit_cost} onChange={e => upd(i, { unit_cost: Number(e.target.value) || 0 })} style={{ width: 86 }} /></td>
              <td><div className="pur-disc"><input className="input" dir="ltr" inputMode="decimal" value={r.discount_pct != null ? r.discount_pct : (r.discount ?? '')} onChange={e => { const v = e.target.value === '' ? null : Number(e.target.value) || 0; upd(i, r.discount_pct != null ? { discount_pct: v ?? 0 } : { discount: v }); }} />
                <button type="button" className="btn" title={pt('discount', locale)} onClick={() => upd(i, r.discount_pct != null ? { discount_pct: null, discount: null } : { discount_pct: 0, discount: null })}>{r.discount_pct != null ? '%' : sym}</button></div></td>
              <td className="num">{fmtC(am.net)}{am.discount > 0 && <div className="muted" style={{ fontSize: 11, textDecoration: 'line-through' }}>{fmtC(am.gross)}</div>}</td>
              {kind === 'purchase' && <td><input className="input" type="date" dir="ltr" value={r.expiry ?? ''} onChange={e => upd(i, { expiry: e.target.value || null })} style={{ width: 128 }} title={pt('expiry', locale)} /></td>}
              {kind === 'purchase' && <td><input className="input" dir="ltr" inputMode="decimal" placeholder={String(num(r.product.price_usd))} value={r.new_price_usd ?? ''} onChange={e => upd(i, { new_price_usd: e.target.value === '' ? null : Number(e.target.value) })} style={{ width: 80 }} />{margin != null && <div className={`muted ${margin < 0 ? 'bad' : ''}`} style={{ fontSize: 11 }}>{pt('margin', locale)} {margin}%</div>}
                {rose && <div className="pur-rose" title={pt('costRoseHint', locale)}>↑ {pt('costRose', locale)} {fmtUsd(Math.round(lastCost * 100))} → {fmtUsd(Math.round(costUsd * 100))}</div>}
                {keep != null && keep > oldPrice && r.new_price_usd !== keep && <button type="button" className="chip pur-keep" onClick={() => upd(i, { new_price_usd: keep })}>{pt('keepMargin', locale)} {fmtUsd(Math.round(keep * 100))}</button>}</td>}
              <td><button className="btn icon" onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}>✕</button></td>
            </tr>;
          })}
          {!rows.length && <tr><td colSpan={8} className="muted">{pt('noLines', locale)}</td></tr>}
        </tbody></table></div>
        {photo.left.length > 0 && <div className="pur-left">
          <strong>{pt('photoInvLeft', locale)} ({photo.left.length})</strong> <small className="muted">{pt('photoInvLeftHint', locale)}</small>
          {photo.left.map((l, i) => <div key={i} className={`pur-left-row ${photo.pending === l ? 'active' : ''}`}>
            <span style={{ flex: 1, minWidth: 0 }}>{l.name}<small className="muted"> · {l.qty} × {fmtC(l.unit_cost)}{l.discount_pct != null ? ` · −${l.discount_pct}%` : l.discount ? ` · −${fmtC(l.discount)}` : ''}</small></span>
            <button type="button" className="btn" onClick={() => { setPhoto(v => ({ ...v, pending: l })); setQ(l.name.split(' ').slice(0, 3).join(' ')); }}>{pt('photoInvPick', locale)}</button>
            <button type="button" className="btn ghost" title="✕" onClick={() => setPhoto(v => ({ ...v, left: v.left.filter(x => x !== l), pending: v.pending === l ? null : v.pending }))}>✕</button>
          </div>)}
        </div>}
        {photo.total != null && rows.length > 0 && (() => { const same = Math.abs(photo.total - t.total) <= Math.max(0.01, photo.total * 0.002); return (
          <div className={`pill ${same && !photo.left.length ? 'ok' : 'warn'} pur-check`} style={{ display: 'block', padding: '6px 10px', whiteSpace: 'normal', marginTop: 8 }}>
            {same && !photo.left.length ? '✓' : '⚠'} {pt('photoInvTotal', locale)}: <strong>{fmtC(photo.total)}</strong> · {pt('photoInvRows', locale)}: <strong>{fmtC(t.total)}</strong></div>); })()}
        <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div><label className="label">{pt('invoiceDiscount', locale)}</label><div className="pur-disc" style={{ width: 150 }}><input className="input" dir="ltr" inputMode="decimal" value={discount} onChange={e => setDiscount(e.target.value)} /><button type="button" className="btn" onClick={() => setDiscPct(v => !v)}>{discPct ? '%' : sym}</button></div></div>
          <div style={{ flex: 1, minWidth: 160 }}><label className="label">{pt('invoiceNote', locale)}</label><input className="input" value={note} onChange={e => setNote(e.target.value)} /></div>
          {kind === 'purchase' && marginPct > 0 && <button className="btn ghost" onClick={applyMargin}>{pt('applyMargin', locale)} ({marginPct}%)</button>}
        </div>
        {err && <p className="bad">{err}</p>}
      </Modal>
      {gate && <OwnerPin open locale={locale} staff={members} me={staff} reason={pt('newPurchase', locale)} onDone={id => { setGate(false); if (id) void submit(id); }} />}
    </>
  );
}

function PurchaseDetail({ boot, locale, purchase, lines, supplier, staff, canEdit, onClose, onChanged }: { boot: Booted; locale: L; purchase: Purchase; lines: PurchaseLine[]; supplier: string; staff: Staff; canEdit: boolean; onClose: () => void; onChanged: () => void }) {
  const confirm = useConfirm();
  const doVoid = async () => { if (!(await confirm(pt('voidPurchase', locale) + ` ${purchase.number.replace('~', '')}?`, { danger: true }))) return; await voidPurchase(boot.db, purchase, 'void', staff.user_id, staff.role === 'owner' ? staff.user_id : null); boot.engine.poke(); onChanged(); onClose(); };
  const fmtC = (v: number) => (purchase.currency === 'lbp' ? fmtLbp(Math.round(v), locale) : fmtUsd(Math.round(v * 100)));
  return <Modal open onClose={onClose} title={`${purchase.number.replace('~', '')} · ${supplier}`} wide footer={<>{canEdit && purchase.status === 'posted' && <button className="btn danger" onClick={doVoid}>{pt('voidPurchase', locale)}</button>}<span style={{ flex: 1 }} /><button className="btn primary" onClick={onClose}>{pt('ok', locale)}</button></>}>
    <div className="pur-ref"><span>{pt('refNo', locale)} <strong dir="ltr">{purchase.number.replace('~', '')}</strong></span>{purchase.invoice_no && <span>{pt('invoiceNo', locale)} <strong dir="ltr">{purchase.invoice_no}</strong></span>}<span>{pt('invoiceDate', locale)} <strong dir="ltr">{purchase.invoice_date}</strong></span></div>
    <div className="muted" style={{ fontSize: 13 }}>{fmtTime(purchase.at, locale)} · {pt(purchase.status === 'void' ? 'voided' : 'posted', locale)}{purchase.note ? ` · ${purchase.note}` : ''}</div>
    <table className="table" style={{ marginTop: 8 }}><tbody>
      {lines.map(l => { const gross = num(l.qty) * num(l.unit_cost); const d = num(l.discount ?? 0); return <tr key={l.id}><td>{text(l.name, locale)}{l.note ? <div className="muted" style={{ fontSize: 12 }}>📝 {l.note}</div> : null}</td><td style={{ textAlign: 'center' }}>{num(l.qty)}</td><td className="num">{fmtC(num(l.unit_cost))}</td>
        <td className="num">{d > 0 ? <span className="muted">− {fmtC(d)}{l.discount_pct != null ? ` (${num(l.discount_pct)}%)` : ''}</span> : ''}</td>
        <td className="num">{fmtC(gross - d)}</td><td className="muted">{l.new_price_usd != null ? `→ ${fmtUsd(Math.round(num(l.new_price_usd) * 100))}` : ''}</td></tr>; })}
    </tbody></table>
    {(() => { const gross = lines.reduce((a, l) => a + num(l.qty) * num(l.unit_cost), 0); const allDisc = Math.max(0, gross - num(purchase.total)); return (
      <div className="pur-totals" style={{ marginInlineStart: 'auto', marginTop: 10 }}>
        <div><span>{pt('subtotal', locale)}</span><span>{fmtC(gross)}</span></div>
        {allDisc > 0.004 && <div className="disc"><span>{pt('discount', locale)}{purchase.discount_pct != null ? ` (${num(purchase.discount_pct)}%)` : ''}</span><span>− {fmtC(allDisc)}</span></div>}
        <div className="tot"><span>{pt('total', locale)}</span><span>{fmtC(num(purchase.total))}{purchase.currency === 'lbp' && <small className="muted"> {fmtUsd(num(purchase.total_cents))}</small>}</span></div>
      </div>); })()}
  </Modal>;
}

function SupplierCard({ boot, locale, supplier, staff, rate, canEdit, onEdit, onClose, onChanged }: { boot: Booted; locale: L; supplier: Supplier; staff: Staff; rate: number; canEdit: boolean; onEdit: () => void; onClose: () => void; onChanged: () => void }) {
  const [st, setSt] = useState<Awaited<ReturnType<typeof supplierStatement>>>([]); const [pay, setPay] = useState(false); const [fix, setFix] = useState(false);
  useEffect(() => { supplierStatement(boot.db, supplier).then(setSt); }, [boot, supplier]);
  const [merge, setMerge] = useState(false); const [hasHistory, setHasHistory] = useState(true); const [all, setAll] = useState<Supplier[]>([]); const confirmD = useConfirm();
  useEffect(() => { supplierHasHistory(boot.db, supplier).then(setHasHistory); boot.db.suppliers.toArray().then(setAll); }, [boot, supplier]);
  const owner = staff.role === 'owner';
  const step = boot.shop.lbp_rounding_step ?? 5000;
  return <>
    <Modal open onClose={onClose} title={supplier.name} wide footer={<><button className="btn" onClick={() => doPrint(supplierStatementHtml(supplier, st, boot.shop, locale, loadPrintSettings()))}>🖨 {pt('statementTitle', locale)}</button>{canEdit && <button className="btn ghost" onClick={onEdit}>✎</button>}{owner && <button className="btn" onClick={() => setMerge(true)}>⇄ {pt('mergeSupplier', locale)}</button>}{owner && <button className="btn" onClick={() => setFix(true)}>⚖ {pt('balanceFix', locale)}</button>}{owner && <button className="btn danger" disabled={hasHistory} title={hasHistory ? pt('hasHistoryHintS', locale) : ''} onClick={async () => { if (!(await confirmD(`${pt('deleteSupplier', locale)}: ${supplier.name}?`, { danger: true }))) return; await deleteSupplier(boot.db, supplier); boot.engine.poke(); onChanged(); onClose(); }}>🗑</button>}<span style={{ flex: 1 }} />{canEdit && <button className="btn primary" onClick={() => setPay(true)}>💵 {pt('paySupplier', locale)}</button>}</>}>
      <div className="kpis">
        <div className="kpi"><span>{pt('weOwe', locale)}</span><strong className={num(supplier.balance_cents) > 0 ? 'bad' : ''}>{fmtUsd(num(supplier.balance_cents))}</strong><small>{fmtLbp(roundLbp(usdToLbp(num(supplier.balance_cents), rate), step), locale)}</small></div>
        <div className="kpi"><span>{pt('customerPhone', locale)}</span><strong dir="ltr" style={{ fontSize: 15 }}>{supplier.phone ? fmtPhone(supplier.phone) : '—'}</strong><small>{supplier.contact ?? ''}</small></div>
      </div>
      <table className="table" style={{ marginTop: 10 }}><tbody>
        {st.map((x, i) => <tr key={i} className={x.kind === 'void' ? 'muted' : ''}><td className="muted">{fmtTime(x.at, locale)}</td><td>{x.kind === 'payment' ? `${pt('paySupplier', locale)} · ${pt(x.ref as Key, locale)}` : x.kind === 'adjust' ? <>⚖ {pt('balanceFix', locale)}{x.ref ? <span className="muted"> · {x.ref}</span> : null}</> : x.ref.replace('~', '')}{x.kind === 'void' ? ` · ${pt('voided', locale)}` : ''}</td><td className={`num ${x.amount_cents < 0 ? 'ok' : ''}`}>{fmtUsd(x.amount_cents)}</td><td className="num muted">{fmtUsd(x.balance_cents)}</td></tr>)}
        {!st.length && <tr><td className="muted">—</td></tr>}
      </tbody></table>
    </Modal>
    {fix && <BalanceFix boot={boot} locale={locale} supplier={supplier} rate={rate} staff={staff} onClose={() => setFix(false)} onDone={() => { setFix(false); onChanged(); }} />}
    {pay && <PayDialogS boot={boot} locale={locale} supplier={supplier} rate={rate} staff={staff} onClose={() => setPay(false)} onDone={() => { setPay(false); onChanged(); supplierStatement(boot.db, supplier).then(setSt); }} />}
    {merge && <MergeDialog locale={locale} keep={supplier} candidates={all.filter(x => x.id !== supplier.id)} label={x => `${x.name}${x.phone ? ' · ' + fmtPhone(x.phone) : ''} · ${fmtUsd(num(x.balance_cents))}`} onClose={() => setMerge(false)} onPick={async drop => { if (!(await confirmD(pt('mergeConfirm', locale).replace('{drop}', drop.name).replace('{keep}', supplier.name), { danger: true }))) return; await mergeSuppliers(boot.db, supplier, drop); boot.engine.poke(); setMerge(false); onChanged(); onClose(); }} />}
  </>;
}

/** Owner only: set what the shop really owes this supplier, with a reason. No cash moves; the correction shows in the statement. */
function BalanceFix({ boot, locale, supplier, rate, staff, onClose, onDone }: { boot: Booted; locale: L; supplier: Supplier; rate: number; staff: Staff; onClose: () => void; onDone: () => void }) {
  const cur = num(supplier.balance_cents);
  const [val, setVal] = useState((cur / 100).toFixed(2)); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const target = Math.round(Number(val) * 100); const valid = val.trim() !== '' && !Number.isNaN(Number(val)); const delta = valid ? target - cur : 0;
  const save = async () => {
    if (!valid || !delta || !reason.trim() || busy) return; setBusy(true); setErr(null);
    try { await adjustSupplierBalance(boot.db, { supplier, new_balance_cents: target, reason, rate, user_id: staff.user_id }); boot.engine.poke(); onDone(); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return <Modal open onClose={onClose} title={`⚖ ${pt('balanceFix', locale)} · ${supplier.name}`}
    footer={<><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} /><button className="btn primary" disabled={!valid || !delta || !reason.trim() || busy} onClick={save}>{pt('save', locale)}</button></>}>
    <div className="stack" style={{ gap: 10 }}>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>{pt('balanceFixHint', locale)}</p>
      <div className="row spread"><span>{pt('balanceNow', locale)}</span><strong dir="ltr">{fmtUsd(cur)}</strong></div>
      <label className="label">{pt('balanceReal', locale)}<input className="input" dir="ltr" inputMode="decimal" autoFocus value={val} onChange={e => setVal(e.target.value.replace(/[^0-9.\-]/g, ''))} onFocus={e => e.target.select()} /></label>
      {valid && delta !== 0 && <div className={`pill ${delta > 0 ? 'bad' : 'ok'}`} style={{ alignSelf: 'flex-start' }} dir="ltr">{delta > 0 ? '+' : '−'}{fmtUsd(Math.abs(delta))}</div>}
      <label className="label">{pt('balanceFixReason', locale)} *<input className="input" value={reason} maxLength={200} onChange={e => setReason(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void save(); }} /></label>
      {err && <div className="bad">{err}</div>}
    </div>
  </Modal>;
}

function PayDialogS({ boot, locale, supplier, rate, staff, onClose, onDone }: { boot: Booted; locale: L; supplier: Supplier; rate: number; staff: Staff; onClose: () => void; onDone: () => void }) {
  const [tender, setTender] = useState<SupplierPayment['tender']>('cash_usd'); const cur: Currency = tender === 'cash_lbp' ? 'lbp' : 'usd';
  const owed = Math.max(0, num(supplier.balance_cents)); const step = boot.shop.lbp_rounding_step ?? 5000;
  const [amount, setAmount] = useState(() => (owed / 100).toFixed(2).replace(/\.00$/, '')); const [drawer, setDrawer] = useState(true); const [busy, setBusy] = useState(false); const [note, setNote] = useState('');
  useEffect(() => { setAmount(cur === 'lbp' ? String(roundLbp(usdToLbp(owed, rate), step, 'up')) : (owed / 100).toFixed(2).replace(/\.00$/, '')); }, [cur]); // eslint-disable-line react-hooks/exhaustive-deps
  const raw = cur === 'lbp' ? Math.round(Number(amount) || 0) : Math.round((Number(amount) || 0) * 100);
  const confirm = async () => {
    if (busy || raw <= 0) return; setBusy(true);
    const shift = await currentShift(boot.db);
    await paySupplier(boot.db, { supplier, tender, currency: cur, amount: raw, rate, from_drawer: drawer && (tender === 'cash_usd' || tender === 'cash_lbp'), shift, note: note.trim() || null, user_id: staff.user_id, approved_by: staff.role === 'owner' ? staff.user_id : null });
    boot.engine.poke(); onDone();
  };
  return <Modal open onClose={onClose} title={`${pt('paySupplier', locale)} · ${supplier.name}`} wide footer={<><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} /><button className="btn primary big" style={{ width: 'auto', minWidth: 180 }} disabled={busy || raw <= 0} onClick={confirm}>{pt('paySupplier', locale)} ↵</button></>}>
    <div className="pay-grid">
      <div className="stack">
        <div className="pay-due"><div><span className="muted">{pt('weOwe', locale)}</span><strong>{fmtUsd(owed)}</strong><strong>{fmtLbp(roundLbp(usdToLbp(owed, rate), step), locale)}</strong></div><div><span className="muted">{pt('amountPaid', locale)}</span><span>{cur === 'lbp' ? fmtLbp(raw, locale) : fmtUsd(raw)}</span></div></div>
        <div className="tenders">{(['cash_usd', 'cash_lbp', 'card', 'transfer'] as SupplierPayment['tender'][]).map(t => <button key={t} className={`chip ${tender === t ? 'active' : ''}`} onClick={() => setTender(t)}>{pt(t as Key, locale)}</button>)}</div>
        <div className="pay-amount"><span className="muted">{pt(tender as Key, locale)}</span><strong dir="ltr">{amount || '0'}</strong></div>
        {(tender === 'cash_usd' || tender === 'cash_lbp') && <div className="seg"><button className={drawer ? 'active' : ''} onClick={() => setDrawer(true)}>{pt('fromDrawer', locale)}</button><button className={!drawer ? 'active' : ''} onClick={() => setDrawer(false)}>{pt('outsideDrawer', locale)}</button></div>}
        <input className="input" placeholder={pt('note', locale)} value={note} onChange={e => setNote(e.target.value)} />
      </div>
      <NumPad value={amount} onChange={setAmount} decimal={cur === 'usd'} onEnter={() => void confirm()} big />
    </div>
  </Modal>;
}
