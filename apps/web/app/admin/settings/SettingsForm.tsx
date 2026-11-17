'use client';
import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase-browser';
import type { Tenant } from '@suqa/shared';
import { sendTestWhatsApp } from './actions';
import { uploadBrandLogo } from '@/lib/upload';

type Labels = Record<'settings' | 'brandName' | 'fxRate' | 'displayCurrencyLabel' | 'defaultCommission' | 'supportPhone' | 'whatsapp' | 'primaryColor' | 'accentColor' | 'save' | 'saved' | 'notAllowed'
  | 'multiShopCart' | 'deliveryMode' | 'perShopDelivery' | 'courierDelivery' | 'courierFee' | 'couriersEnabled' | 'legalOperator' | 'legalEmail' | 'legalSection' | 'waTestSection' | 'waTestPhone' | 'waTestSend' | 'waTestSent' | 'maxOpenOrders' | 'notifyStages', string>;

export default function SettingsForm({ tenant, canEdit, labels, waConfigured, statusLabels }: { tenant: Tenant; canEdit: boolean; labels: Labels; waConfigured: boolean; statusLabels: Record<string, string> }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const router = useRouter();
  const [f, setF] = useState({
    brand_name: tenant.brand_name, fx: String(tenant.fx_lbp_rate), display: tenant.display_currency, commission: String(Number(tenant.commission_rate) * 100),
    support_phone: tenant.settings.support_phone ?? '', whatsapp_number: tenant.settings.whatsapp_number ?? '',
    logo_url: tenant.branding.logo_url ?? null as string | null,
    primary: tenant.branding.colors?.primary ?? '#0E7490', accent: tenant.branding.colors?.accent ?? '#F59E0B',
    multi_shop_cart: !!tenant.settings.multi_shop_cart, delivery_mode: tenant.settings.delivery_mode ?? 'per_shop',
    courier_fee: tenant.settings.courier_fee_usd != null ? String(tenant.settings.courier_fee_usd) : '', courier_enabled: !!tenant.settings.courier_enabled,
    legal_operator: tenant.settings.legal_operator ?? '', legal_email: tenant.settings.legal_email ?? '',
    max_open_orders: tenant.settings.max_open_orders != null ? String(tenant.settings.max_open_orders) : '5',
    notify_stages: tenant.settings.notify_stages ?? ['accepted', 'ready', 'out_for_delivery', 'delivered', 'rejected'],
  });
  const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [testPhone, setTestPhone] = useState(tenant.settings.whatsapp_number ?? ''); const [testMsg, setTestMsg] = useState<string | null>(null); const [testBusy, setTestBusy] = useState(false);
  async function sendTest() {
    setTestBusy(true); setTestMsg(null);
    const r = await sendTestWhatsApp(testPhone);
    setTestBusy(false); setTestMsg(r.ok ? labels.waTestSent : r.error);
  }

  const logoInput = useRef<HTMLInputElement>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const ar = typeof document !== 'undefined' ? document.documentElement.lang === 'ar' : true;
  async function pickLogo(file: File | undefined) {
    if (!file) return;
    setLogoBusy(true); setMsg(null);
    try { const url = await uploadBrandLogo(sb, tenant.id, file); setF(prev => ({ ...prev, logo_url: url })); }
    catch (e) { setMsg((e as Error).message); }
    setLogoBusy(false); if (logoInput.current) logoInput.current.value = '';
  }

  async function save() {
    setBusy(true); setMsg(null);
    const { error } = await sb.from('tenants').update({
      brand_name: f.brand_name.trim(), fx_lbp_rate: Number(f.fx), display_currency: f.display, commission_rate: (Number(f.commission) || 0) / 100,
      settings: { ...tenant.settings, support_phone: f.support_phone.trim() || null, whatsapp_number: f.whatsapp_number.trim() || null,
        multi_shop_cart: f.multi_shop_cart, delivery_mode: f.delivery_mode, courier_fee_usd: f.courier_fee.trim() === '' ? null : Number(f.courier_fee), courier_enabled: f.courier_enabled,
        legal_operator: f.legal_operator.trim() || null, legal_email: f.legal_email.trim() || null,
        max_open_orders: f.max_open_orders.trim() === '' ? null : Math.max(0, Math.floor(Number(f.max_open_orders) || 0)), notify_stages: f.notify_stages },
      branding: { ...tenant.branding, logo_url: f.logo_url, colors: { ...(tenant.branding.colors ?? {}), primary: f.primary, accent: f.accent } },
    }).eq('id', tenant.id);
    setBusy(false);
    if (error) { setMsg(error.message); return; }
    setMsg(labels.saved); router.refresh();
  }
  const dis = !canEdit;
  return (
    <div className="stack">
      <h1 style={{ margin: 0, fontSize: 20 }}>{labels.settings}</h1>
      {!canEdit && <div className="card muted">{labels.notAllowed}</div>}
      <section className="card stack">
        <div><label className="label">{labels.brandName}</label><input className="input" disabled={dis} value={f.brand_name} onChange={e => setF({ ...f, brand_name: e.target.value })} /></div>
        <div className="row" style={{ alignItems: 'stretch' }}>
          <div style={{ flex: 1 }}><label className="label">{labels.fxRate}</label><input className="input" dir="ltr" inputMode="numeric" disabled={dis} value={f.fx} onChange={e => setF({ ...f, fx: e.target.value })} /></div>
          <div style={{ flex: 1 }}><label className="label">{labels.displayCurrencyLabel}</label>
            <select className="input" disabled={dis} value={f.display} onChange={e => setF({ ...f, display: e.target.value as any })}><option value="both">USD + LBP</option><option value="usd">USD</option><option value="lbp">LBP</option></select></div>
          <div style={{ flex: 1 }}><label className="label">{labels.defaultCommission}</label><input className="input" dir="ltr" inputMode="decimal" disabled={dis} value={f.commission} onChange={e => setF({ ...f, commission: e.target.value })} /></div>
        </div>
        <div className="row" style={{ alignItems: 'stretch' }}>
          <div style={{ flex: 1 }}><label className="label">{labels.supportPhone}</label><input className="input" dir="ltr" disabled={dis} value={f.support_phone} onChange={e => setF({ ...f, support_phone: e.target.value })} /></div>
          <div style={{ flex: 1 }}><label className="label">{labels.whatsapp}</label><input className="input" dir="ltr" disabled={dis} value={f.whatsapp_number} onChange={e => setF({ ...f, whatsapp_number: e.target.value })} /></div>
        </div>
        <div className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          <label className="row" style={{ gap: 10, cursor: 'pointer' }}><input type="checkbox" className="check" disabled={dis} checked={f.multi_shop_cart} onChange={e => setF({ ...f, multi_shop_cart: e.target.checked })} /> {labels.multiShopCart}</label>
          <div><label className="label">{labels.maxOpenOrders}</label><input className="input" dir="ltr" inputMode="numeric" disabled={dis} value={f.max_open_orders} onChange={e => setF({ ...f, max_open_orders: e.target.value })} style={{ maxWidth: 120 }} /></div>
          <div className="stack" style={{ gap: 4 }}>
            <label className="label">{labels.notifyStages}</label>
            <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
              {(['accepted', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'rejected'] as const).map(st => (
                <label key={st} className="row" style={{ gap: 6, cursor: 'pointer', fontSize: 14 }}>
                  <input type="checkbox" className="check" disabled={dis} checked={f.notify_stages.includes(st)}
                    onChange={e => setF({ ...f, notify_stages: e.target.checked ? [...f.notify_stages, st] : f.notify_stages.filter(x => x !== st) })} /> {statusLabels[st]}
                </label>
              ))}
            </div>
          </div>
          <label className="row" style={{ gap: 10, cursor: 'pointer' }}><input type="checkbox" className="check" disabled={dis} checked={f.courier_enabled} onChange={e => setF({ ...f, courier_enabled: e.target.checked })} /> 🛵 {labels.couriersEnabled}</label>
          {f.multi_shop_cart && (
            <div className="row" style={{ alignItems: 'stretch' }}>
              <div style={{ flex: 1 }}><label className="label">{labels.deliveryMode}</label>
                <select className="input" disabled={dis} value={f.delivery_mode} onChange={e => setF({ ...f, delivery_mode: e.target.value as any })}>
                  <option value="per_shop">{labels.perShopDelivery}</option><option value="courier">{labels.courierDelivery}</option></select></div>
              {f.delivery_mode === 'courier' && <div style={{ flex: 1 }}><label className="label">{labels.courierFee}</label><input className="input" dir="ltr" inputMode="decimal" disabled={dis} value={f.courier_fee} onChange={e => setF({ ...f, courier_fee: e.target.value })} /></div>}
            </div>
          )}
        </div>
        <div className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          <strong style={{ fontSize: 14 }}>{labels.legalSection}</strong>
          <div className="row" style={{ alignItems: 'stretch' }}>
            <div style={{ flex: 1 }}><label className="label">{labels.legalOperator}</label><input className="input" disabled={dis} value={f.legal_operator} onChange={e => setF({ ...f, legal_operator: e.target.value })} placeholder="Purple Digits (Lebanon)" /></div>
            <div style={{ flex: 1 }}><label className="label">{labels.legalEmail}</label><input className="input" dir="ltr" type="email" disabled={dis} value={f.legal_email} onChange={e => setF({ ...f, legal_email: e.target.value })} placeholder="support@purpledigits.com" /></div>
          </div>
        </div>
        {canEdit && (
          <div className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
            <strong style={{ fontSize: 14 }}>{labels.waTestSection} {waConfigured ? '🟢' : '⚪'}</strong>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}><label className="label">{labels.waTestPhone}</label><input className="input" dir="ltr" inputMode="tel" value={testPhone} onChange={e => setTestPhone(e.target.value)} placeholder="+961 70 000 000" /></div>
              <button className="btn" disabled={testBusy || !waConfigured} onClick={sendTest}>{labels.waTestSend}</button>
            </div>
            {testMsg && <div className={testMsg === labels.waTestSent ? 'muted' : 'error'} dir="ltr">{testMsg}</div>}
          </div>
        )}
        <div className="row" style={{ alignItems: 'center', gap: 12 }}>
          {f.logo_url
            ? <img src={f.logo_url} alt="" style={{ height: 48, maxWidth: 160, objectFit: 'contain', borderRadius: 8, background: '#fff', border: '1px solid var(--line)', padding: 4 }} />
            : <span className="muted" style={{ fontSize: 13 }}>{ar ? 'لا يوجد شعار' : 'No logo yet'}</span>}
          <span className="stack" style={{ gap: 4 }}>
            <strong style={{ fontSize: 14 }}>{ar ? 'شعار الموقع' : 'Site logo'}</strong>
            <span className="muted" style={{ fontSize: 12 }}>{ar ? 'يظهر بجانب الاسم في أعلى الموقع. يُفضّل PNG بخلفية شفافة، مربع أو أفقي.' : 'Shown next to the name at the top of the site. A PNG with a transparent background works best, square or wide.'}</span>
            {canEdit && <span className="row">
              <input ref={logoInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={e => void pickLogo(e.target.files?.[0])} />
              <button type="button" className="btn" disabled={logoBusy} onClick={() => logoInput.current?.click()}>{logoBusy ? '…' : f.logo_url ? (ar ? 'تغيير' : 'Change') : (ar ? '+ شعار' : '+ Logo')}</button>
              {f.logo_url && <button type="button" className="btn ghost muted" disabled={logoBusy} onClick={() => setF({ ...f, logo_url: null })}>{ar ? 'إزالة' : 'Remove'}</button>}
            </span>}
          </span>
        </div>
        <div className="row">
          <label className="row">{labels.primaryColor} <input type="color" disabled={dis} value={f.primary} onChange={e => setF({ ...f, primary: e.target.value })} /></label>
          <label className="row">{labels.accentColor} <input type="color" disabled={dis} value={f.accent} onChange={e => setF({ ...f, accent: e.target.value })} /></label>
        </div>
        {msg && <div className={msg === labels.saved ? 'muted' : 'error'}>{msg}</div>}
        {canEdit && <button className="btn primary" disabled={busy} onClick={save}>{labels.save}</button>}
      </section>
    </div>
  );
}
