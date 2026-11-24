'use client';
import CategoryPicker from './CategoryPicker';
import { useEffect, useMemo, useState } from 'react';
import { barcodeOwner, createProduct, normBarcode, patchProduct, text, type CatalogIndex, type Product, type Staff, type Supplier } from '@suqa/pos-core';
import { pt, dayName, DAY_ORDER, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import { useScanner } from '../lib/useScanner';
import ImageUpload from '@/components/ImageUpload';
import Modal from './Modal';
import OwnerPin from './OwnerPin';
import dynamic from 'next/dynamic';
const CameraScanner = dynamic(() => import('./CameraScanner'), { ssr: false });      // loaded only when the camera button is pressed

const UNITS = ['piece', 'kg', 'g', 'l', 'ml', 'pack'] as const;

/**
 * Create / edit an item. Works offline: the row is written locally and a product.patch op is queued.
 * Cashiers need an owner PIN (server enforces it too); owner / stock role edit freely. Cost is owner-only.
 */
// `template` + no product = a NEW item that starts as a copy of another one (same category, price, unit, stock settings, description,
// picture…): only the name is left to change. Barcodes and the code are never copied — they belong to one item. `onCopy` shows the
// "copy" button on an existing item.
export default function ItemEditor({ boot, locale, index, product, template, presetBarcode, staff, me, onDone, onClose, onCopy }: {
  boot: Booted; locale: L; index: CatalogIndex; product: Product | null; template?: Product | null; presetBarcode?: string; staff: Staff[]; me: Staff; onDone: (p: Product) => void; onClose: () => void; onCopy?: (p: Product) => void;
}) {
  const src = product ?? template ?? null;      // where the form's first values come from
  const owner = boot.role === 'owner';
  const [ar, setAr] = useState(src?.name?.ar ?? ''); const [en, setEn] = useState(src?.name?.en ?? '');
  const [cat, setCat] = useState<string>(src?.section ?? '');
  const [cur, setCur] = useState<'usd' | 'lbp'>(src?.price_currency ?? 'usd');
  const [price, setPrice] = useState(src ? (src.price_currency === 'lbp' ? String(src.price_lbp) : String(Number(src.price_usd))) : '');
  const [cost, setCost] = useState(src?.cost_cents != null ? (src.cost_cents / 100).toString() : '');
  const [sku, setSku] = useState(product?.sku ?? '');
  const [dAr, setDAr] = useState(src?.description?.ar ?? ''); const [dEn, setDEn] = useState(src?.description?.en ?? ''); const [img, setImg] = useState<string | null>(src?.image_url ?? null);
  const online = typeof navigator === 'undefined' ? true : navigator.onLine;
  type Bc = { barcode: string; pack_qty: number; pack_price_usd: number | null };
  const [bcs, setBcs] = useState<Bc[]>(() => (product ? index.barcodes(product.id).map(b => { const r = index.barcodeRows.get(b); return { barcode: b, pack_qty: Number(r?.pack_qty ?? 1) || 1, pack_price_usd: r?.pack_price_usd != null && r.pack_price_usd !== '' ? Number(r.pack_price_usd) : null }; }) : presetBarcode ? [{ barcode: normBarcode(presetBarcode), pack_qty: 1, pack_price_usd: null }] : []));
  const marginPct = Number(boot.shop.default_margin_pct) || 0;
  const priceFromMargin = () => { const c = Number(cost); if (!c || !marginPct) return; setCur('usd'); setPrice((Math.ceil((c / (1 - marginPct / 100)) * 4) / 4).toFixed(2).replace(/\.00$/, '')); };
  const [bcInput, setBcInput] = useState(''); const [bcErr, setBcErr] = useState<string | null>(null);
  const [unit, setUnit] = useState<string>(src?.unit_kind ?? 'piece'); const [dec, setDec] = useState(!!src?.decimal_qty); const [vat, setVat] = useState(!!src?.vat);
  const [track, setTrack] = useState(!!src?.track_stock); const [min, setMin] = useState(String(Number(src?.min_stock ?? 0)));
  const [supplierId, setSupplierId] = useState(src?.supplier_id ?? ''); const [margin, setMargin] = useState(src?.margin_pct != null ? String(Number(src.margin_pct)) : ''); const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  useEffect(() => { boot.db.suppliers.toArray().then(ss => setSuppliers(ss.filter(x => x.active).sort((a, b) => a.name.localeCompare(b.name)))); }, [boot]);
  const [vis, setVis] = useState(src?.visible_online ?? true); const [avail, setAvail] = useState(src?.is_available ?? true); const [active, setActive] = useState(src?.is_active ?? true);
  const [days, setDays] = useState<number[]>(src?.available_days ?? []);   // empty = every day
  const [gate, setGate] = useState(false); const [err, setErr] = useState<string | null>(null);
  const cats = useMemo(() => [...index.categories.values()].sort((a, b) => a.sort_order - b.sort_order), [index]);
  const original = useMemo(() => (product ? index.barcodes(product.id) : []), [product, index]);

  // "fill from a photo": one photo of the item → suggested names, description, category and barcode. Only EMPTY fields are filled,
  // and nothing is saved until the person saves. The picture is shrunk here first (a phone photo is several MB) and is not stored.
  const [reading, setReading] = useState(false); const [photoMsg, setPhotoMsg] = useState<string | null>(null);
  const shrink = (file: File) => new Promise<Blob>((resolve, reject) => {
    const url = URL.createObjectURL(file); const im = new Image();
    im.onload = () => {
      const k = Math.min(1, 1280 / Math.max(im.width, im.height)); const c = document.createElement('canvas');
      c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
      c.getContext('2d')!.drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      c.toBlob(b => (b ? resolve(b) : reject(new Error('no_image'))), 'image/jpeg', 0.82);
    };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('no_image')); };
    im.src = url;
  });
  const readPhoto = async (file: File | undefined) => {
    if (!file || reading) return;
    setReading(true); setPhotoMsg(null);
    try {
      const form = new FormData(); form.append('shop_id', boot.shop.id); form.append('image', await shrink(file), 'item.jpg');
      form.append('categories', JSON.stringify([...new Set([...index.shared.map(c => c.id), ...index.categories.keys()])].slice(0, 150)));
      const res = await fetch('/api/pos/item-photo', { method: 'POST', body: form });
      type Card = { name_ar: string; name_en: string; description_ar: string; description_en: string; category: string; barcode: string };
      const r = (res.ok ? await res.json() : { status: 'photo', reason: 'failed' }) as { status: 'ok'; card: Card } | { status: 'photo'; reason: string };
      if (r.status !== 'ok') { setPhotoMsg(pt(r.reason === 'off' ? 'photoOff' : r.reason === 'nothing' ? 'photoNothing' : r.reason === 'cap' || r.reason === 'rate' ? 'yorgoCap' : 'photoFailed', locale)); return; }
      const c = r.card; let n = 0;
      if (!ar.trim() && c.name_ar) { setAr(c.name_ar); n++; }
      if (!en.trim() && c.name_en) { setEn(c.name_en); n++; }
      if (!dAr.trim() && c.description_ar) { setDAr(c.description_ar); n++; }
      if (!dEn.trim() && c.description_en) { setDEn(c.description_en); n++; }
      if (!cat && c.category) { setCat(c.category); n++; }
      if (c.barcode && !bcs.length) { await addBc(c.barcode); n++; }
      setPhotoMsg(n ? pt('photoFilled', locale) : pt('photoNoEmpty', locale));
    } catch { setPhotoMsg(pt('photoFailed', locale)); }
    finally { setReading(false); }
  };
  const [cam, setCam] = useState(false);      // the camera reads a barcode straight into the list below
  const addBc = async (raw: string) => {
    const b = normBarcode(raw); if (!b) return;
    const other = await barcodeOwner(boot.db, b);
    if (other && other !== product?.id) { setBcErr(`${pt('barcodeExists', locale)}: ${text(index.byId.get(other)?.name, locale)}`); return; }
    setBcErr(null); setBcs(x => (x.some(y => y.barcode === b) ? x : [...x, { barcode: b, pack_qty: 1, pack_price_usd: null }])); setBcInput('');
  };
  useScanner(code => { void addBc(code); });

  const valid = (ar.trim() || en.trim()) && Number(price) >= 0 && price !== '';
  const build = () => {
    const priceNum = Number(price) || 0;
    const fields: Partial<Product> = {
      name: { ar: ar.trim() || en.trim(), en: en.trim() || ar.trim() }, section: cat.trim() || null, price_currency: cur,
      price_usd: cur === 'usd' ? priceNum : Number(src?.price_usd ?? 0), price_lbp: cur === 'lbp' ? Math.round(priceNum) : Number(src?.price_lbp ?? 0),
      sku: sku.trim() || null, unit_kind: unit, unit: unit === 'piece' ? null : unit, decimal_qty: dec || unit === 'kg' || unit === 'g', vat, track_stock: track, min_stock: Number(min) || 0, supplier_id: supplierId || null, margin_pct: margin.trim() === '' ? null : Number(margin) || 0,
      visible_online: vis, is_available: avail, is_active: active, image_url: img, available_days: days.length && days.length < 7 ? [...days].sort() : null,
      description: { ar: dAr.trim(), en: dEn.trim() },
    };
    if (owner) fields.cost_cents = cost === '' ? null : Math.round(Number(cost) * 100);
    if (boot.role === 'setup') { delete fields.supplier_id; delete fields.margin_pct; }
    return fields;
  };
  const save = async (approvedBy?: string | null) => {
    try {
      const fields = build();
      const p = product
        ? await patchProduct(boot.db, product, { fields, barcodes_add: bcs.filter(b => { const r = index.barcodeRows.get(b.barcode); return !original.includes(b.barcode) || Number(r?.pack_qty ?? 1) !== b.pack_qty || (r?.pack_price_usd != null && r.pack_price_usd !== '' ? Number(r.pack_price_usd) : null) !== b.pack_price_usd; }), barcodes_remove: original.filter(b => !bcs.some(x => x.barcode === b)), approved_by: approvedBy })
        : await createProduct(boot.db, fields as Parameters<typeof createProduct>[1], bcs, approvedBy);
      boot.engine.poke(); onDone(p);
    } catch (e) { setErr((e as Error).message); }
  };
  const submit = () => { if (!valid) return; if (me.role === 'cashier') setGate(true); else void save(); };
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Enter' && e.ctrlKey) submit(); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <Modal open onClose={onClose} title={product ? pt('editItem', locale) : template ? pt('copyOfItem', locale) : pt('newItem', locale)} wide
        actions={<>{product && onCopy && <button type="button" className="btn" onClick={() => onCopy(product)} title={pt('copyItem', locale)}>⧉ {pt('copyItem', locale)}</button>}<button className="btn icon primary" disabled={!valid} onClick={submit} aria-label={pt('save', locale)} title={pt('save', locale)}>✓</button></>}
        footer={<>{/* Save is in the title bar (always in view) and here, at the end of the form, for whoever scrolled down */}
          {err ? <span className="bad" style={{ flex: 1, minWidth: 0 }}>{err}</span> : <span style={{ flex: 1 }} />}
          <button type="button" className="btn primary big" disabled={!valid} onClick={submit}>✓ {pt('save', locale)}</button></>}>
        <div className="item-form">
          {online && <div style={{ gridColumn: '1 / -1' }} className="row">
            <label className={`btn${reading ? ' disabled' : ''}`} style={{ cursor: reading ? 'wait' : 'pointer' }}>
              📷✨ {reading ? pt('photoReading', locale) : pt('fillFromPhoto', locale)}
              <input type="file" accept="image/*" capture="environment" hidden disabled={reading} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; void readPhoto(f); }} />
            </label>
            {photoMsg && <small className="muted" style={{ alignSelf: 'center' }}>{photoMsg}</small>}
          </div>}
          <label className="label">{pt('nameAr', locale)}<input className="input" value={ar} onChange={e => setAr(e.target.value)} autoFocus /></label>
          <label className="label">{pt('nameEn', locale)}<input className="input" dir="ltr" value={en} onChange={e => setEn(e.target.value)} /></label>
          <div className="label">{pt('category', locale)}<CategoryPicker index={index} shopId={boot.shop.id} tenantId={boot.shop.tenant_id} locale={locale} value={cat} onChange={setCat} online={typeof navigator === 'undefined' || navigator.onLine} /></div>
          <label className="label">{pt('price', locale)}
            <div className="row" style={{ gap: 8 }}>
              <div className="seg"><button type="button" className={cur === 'usd' ? 'active' : ''} onClick={() => setCur('usd')}>$</button><button type="button" className={cur === 'lbp' ? 'active' : ''} onClick={() => setCur('lbp')}>ل.ل.</button></div>
              <input className="input" dir="ltr" inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} style={{ flex: 1 }} />
            </div></label>
          {owner && <label className="label">{pt('cost', locale)} ($)<div className="row" style={{ gap: 6 }}><input className="input" dir="ltr" inputMode="decimal" value={cost} onChange={e => setCost(e.target.value)} style={{ flex: 1 }} />{marginPct > 0 && <button type="button" className="btn" title={`${pt('defaultMargin', locale)} ${marginPct}%`} onClick={priceFromMargin}>{pt('fromMargin', locale)} {marginPct}%</button>}</div>
            {Number(cost) > 0 && cur === 'usd' && Number(price) > 0 && <small className={`muted ${Number(price) < Number(cost) ? 'bad' : ''}`}>{pt('margin', locale)} {Math.round(((Number(price) - Number(cost)) / Number(price)) * 100)}%</small>}</label>}
          <label className="label">{pt('sku', locale)}<input className="input" dir="ltr" value={sku} onChange={e => setSku(e.target.value)} /></label>
          <label className="label">{pt('descAr', locale)}<input className="input" value={dAr} onChange={e => setDAr(e.target.value)} /></label>
          <label className="label">{pt('descEn', locale)}<input className="input" dir="ltr" value={dEn} onChange={e => setDEn(e.target.value)} /></label>
          <div className="label" style={{ gridColumn: '1 / -1' }}>{pt('photo', locale)}
            {online ? <ImageUpload shopId={boot.shop.id} kind="product" value={img} onChange={setImg} locale={locale} shape="square" labels={{ add: pt('addPhoto', locale), change: pt('changePhoto', locale), remove: pt('removePhoto', locale) }} />
              : <small className="muted">{pt('photoOffline', locale)}</small>}
          </div>
          <div className="label" style={{ gridColumn: '1 / -1' }}>{pt('barcodes', locale)}
            <div className="stack" style={{ gap: 4, margin: '4px 0' }}>{bcs.map((b, i) => <div key={b.barcode} className="row" style={{ gap: 6, alignItems: 'center' }}>
              <span className="chip" dir="ltr" style={{ minWidth: 120 }}>{b.barcode}</span>
              <input className="input" dir="ltr" inputMode="decimal" title={pt('packQty', locale)} placeholder={pt('packQty', locale)} value={b.pack_qty === 1 ? '' : b.pack_qty} onChange={e => setBcs(x => x.map((y, j) => (j === i ? { ...y, pack_qty: Number(e.target.value) || 1 } : y)))} style={{ width: 90, minHeight: 36 }} />
              {b.pack_qty !== 1 && <input className="input" dir="ltr" inputMode="decimal" title={pt('packPrice', locale)} placeholder={pt('packPrice', locale)} value={b.pack_price_usd ?? ''} onChange={e => setBcs(x => x.map((y, j) => (j === i ? { ...y, pack_price_usd: e.target.value === '' ? null : Number(e.target.value) } : y)))} style={{ width: 110, minHeight: 36 }} />}
              {b.pack_qty !== 1 && <small className="muted">{pt('pack', locale)} ×{b.pack_qty}</small>}
              <button type="button" className="btn icon" style={{ minHeight: 0, padding: '0 6px' }} onClick={() => setBcs(x => x.filter((_, j) => j !== i))}>✕</button></div>)}</div>
            <div className="row" style={{ gap: 6 }}><input className="input" dir="ltr" placeholder={pt('addBarcode', locale)} value={bcInput} onChange={e => setBcInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void addBc(bcInput); } }} /><button type="button" className="btn" onClick={() => addBc(bcInput)}>＋</button><button type="button" className="btn" onClick={() => setCam(true)} title={pt('cameraScan', locale)} aria-label={pt('cameraScan', locale)}>📷</button></div>
            {cam && <CameraScanner open locale={locale} onScan={code => { setCam(false); void addBc(code); }} onClose={() => setCam(false)} />}
            {bcErr && <div className="bad" style={{ fontSize: 13 }}>{bcErr}</div>}
          </div>
          <label className="label">{pt('unit', locale)}<select className="input" value={unit} onChange={e => setUnit(e.target.value)}>{UNITS.map(u => <option key={u} value={u}>{pt(u, locale)}</option>)}</select></label>
          <label className="label">{pt('minStock', locale)}<input className="input" dir="ltr" inputMode="decimal" value={min} onChange={e => setMin(e.target.value)} disabled={!track} /></label>
          {boot.role !== 'setup' && <label className="label">{pt('defaultSupplier', locale)}<select className="input" value={supplierId} onChange={e => setSupplierId(e.target.value)}><option value="">—</option>{suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
          {boot.role !== 'setup' && <label className="label">{pt('itemMargin', locale)}<input className="input" dir="ltr" inputMode="decimal" value={margin} onChange={e => setMargin(e.target.value)} placeholder={`${pt('shopDefault', locale)} ${Number(boot.shop.default_margin_pct) || 0}%`} /></label>}
          {product?.next_expiry && <div className="label">{pt('nextExpiry', locale)}<div className={new Date(product.next_expiry) < new Date() ? 'bad' : ''} dir="ltr">{product.next_expiry}</div></div>}
          <div className="checks" style={{ gridColumn: '1 / -1' }}>
            <label><input type="checkbox" checked={track} onChange={e => setTrack(e.target.checked)} /> {pt('trackStock', locale)}</label>
            <label><input type="checkbox" checked={dec || unit === 'kg' || unit === 'g'} disabled={unit === 'kg' || unit === 'g'} onChange={e => setDec(e.target.checked)} /> {pt('decimalQty', locale)}</label>
            <label><input type="checkbox" checked={vat} onChange={e => setVat(e.target.checked)} /> {pt('vat', locale)}</label>
            <label><input type="checkbox" checked={vis} onChange={e => setVis(e.target.checked)} /> {pt('visibleOnline', locale)}</label>
            <label><input type="checkbox" checked={avail} onChange={e => setAvail(e.target.checked)} /> {pt('sellable', locale)}</label>
            <label><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} /> {pt('active', locale)}</label>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <div className="label">{pt('daysSold', locale)}</div>
            <div className="seg wrap">
              <button type="button" className={days.length === 0 || days.length === 7 ? 'active' : ''} onClick={() => setDays([])}>{pt('everyDay', locale)}</button>
              {DAY_ORDER.map(d => <button type="button" key={d} className={days.length > 0 && days.length < 7 && days.includes(d) ? 'active' : ''} onClick={() => setDays(x => x.includes(d) ? x.filter(y => y !== d) : [...x, d])}>{dayName(d, locale)}</button>)}
            </div>
            {days.length > 0 && days.length < 7 && <small className="muted">{pt('daysSoldHint', locale)}</small>}
          </div>
        </div>
      </Modal>
      {gate && <OwnerPin open locale={locale} staff={staff} me={me} reason={pt('editItem', locale)} onDone={id => { setGate(false); if (id) void save(id); }} />}
    </>
  );
}
