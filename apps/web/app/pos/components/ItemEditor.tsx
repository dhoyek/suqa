'use client';
import { useEffect, useMemo, useState } from 'react';
import { barcodeOwner, createProduct, normBarcode, patchProduct, text, type CatalogIndex, type Product, type Staff } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import { useScanner } from '../lib/useScanner';
import Modal from './Modal';
import OwnerPin from './OwnerPin';

const UNITS = ['piece', 'kg', 'g', 'l', 'ml', 'pack'] as const;

/**
 * Create / edit an item. Works offline: the row is written locally and a product.patch op is queued.
 * Cashiers need an owner PIN (server enforces it too); owner / stock role edit freely. Cost is owner-only.
 */
export default function ItemEditor({ boot, locale, index, product, presetBarcode, staff, me, onDone, onClose }: {
  boot: Booted; locale: L; index: CatalogIndex; product: Product | null; presetBarcode?: string; staff: Staff[]; me: Staff; onDone: (p: Product) => void; onClose: () => void;
}) {
  const owner = boot.role === 'owner';
  const [ar, setAr] = useState(product?.name?.ar ?? ''); const [en, setEn] = useState(product?.name?.en ?? '');
  const [cat, setCat] = useState<string>(product?.category_id ?? '');
  const [cur, setCur] = useState<'usd' | 'lbp'>(product?.price_currency ?? 'usd');
  const [price, setPrice] = useState(product ? (product.price_currency === 'lbp' ? String(product.price_lbp) : String(Number(product.price_usd))) : '');
  const [cost, setCost] = useState(product?.cost_cents != null ? (product.cost_cents / 100).toString() : '');
  const [sku, setSku] = useState(product?.sku ?? '');
  const [bcs, setBcs] = useState<string[]>(() => (product ? index.barcodes(product.id) : presetBarcode ? [normBarcode(presetBarcode)] : []));
  const [bcInput, setBcInput] = useState(''); const [bcErr, setBcErr] = useState<string | null>(null);
  const [unit, setUnit] = useState<string>(product?.unit_kind ?? 'piece'); const [dec, setDec] = useState(!!product?.decimal_qty); const [vat, setVat] = useState(!!product?.vat);
  const [track, setTrack] = useState(!!product?.track_stock); const [min, setMin] = useState(String(Number(product?.min_stock ?? 0)));
  const [vis, setVis] = useState(product?.visible_online ?? true); const [avail, setAvail] = useState(product?.is_available ?? true); const [active, setActive] = useState(product?.is_active ?? true);
  const [gate, setGate] = useState(false); const [err, setErr] = useState<string | null>(null);
  const cats = useMemo(() => [...index.categories.values()].sort((a, b) => a.sort_order - b.sort_order), [index]);
  const original = useMemo(() => (product ? index.barcodes(product.id) : []), [product, index]);

  const addBc = async (raw: string) => {
    const b = normBarcode(raw); if (!b) return;
    const other = await barcodeOwner(boot.db, b);
    if (other && other !== product?.id) { setBcErr(`${pt('barcodeExists', locale)}: ${text(index.byId.get(other)?.name, locale)}`); return; }
    setBcErr(null); setBcs(x => (x.includes(b) ? x : [...x, b])); setBcInput('');
  };
  useScanner(code => { void addBc(code); });

  const valid = (ar.trim() || en.trim()) && Number(price) >= 0 && price !== '';
  const build = () => {
    const priceNum = Number(price) || 0;
    const fields: Partial<Product> = {
      name: { ar: ar.trim() || en.trim(), en: en.trim() || ar.trim() }, category_id: cat || null, price_currency: cur,
      price_usd: cur === 'usd' ? priceNum : Number(product?.price_usd ?? 0), price_lbp: cur === 'lbp' ? Math.round(priceNum) : Number(product?.price_lbp ?? 0),
      sku: sku.trim() || null, unit_kind: unit, unit: unit === 'piece' ? null : unit, decimal_qty: dec || unit === 'kg' || unit === 'g', vat, track_stock: track, min_stock: Number(min) || 0,
      visible_online: vis, is_available: avail, is_active: active,
    };
    if (owner) fields.cost_cents = cost === '' ? null : Math.round(Number(cost) * 100);
    return fields;
  };
  const save = async (approvedBy?: string | null) => {
    try {
      const fields = build();
      const p = product
        ? await patchProduct(boot.db, product, { fields, barcodes_add: bcs.filter(b => !original.includes(b)), barcodes_remove: original.filter(b => !bcs.includes(b)), approved_by: approvedBy })
        : await createProduct(boot.db, fields as Parameters<typeof createProduct>[1], bcs, approvedBy);
      boot.engine.poke(); onDone(p);
    } catch (e) { setErr((e as Error).message); }
  };
  const submit = () => { if (!valid) return; if (me.role === 'cashier') setGate(true); else void save(); };
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Enter' && e.ctrlKey) submit(); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <Modal open onClose={onClose} title={product ? pt('editItem', locale) : pt('newItem', locale)} wide
        footer={<><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} />{err && <span className="bad">{err}</span>}<button className="btn primary" disabled={!valid} onClick={submit}>{pt('save', locale)}</button></>}>
        <div className="item-form">
          <label className="label">{pt('nameAr', locale)}<input className="input" value={ar} onChange={e => setAr(e.target.value)} autoFocus /></label>
          <label className="label">{pt('nameEn', locale)}<input className="input" dir="ltr" value={en} onChange={e => setEn(e.target.value)} /></label>
          <label className="label">{pt('category', locale)}<select className="input" value={cat} onChange={e => setCat(e.target.value)}><option value="">{pt('noCategory', locale)}</option>{cats.map(c => <option key={c.id} value={c.id}>{text(c.name, locale)}</option>)}</select></label>
          <label className="label">{pt('price', locale)}
            <div className="row" style={{ gap: 8 }}>
              <div className="seg"><button type="button" className={cur === 'usd' ? 'active' : ''} onClick={() => setCur('usd')}>$</button><button type="button" className={cur === 'lbp' ? 'active' : ''} onClick={() => setCur('lbp')}>ل.ل.</button></div>
              <input className="input" dir="ltr" inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} style={{ flex: 1 }} />
            </div></label>
          {owner && <label className="label">{pt('cost', locale)} ($)<input className="input" dir="ltr" inputMode="decimal" value={cost} onChange={e => setCost(e.target.value)} /></label>}
          <label className="label">{pt('sku', locale)}<input className="input" dir="ltr" value={sku} onChange={e => setSku(e.target.value)} /></label>
          <div className="label" style={{ gridColumn: '1 / -1' }}>{pt('barcodes', locale)}
            <div className="row" style={{ gap: 6, flexWrap: 'wrap', margin: '4px 0' }}>{bcs.map(b => <span key={b} className="chip" dir="ltr">{b} <button type="button" className="btn icon" style={{ minHeight: 0, padding: '0 4px' }} onClick={() => setBcs(x => x.filter(y => y !== b))}>✕</button></span>)}</div>
            <div className="row" style={{ gap: 6 }}><input className="input" dir="ltr" placeholder={pt('addBarcode', locale)} value={bcInput} onChange={e => setBcInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void addBc(bcInput); } }} /><button type="button" className="btn" onClick={() => addBc(bcInput)}>＋</button></div>
            {bcErr && <div className="bad" style={{ fontSize: 13 }}>{bcErr}</div>}
          </div>
          <label className="label">{pt('unit', locale)}<select className="input" value={unit} onChange={e => setUnit(e.target.value)}>{UNITS.map(u => <option key={u} value={u}>{pt(u, locale)}</option>)}</select></label>
          <label className="label">{pt('minStock', locale)}<input className="input" dir="ltr" inputMode="decimal" value={min} onChange={e => setMin(e.target.value)} disabled={!track} /></label>
          <div className="checks" style={{ gridColumn: '1 / -1' }}>
            <label><input type="checkbox" checked={track} onChange={e => setTrack(e.target.checked)} /> {pt('trackStock', locale)}</label>
            <label><input type="checkbox" checked={dec || unit === 'kg' || unit === 'g'} disabled={unit === 'kg' || unit === 'g'} onChange={e => setDec(e.target.checked)} /> {pt('decimalQty', locale)}</label>
            <label><input type="checkbox" checked={vat} onChange={e => setVat(e.target.checked)} /> {pt('vat', locale)}</label>
            <label><input type="checkbox" checked={vis} onChange={e => setVis(e.target.checked)} /> {pt('visibleOnline', locale)}</label>
            <label><input type="checkbox" checked={avail} onChange={e => setAvail(e.target.checked)} /> {pt('sellable', locale)}</label>
            <label><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} /> {pt('active', locale)}</label>
          </div>
        </div>
      </Modal>
      {gate && <OwnerPin open locale={locale} staff={staff} me={me} reason={pt('editItem', locale)} onDone={id => { setGate(false); if (id) void save(id); }} />}
    </>
  );
}
