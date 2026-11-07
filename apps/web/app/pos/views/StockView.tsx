'use client';
import { useEffect, useMemo, useState } from 'react';
import { fmtUsd, num, recordStockMove, text, type CatalogIndex, type Product, type Staff, type StockMove, type StockMoveKind } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import { fmtTime } from '../lib/boot';
import { useScanner } from '../lib/useScanner';
import Modal, { NumPad } from '../components/Modal';
import OwnerPin from '../components/OwnerPin';
import ItemEditor from '../components/ItemEditor';

type Mode = 'receive' | 'count' | 'damaged' | 'adjust';

/**
 * Stock: receive by scan (qty + optional new cost), count (counted qty → auto adjustment), damaged, manual adjust; low-stock list with a
 * WhatsApp-shareable reorder list; negative-stock review; movement history per item. Everything offline (stock.move ops).
 * Cashiers need an owner PIN for adjustments (server enforces); stock role and owner work freely.
 */
export default function StockView({ boot, locale, index, tick, staff, reindex }: { boot: Booted; locale: L; index: CatalogIndex; tick: number; staff: Staff; reindex: () => void }) {
  const [mode, setMode] = useState<Mode>('receive');
  const [q, setQ] = useState(''); const [sel, setSel] = useState<Product | null>(null);
  const [members, setMembers] = useState<Staff[]>([]);
  const [newFromBc, setNewFromBc] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [hist, setHist] = useState<Product | null>(null);
  useEffect(() => { boot.db.staff.toArray().then(setMembers); }, [boot, tick]);
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 1800); };
  useScanner(code => { if (sel || newFromBc) return; const p = index.scan(code); if (p) setSel(p); else setNewFromBc(code); });
  const tracked = useMemo(() => [...index.byId.values()].filter(p => p.track_stock), [index, tick]);
  const low = useMemo(() => tracked.filter(p => num(p.on_hand) - num(p.reserved) <= num(p.min_stock)).sort((a, b) => (num(a.on_hand) - num(a.reserved)) - (num(b.on_hand) - num(b.reserved))), [tracked]);
  const negative = useMemo(() => tracked.filter(p => p.needs_review || num(p.on_hand) < 0), [tracked]);
  const results = q.trim() ? index.search(q, 30) : [];

  const shareReorder = () => {
    const lines = low.map(p => `• ${text(p.name, locale)} — ${pt('available', locale)}: ${num(p.on_hand) - num(p.reserved)}${p.unit ? ' ' + p.unit : ''} (${pt('minStock', locale)} ${num(p.min_stock)})`);
    const txt = `${pt('lowStockList', locale)} — ${text(boot.shop.name, locale)} — ${new Date().toLocaleDateString('en-GB')}\n${lines.join('\n')}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(txt)}`, '_blank');
  };

  return (
    <div className="stack" style={{ padding: 16 }}>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="seg">{(['receive', 'count', 'damaged', 'adjust'] as Mode[]).map(m => <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>{pt(m, locale)}</button>)}</div>
        <input className="input" style={{ flex: 1, minWidth: 220 }} placeholder={pt('scanToReceive', locale)} value={q} onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && q.trim()) { const p = index.scan(q.trim()) ?? results[0]; if (p) { setSel(p); setQ(''); } } }} autoFocus />
      </div>
      {!!results.length && <div className="grid-items">{results.map(p => <button key={p.id} className="item-tile" onClick={() => { setSel(p); setQ(''); }}><div className="item-name">{text(p.name, locale)}</div><div className="muted" style={{ fontSize: 12 }}>{p.track_stock ? `${num(p.on_hand) - num(p.reserved)} ${pt('available', locale)}` : '—'}</div></button>)}</div>}

      {!!negative.length && (
        <section className="card" style={{ borderColor: '#fca5a5', background: '#fef2f2' }}>
          <strong>⚠ {pt('negativeReview', locale)} ({negative.length})</strong>
          <table className="table"><tbody>{negative.map(p => <tr key={p.id}><td>{text(p.name, locale)}</td><td className="num bad">{num(p.on_hand)}</td><td><button className="btn" onClick={() => { setMode('count'); setSel(p); }}>{pt('count', locale)}</button></td></tr>)}</tbody></table>
        </section>
      )}
      <section className="card">
        <div className="row spread" style={{ alignItems: 'center' }}><strong>{pt('lowStockList', locale)} ({low.length})</strong>{!!low.length && <button className="btn" onClick={shareReorder}>💬 {pt('shareReorder', locale)}</button>}</div>
        <table className="table"><tbody>
          {low.map(p => <tr key={p.id}><td>{text(p.name, locale)}</td><td className="num bad">{num(p.on_hand) - num(p.reserved)}{p.unit ? ' ' + p.unit : ''}</td><td className="muted num">{pt('minStock', locale)} {num(p.min_stock)}</td><td><button className="btn" onClick={() => { setMode('receive'); setSel(p); }}>{pt('receive', locale)}</button></td></tr>)}
          {!low.length && <tr><td className="muted">—</td></tr>}
        </tbody></table>
      </section>
      <section className="card">
        <strong>{pt('trackStock', locale)} ({tracked.length})</strong>
        <table className="table"><tbody>{tracked.slice(0, 200).map(p => <tr key={p.id}><td>{text(p.name, locale)}</td><td className="num">{num(p.on_hand)}{num(p.reserved) ? <span className="muted"> (−{num(p.reserved)})</span> : ''}</td><td className="muted num">{p.cost_cents != null && boot.role === 'owner' ? fmtUsd(p.cost_cents) : ''}</td><td><button className="btn icon" onClick={() => setHist(p)}>📜</button><button className="btn icon" onClick={() => setSel(p)}>✎</button></td></tr>)}</tbody></table>
      </section>

      {toast && <div className="pos-toast">{toast}</div>}
      {sel && <MoveDialog boot={boot} locale={locale} product={sel} mode={mode} staff={members} me={staff}
        onDone={(delta) => { setSel(null); reindex(); flash(`${text(sel.name, locale)}: ${delta > 0 ? '+' : ''}${delta}`); boot.engine.poke(); }} onClose={() => setSel(null)} />}
      {newFromBc && <NewFromBarcode locale={locale} code={newFromBc} onYes={() => { /* opens editor below */ }} onClose={() => setNewFromBc(null)} boot={boot} index={index} staff={members} me={staff} reindex={reindex} />}
      {hist && <History boot={boot} locale={locale} product={hist} onClose={() => setHist(null)} />}
    </div>
  );
}

function MoveDialog({ boot, locale, product, mode, staff, me, onDone, onClose }: { boot: Booted; locale: L; product: Product; mode: Mode; staff: Staff[]; me: Staff; onDone: (delta: number) => void; onClose: () => void }) {
  const [qty, setQty] = useState(mode === 'count' ? String(num(product.on_hand)) : ''); const [cost, setCost] = useState(product.cost_cents != null ? (product.cost_cents / 100).toString() : ''); const [note, setNote] = useState('');
  const [field, setField] = useState<'qty' | 'cost'>('qty'); const [gate, setGate] = useState(false);
  const kind: StockMoveKind = mode === 'adjust' ? 'adjust' : mode;
  const n = Number(qty);
  const save = async (by?: string | null) => {
    const delta = await recordStockMove(boot.db, product, { kind, qty: n, unit_cost_cents: mode === 'receive' && cost !== '' ? Math.round(Number(cost) * 100) : null, note: note.trim() || undefined, user_id: me.user_id, approved_by: by });
    onDone(delta);
  };
  const submit = () => { if (isNaN(n) || (mode !== 'count' && !n)) return; if (me.role === 'cashier') setGate(true); else void save(); };
  return (
    <>
      <Modal open onClose={onClose} title={`${pt(mode, locale)} · ${text(product.name, locale)}`} wide footer={<><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} /><button className="btn primary" onClick={submit}>{pt('ok', locale)}</button></>}>
        <div className="line-editor">
          <div className="stack">
            <div className="muted">{pt('systemQty', locale)}: <strong>{num(product.on_hand)}</strong>{num(product.reserved) ? ` (−${num(product.reserved)} ${pt('move_reserve', locale)})` : ''}</div>
            <button type="button" className={`field ${field === 'qty' ? 'active' : ''}`} onClick={() => setField('qty')}><span className="muted">{mode === 'count' ? pt('countedQty', locale) : mode === 'adjust' ? '± ' + pt('qty', locale) : pt('qty', locale)}</span><strong>{qty || '0'}</strong></button>
            {mode === 'receive' && <button type="button" className={`field ${field === 'cost' ? 'active' : ''}`} onClick={() => setField('cost')}><span className="muted">{pt('unitCost', locale)} ($)</span><strong>{cost || '—'}</strong></button>}
            <input className="input" placeholder={pt('note', locale)} value={note} onChange={e => setNote(e.target.value)} />
            {mode === 'count' && <div className="muted" style={{ fontSize: 13 }}>{pt('adjust', locale)}: {isNaN(n) ? '' : (n - num(product.on_hand) > 0 ? '+' : '') + (n - num(product.on_hand))}</div>}
          </div>
          <NumPad value={field === 'qty' ? qty : cost} onChange={field === 'qty' ? setQty : setCost} decimal={field === 'cost' || !!product.decimal_qty || mode === 'adjust'} onEnter={submit} big />
        </div>
      </Modal>
      {gate && <OwnerPin open locale={locale} staff={staff} me={me} reason={pt(mode, locale)} onDone={id => { setGate(false); if (id) void save(id); }} />}
    </>
  );
}

function NewFromBarcode({ boot, locale, code, index, staff, me, reindex, onClose }: { boot: Booted; locale: L; code: string; index: CatalogIndex; staff: Staff[]; me: Staff; reindex: () => void; onYes: () => void; onClose: () => void }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <ItemEditor boot={boot} locale={locale} index={index} product={null} presetBarcode={code} staff={staff} me={me} onDone={() => { reindex(); onClose(); }} onClose={onClose} />;
  return <Modal open onClose={onClose} title={pt('unknownBarcode', locale)} footer={<><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} /><button className="btn primary" onClick={() => setEditing(true)}>{pt('createFromBarcode', locale)}</button></>}><p dir="ltr" style={{ textAlign: 'center', fontSize: 20 }}>{code}</p></Modal>;
}

function History({ boot, locale, product, onClose }: { boot: Booted; locale: L; product: Product; onClose: () => void }) {
  const [rows, setRows] = useState<StockMove[]>([]);
  useEffect(() => { boot.db.stockMoves.where('product_id').equals(product.id).reverse().sortBy('at').then(r => setRows(r.slice(0, 100))); }, [boot, product]);
  return <Modal open onClose={onClose} title={`${pt('history', locale)} · ${text(product.name, locale)}`}>
    <table className="table"><tbody>{rows.map(m => <tr key={m.id}><td className="muted">{fmtTime(m.at, locale)}</td><td>{pt(`move_${m.kind}` as 'move_sale', locale)}{m.note ? ` · ${m.note}` : ''}</td><td className={`num ${num(m.qty) < 0 ? 'bad' : ''}`}>{num(m.qty) > 0 ? '+' : ''}{num(m.qty)}</td></tr>)}{!rows.length && <tr><td className="muted">—</td></tr>}</tbody></table>
  </Modal>;
}
