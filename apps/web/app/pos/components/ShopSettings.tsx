'use client';
import { useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { num, setMeta, META, type Shop } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';

/** Owner: the POS switches of this shop, saved through pos_shop_settings and applied on this device at once. */
export default function ShopSettings({ boot, sb, locale, online }: { boot: Booted; sb: SupabaseClient; locale: L; online: boolean }) {
  const s = boot.shop;
  const [fee, setFee] = useState(String(num(s.default_delivery_fee_usd) || ''));
  const [disc, setDisc] = useState(String(num(s.max_discount_pct)));
  const [step, setStep] = useState(String(s.lbp_rounding_step ?? 5000));
  const [neg, setNeg] = useState(!!s.allow_negative_stock); const [hide, setHide] = useState(!!s.hide_online_when_zero);
  const [deduct, setDeduct] = useState<'ready' | 'delivered'>(s.deduct_stock_at ?? 'ready');
  const [days, setDays] = useState(String(s.offline_days ?? 30)); const [footer, setFooter] = useState(s.receipt_footer ?? '');
  const [marginPct, setMarginPct] = useState(String(num(s.default_margin_pct) || ''));
  const [scPrefix, setScPrefix] = useState(s.scale_prefix ?? ''); const [scLen, setScLen] = useState(String(s.scale_code_len ?? 5)); const [scKind, setScKind] = useState<'weight' | 'price_lbp' | 'price_usd'>(s.scale_value_kind ?? 'weight'); const [scDiv, setScDiv] = useState(String(s.scale_value_divisor ?? 1000));
  const STAGES = ['accepted', 'ready', 'out_for_delivery', 'delivered', 'rejected'] as const;
  const DEF_STAGES: string[] = ['accepted', 'ready', 'out_for_delivery', 'rejected'];
  const [stages, setStages] = useState<string[]>(s.notify_stages ?? DEF_STAGES);
  type SF = { prefix: string; code_len?: number; value_kind?: 'weight' | 'price_lbp' | 'price_usd'; value_divisor?: number };
  const [extra, setExtra] = useState<SF[]>((s.scale_formats ?? []).map(f => ({ ...f })));
  const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const patch = { default_delivery_fee_usd: Number(fee) || 0, max_discount_pct: Number(disc) || 0, lbp_rounding_step: Number(step) || 5000, allow_negative_stock: neg, hide_online_when_zero: hide, deduct_stock_at: deduct, offline_days: Number(days) || 30, receipt_footer: footer.trim() || null,
        default_margin_pct: Number(marginPct) || 0, scale_prefix: scPrefix.replace(/\D/g, '') || '', scale_code_len: Number(scLen) || 5, scale_value_kind: scKind, scale_value_divisor: Number(scDiv) || 1000, notify_stages: stages, scale_formats: extra.filter(f => f.prefix.replace(/\D/g, '')).map(f => ({ prefix: f.prefix.replace(/\D/g, ''), code_len: Number(f.code_len) || 5, value_kind: f.value_kind ?? 'weight', value_divisor: Number(f.value_divisor) || 1000 })) };
      const { data, error } = await sb.rpc('pos_shop_settings', { p_shop: s.id, p_patch: patch });
      if (error) { setMsg(error.message); return; }
      Object.assign(boot.shop, data as Shop); await setMeta(boot.db, META.shop, boot.shop); setMsg(pt('saved', locale));
    } finally { setBusy(false); }
  };
  const F = ({ label, children }: { label: string; children: React.ReactNode }) => <div style={{ minWidth: 200, flex: 1 }}><label className="label">{label}</label>{children}</div>;
  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>🏪 {pt('shopSettings', locale)}</h3>
      {!online && <p className="muted" style={{ fontSize: 12 }}>{pt('needOnline', locale)}</p>}
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <F label={pt('defaultDeliveryFee', locale)}><input className="input" dir="ltr" inputMode="decimal" value={fee} onChange={e => setFee(e.target.value)} /></F>
        <F label={pt('maxDiscount', locale)}><input className="input" dir="ltr" inputMode="decimal" value={disc} onChange={e => setDisc(e.target.value)} /></F>
        <F label={pt('lbpStep', locale)}><select className="input" value={step} onChange={e => setStep(e.target.value)}>{[1000, 5000, 10000, 25000, 50000].map(v => <option key={v} value={v}>{v.toLocaleString('en')}</option>)}</select></F>
        <F label={pt('deductAt', locale)}><div className="seg"><button className={deduct === 'ready' ? 'active' : ''} onClick={() => setDeduct('ready')}>{pt('st_ready', locale)}</button><button className={deduct === 'delivered' ? 'active' : ''} onClick={() => setDeduct('delivered')}>{pt('st_delivered', locale)}</button></div></F>
        <F label={pt('offlineDaysLabel', locale)}><input className="input" dir="ltr" inputMode="numeric" value={days} onChange={e => setDays(e.target.value)} /></F>
      </div>
      <div className="row" style={{ gap: 16, flexWrap: 'wrap', marginTop: 8 }}>
        <label className="row" style={{ gap: 8, alignItems: 'center' }}><input type="checkbox" checked={neg} onChange={e => setNeg(e.target.checked)} /> {pt('allowNegative', locale)}</label>
        <label className="row" style={{ gap: 8, alignItems: 'center' }}><input type="checkbox" checked={hide} onChange={e => setHide(e.target.checked)} /> {pt('hideWhenZero', locale)}</label>
      </div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
        <F label={pt('defaultMargin', locale)}><input className="input" dir="ltr" inputMode="decimal" value={marginPct} onChange={e => setMarginPct(e.target.value)} /></F>
      </div>
      <h4 style={{ margin: '14px 0 4px' }}>⚖ {pt('scaleBarcodes', locale)}</h4>
      <p className="muted" style={{ fontSize: 12, margin: '0 0 6px' }}>{pt('scaleHint', locale)}</p>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <F label={pt('scalePrefix', locale)}><input className="input" dir="ltr" inputMode="numeric" value={scPrefix} onChange={e => setScPrefix(e.target.value)} placeholder="2" /></F>
        <F label={pt('scaleCodeLen', locale)}><input className="input" dir="ltr" inputMode="numeric" value={scLen} onChange={e => setScLen(e.target.value)} /></F>
        <F label={pt('scaleValue', locale)}><select className="input" value={scKind} onChange={e => setScKind(e.target.value as typeof scKind)}><option value="weight">{pt('scaleWeight', locale)}</option><option value="price_lbp">{pt('scalePriceLbp', locale)}</option><option value="price_usd">{pt('scalePriceUsd', locale)}</option></select></F>
        <F label={pt('scaleDivisor', locale)}><input className="input" dir="ltr" inputMode="numeric" value={scDiv} onChange={e => setScDiv(e.target.value)} /></F>
      </div>
      {extra.map((f, i) => <div key={i} className="grid2" style={{ marginTop: 6 }}>
        <F label={`${pt('scalePrefix', locale)} ${i + 2}`}><input className="input" dir="ltr" inputMode="numeric" value={f.prefix} onChange={e => setExtra(x => x.map((y, j) => j === i ? { ...y, prefix: e.target.value } : y))} /></F>
        <F label={pt('scaleCodeLen', locale)}><input className="input" dir="ltr" inputMode="numeric" value={f.code_len ?? ''} onChange={e => setExtra(x => x.map((y, j) => j === i ? { ...y, code_len: Number(e.target.value) || undefined } : y))} /></F>
        <F label={pt('scaleValue', locale)}><select className="input" value={f.value_kind ?? 'weight'} onChange={e => setExtra(x => x.map((y, j) => j === i ? { ...y, value_kind: e.target.value as SF['value_kind'] } : y))}><option value="weight">{pt('scaleWeight', locale)}</option><option value="price_lbp">{pt('scalePriceLbp', locale)}</option><option value="price_usd">{pt('scalePriceUsd', locale)}</option></select></F>
        <F label={pt('scaleDivisor', locale)}><div className="row" style={{ gap: 6 }}><input className="input" dir="ltr" inputMode="numeric" value={f.value_divisor ?? ''} onChange={e => setExtra(x => x.map((y, j) => j === i ? { ...y, value_divisor: Number(e.target.value) || undefined } : y))} /><button className="btn ghost" onClick={() => setExtra(x => x.filter((_, j) => j !== i))}>✕</button></div></F>
      </div>)}
      <button className="btn" style={{ marginTop: 6 }} onClick={() => setExtra(x => [...x, { prefix: '', code_len: 4, value_kind: 'price_lbp', value_divisor: 1 }])}>＋ {pt('addScaleFormat', locale)}</button>
      <h4 style={{ margin: '14px 0 4px' }}>💬 {pt('notifyStages', locale)}</h4>
      <p className="muted" style={{ fontSize: 12, margin: '0 0 6px' }}>{pt('notifyHint', locale)}</p>
      <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
        {STAGES.map(st => <label key={st} className="row" style={{ gap: 8, alignItems: 'center' }}><input type="checkbox" checked={stages.includes(st)} onChange={e => setStages(e.target.checked ? [...stages, st] : stages.filter(x => x !== st))} /> {pt(`st_${st}`, locale)}</label>)}
      </div>
      <label className="label" style={{ marginTop: 8 }}>{pt('receiptFooter', locale)}</label>
      <input className="input" value={footer} onChange={e => setFooter(e.target.value)} />
      <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 10 }}><button className="btn primary" disabled={busy || !online} onClick={save}>{pt('save', locale)}</button>{msg && <span className="muted">{msg}</span>}</div>
    </section>
  );
}
