'use client';
import { useEffect, useMemo, useState } from 'react';
import { commitPurchase, currentShift, fmtLbp, fmtPhone, fmtUsd, num, paySupplier, purchaseTotals, roundLbp, supplierStatement, text, upsertSupplier, mergeSuppliers, deleteSupplier, supplierHasHistory, usdToLbp, voidPurchase, type CatalogIndex, type Currency, type Product, type Purchase, type PurchaseDraftLine, type PurchaseLine, type Rate, type Staff, type Supplier, type SupplierPayment } from '@suqa/pos-core';
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
export default function PurchasesView({ boot, locale, index, tick, staff, reindex }: { boot: Booted; locale: L; index: CatalogIndex; tick: number; staff: Staff; reindex: () => void }) {
  const [tab, setTab] = useState<Tab>('invoices'); const [supQ, setSupQ] = useState('');
  const supMatch = (s: Supplier) => { const n = supQ.trim().toLowerCase(); const d = supQ.replace(/\D/g, ''); return !n || s.name.toLowerCase().includes(n) || (s.contact ?? '').toLowerCase().includes(n) || (!!d && (s.phone_key ?? '').includes(d)); };
  const [suppliers, setSuppliers] = useState<Supplier[]>([]); const [purchases, setPurchases] = useState<Purchase[]>([]); const [rate, setRate] = useState(89500);
  const [entry, setEntry] = useState<{ kind: 'purchase' | 'return' } | null>(null); const [selSup, setSelSup] = useState<Supplier | null>(null); const [editSup, setEditSup] = useState<Supplier | 'new' | null>(null); const [lastSup, setLastSup] = useState<string | null>(null);
  const [openPur, setOpenPur] = useState<Purchase | null>(null); const [lines, setLines] = useState<PurchaseLine[]>([]);
  const canEdit = staff.role !== 'cashier';
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
        <table className="table"><tbody>
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
        <table className="table"><tbody>
          {suppliers.filter(supMatch).map(s => <tr key={s.id} className={s.active ? '' : 'muted'} style={{ cursor: 'pointer' }} onClick={() => setSelSup(s)}>
            <td><strong>{s.name}</strong>{s.contact ? <span className="muted"> · {s.contact}</span> : ''}</td><td className="muted" dir="ltr">{s.phone ? fmtPhone(s.phone) : ''}</td>
            <td className="num"><strong className={num(s.balance_cents) > 0 ? 'bad' : num(s.balance_cents) < 0 ? 'ok' : ''}>{fmtUsd(num(s.balance_cents))}</strong></td>
          </tr>)}
        </tbody></table>
      </section>}

      {entry && <PurchaseEntry boot={boot} locale={locale} index={index} staff={staff} suppliers={suppliers} rate={rate} kind={entry.kind} preferId={lastSup} onNewSupplier={() => setEditSup('new')} onClose={() => setEntry(null)} onDone={() => { setEntry(null); reindex(); }} />}
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

function PurchaseEntry({ boot, locale, index, staff, suppliers, rate, kind, preferId, onNewSupplier, onClose, onDone }: { boot: Booted; locale: L; index: CatalogIndex; staff: Staff; suppliers: Supplier[]; rate: number; kind: 'purchase' | 'return'; preferId: string | null; onNewSupplier: () => void; onClose: () => void; onDone: () => void }) {
  const [supplier, setSupplier] = useState<Supplier | null>(suppliers.length === 1 ? suppliers[0] : null);
  useEffect(() => { if (preferId) { const s = suppliers.find(x => x.id === preferId); if (s) setSupplier(s); } }, [preferId, suppliers]); // a supplier just created from ＋ becomes the selected one
  const [currency, setCurrency] = useState<Currency>('usd'); const [invNo, setInvNo] = useState(''); const [invDate, setInvDate] = useState(new Date().toISOString().slice(0, 10)); const [discount, setDiscount] = useState(''); const [note, setNote] = useState('');
  const [rows, setRows] = useState<PurchaseDraftLine[]>([]); const [q, setQ] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [members, setMembers] = useState<Staff[]>([]); const [gate, setGate] = useState(false);
  useEffect(() => { boot.db.staff.toArray().then(setMembers); }, [boot]);
  const results = q.trim() ? index.search(q, 12) : [];
  const add = (p: Product) => {
    setRows(rs => { const i = rs.findIndex(r => r.product.id === p.id); if (i >= 0) { const c = rs.slice(); c[i] = { ...c[i], qty: c[i].qty + 1 }; return c; }
      const cost = currency === 'lbp' ? Math.round((num(p.cost_cents) / 100) * rate) : num(p.cost_cents) / 100; return [...rs, { product: p, qty: 1, unit_cost: cost || 0 }]; });
    setQ('');
  };
  useScanner(code => { const p = index.scan(code); if (p) add(p); });
  const upd = (i: number, patch: Partial<PurchaseDraftLine>) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const t = useMemo(() => purchaseTotals(rows, currency, rate, Number(discount) || 0), [rows, currency, rate, discount]);
  const submit = async (approvedBy: string | null) => {
    if (!supplier || !rows.length || busy) return; setBusy(true); setErr(null);
    try { await commitPurchase(boot.db, { supplier, kind, lines: rows.filter(r => r.qty > 0), currency, rate, discount: Number(discount) || 0, invoice_no: invNo.trim() || null, invoice_date: invDate, note: note.trim() || null, user_id: staff.user_id, approved_by: approvedBy }); boot.engine.poke(); onDone(); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  const marginPct = Number(boot.shop.default_margin_pct) || 0;
  const applyMargin = () => setRows(rs => rs.map(r => { const costUsd = currency === 'lbp' ? r.unit_cost / rate : r.unit_cost; const m = r.product.margin_pct != null && r.product.margin_pct !== '' ? Number(r.product.margin_pct) : marginPct; return costUsd > 0 ? { ...r, new_price_usd: Math.ceil((costUsd / (1 - m / 100)) * 4) / 4 } : r; }));
  const supplierItems = useMemo(() => supplier ? index.byCategory(null, 100000).filter(p => p.supplier_id === supplier.id && !rows.some(r => r.product.id === p.id)).slice(0, 40) : [], [supplier, rows, index]);
  const sym = currency === 'lbp' ? 'ل.ل.' : '$';
  const fmtC = (v: number) => (currency === 'lbp' ? fmtLbp(Math.round(v), locale) : fmtUsd(Math.round(v * 100)));
  return (
    <>
      <Modal open onClose={onClose} title={pt(kind === 'return' ? 'purchaseReturn' : 'newPurchase', locale)} wide
        footer={<><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} /><strong style={{ fontSize: 18 }}>{fmtC(t.total)} <span className="muted" style={{ fontSize: 12 }}>{fmtUsd(t.total_cents)}</span></strong>
          <button className="btn primary big" style={{ width: 'auto', minWidth: 200 }} disabled={!supplier || !rows.length || busy} onClick={() => (staff.role === 'cashier' ? setGate(true) : submit(null))}>{pt('receiveStock', locale)}</button></>}>
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
        <table className="table pur-lines" style={{ marginTop: 10 }}><tbody>
          <tr><th style={{ textAlign: 'start' }}>{pt('items', locale)}</th><th>{pt('qty', locale)}</th><th>{pt('unitCost', locale)} ({sym})</th><th>{pt('total', locale)}</th>{kind === 'purchase' && <th>{pt('newSellPrice', locale)} ($)</th>}<th></th></tr>
          {rows.map((r, i) => {
            const costUsd = currency === 'lbp' ? r.unit_cost / rate : r.unit_cost; const price = r.new_price_usd ?? num(r.product.price_usd); const margin = costUsd > 0 && price > 0 ? Math.round(((price - costUsd) / price) * 100) : null;
            return <tr key={r.product.id}>
              <td>{text(r.product.name, locale)}<div className="muted" style={{ fontSize: 11 }}>{pt('onHand', locale)} {num(r.product.on_hand)} · {pt('lastCost', locale)} {fmtUsd(num(r.product.cost_cents))}</div></td>
              <td><input className="input" dir="ltr" inputMode="decimal" value={r.qty} onChange={e => upd(i, { qty: Number(e.target.value) || 0 })} style={{ width: 80 }} /></td>
              <td><input className="input" dir="ltr" inputMode="decimal" value={r.unit_cost} onChange={e => upd(i, { unit_cost: Number(e.target.value) || 0 })} style={{ width: 110 }} /></td>
              <td className="num">{fmtC(r.qty * r.unit_cost)}</td>
              {kind === 'purchase' && <td><input className="input" type="date" dir="ltr" value={r.expiry ?? ''} onChange={e => upd(i, { expiry: e.target.value || null })} style={{ width: 140 }} title={pt('expiry', locale)} /></td>}
              {kind === 'purchase' && <td><input className="input" dir="ltr" inputMode="decimal" placeholder={String(num(r.product.price_usd))} value={r.new_price_usd ?? ''} onChange={e => upd(i, { new_price_usd: e.target.value === '' ? null : Number(e.target.value) })} style={{ width: 100 }} />{margin != null && <div className={`muted ${margin < 0 ? 'bad' : ''}`} style={{ fontSize: 11 }}>{pt('margin', locale)} {margin}%</div>}</td>}
              <td><button className="btn icon" onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}>✕</button></td>
            </tr>;
          })}
          {!rows.length && <tr><td colSpan={6} className="muted">{pt('noLines', locale)}</td></tr>}
        </tbody></table>
        <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div><label className="label">{pt('discount', locale)} ({sym})</label><input className="input" dir="ltr" inputMode="decimal" value={discount} onChange={e => setDiscount(e.target.value)} style={{ width: 120 }} /></div>
          <div style={{ flex: 1, minWidth: 160 }}><label className="label">{pt('note', locale)}</label><input className="input" value={note} onChange={e => setNote(e.target.value)} /></div>
          {kind === 'purchase' && marginPct > 0 && <button className="btn ghost" onClick={applyMargin}>{pt('applyMargin', locale)} ({marginPct}%)</button>}
          <div className="muted" style={{ fontSize: 13 }}>{pt('subtotal', locale)} {fmtC(t.subtotal)}</div>
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
    <div className="muted" style={{ fontSize: 13 }}>{fmtTime(purchase.at, locale)} · {purchase.invoice_no ?? ''} · {purchase.invoice_date} · {pt(purchase.status === 'void' ? 'voided' : 'posted', locale)}{purchase.note ? ` · ${purchase.note}` : ''}</div>
    <table className="table" style={{ marginTop: 8 }}><tbody>
      {lines.map(l => <tr key={l.id}><td>{text(l.name, locale)}</td><td style={{ textAlign: 'center' }}>{num(l.qty)}</td><td className="num">{fmtC(num(l.unit_cost))}</td><td className="num">{fmtUsd(num(l.line_total_cents))}</td><td className="muted">{l.new_price_usd != null ? `→ ${fmtUsd(Math.round(num(l.new_price_usd) * 100))}` : ''}</td></tr>)}
      <tr><td colSpan={3}><strong>{pt('total', locale)}</strong>{num(purchase.discount) ? <span className="muted"> ({pt('discount', locale)} {fmtC(num(purchase.discount))})</span> : ''}</td><td className="num"><strong>{fmtUsd(num(purchase.total_cents))}</strong></td><td className="muted">{fmtC(num(purchase.total))}</td></tr>
    </tbody></table>
  </Modal>;
}

function SupplierCard({ boot, locale, supplier, staff, rate, canEdit, onEdit, onClose, onChanged }: { boot: Booted; locale: L; supplier: Supplier; staff: Staff; rate: number; canEdit: boolean; onEdit: () => void; onClose: () => void; onChanged: () => void }) {
  const [st, setSt] = useState<Awaited<ReturnType<typeof supplierStatement>>>([]); const [pay, setPay] = useState(false);
  useEffect(() => { supplierStatement(boot.db, supplier).then(setSt); }, [boot, supplier]);
  const [merge, setMerge] = useState(false); const [hasHistory, setHasHistory] = useState(true); const [all, setAll] = useState<Supplier[]>([]); const confirmD = useConfirm();
  useEffect(() => { supplierHasHistory(boot.db, supplier).then(setHasHistory); boot.db.suppliers.toArray().then(setAll); }, [boot, supplier]);
  const owner = staff.role === 'owner';
  const step = boot.shop.lbp_rounding_step ?? 5000;
  return <>
    <Modal open onClose={onClose} title={supplier.name} wide footer={<><button className="btn" onClick={() => doPrint(supplierStatementHtml(supplier, st, boot.shop, locale, loadPrintSettings()))}>🖨 {pt('statementTitle', locale)}</button>{canEdit && <button className="btn ghost" onClick={onEdit}>✎</button>}{owner && <button className="btn" onClick={() => setMerge(true)}>⇄ {pt('mergeSupplier', locale)}</button>}{owner && <button className="btn danger" disabled={hasHistory} title={hasHistory ? pt('hasHistoryHintS', locale) : ''} onClick={async () => { if (!(await confirmD(`${pt('deleteSupplier', locale)}: ${supplier.name}?`, { danger: true }))) return; await deleteSupplier(boot.db, supplier); boot.engine.poke(); onChanged(); onClose(); }}>🗑</button>}<span style={{ flex: 1 }} />{canEdit && <button className="btn primary" onClick={() => setPay(true)}>💵 {pt('paySupplier', locale)}</button>}</>}>
      <div className="kpis">
        <div className="kpi"><span>{pt('weOwe', locale)}</span><strong className={num(supplier.balance_cents) > 0 ? 'bad' : ''}>{fmtUsd(num(supplier.balance_cents))}</strong><small>{fmtLbp(roundLbp(usdToLbp(num(supplier.balance_cents), rate), step), locale)}</small></div>
        <div className="kpi"><span>{pt('customerPhone', locale)}</span><strong dir="ltr" style={{ fontSize: 15 }}>{supplier.phone ? fmtPhone(supplier.phone) : '—'}</strong><small>{supplier.contact ?? ''}</small></div>
      </div>
      <table className="table" style={{ marginTop: 10 }}><tbody>
        {st.map((x, i) => <tr key={i} className={x.kind === 'void' ? 'muted' : ''}><td className="muted">{fmtTime(x.at, locale)}</td><td>{x.kind === 'payment' ? `${pt('paySupplier', locale)} · ${pt(x.ref as Key, locale)}` : x.ref.replace('~', '')}{x.kind === 'void' ? ` · ${pt('voided', locale)}` : ''}</td><td className={`num ${x.amount_cents < 0 ? 'ok' : ''}`}>{fmtUsd(x.amount_cents)}</td><td className="num muted">{fmtUsd(x.balance_cents)}</td></tr>)}
        {!st.length && <tr><td className="muted">—</td></tr>}
      </tbody></table>
    </Modal>
    {pay && <PayDialogS boot={boot} locale={locale} supplier={supplier} rate={rate} staff={staff} onClose={() => setPay(false)} onDone={() => { setPay(false); onChanged(); supplierStatement(boot.db, supplier).then(setSt); }} />}
    {merge && <MergeDialog locale={locale} keep={supplier} candidates={all.filter(x => x.id !== supplier.id)} label={x => `${x.name}${x.phone ? ' · ' + fmtPhone(x.phone) : ''} · ${fmtUsd(num(x.balance_cents))}`} onClose={() => setMerge(false)} onPick={async drop => { if (!(await confirmD(pt('mergeConfirm', locale).replace('{drop}', drop.name).replace('{keep}', supplier.name), { danger: true }))) return; await mergeSuppliers(boot.db, supplier, drop); boot.engine.poke(); setMerge(false); onChanged(); onClose(); }} />}
  </>;
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
