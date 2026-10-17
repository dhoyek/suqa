'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase-browser';
import type { Tenant } from '@suqa/shared';

type Labels = Record<'settings' | 'brandName' | 'fxRate' | 'displayCurrencyLabel' | 'defaultCommission' | 'supportPhone' | 'whatsapp' | 'primaryColor' | 'accentColor' | 'save' | 'saved' | 'notAllowed'
  | 'multiShopCart' | 'deliveryMode' | 'perShopDelivery' | 'courierDelivery' | 'courierFee' | 'couriersEnabled', string>;

export default function SettingsForm({ tenant, canEdit, labels }: { tenant: Tenant; canEdit: boolean; labels: Labels }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const router = useRouter();
  const [f, setF] = useState({
    brand_name: tenant.brand_name, fx: String(tenant.fx_lbp_rate), display: tenant.display_currency, commission: String(Number(tenant.commission_rate) * 100),
    support_phone: tenant.settings.support_phone ?? '', whatsapp_number: tenant.settings.whatsapp_number ?? '',
    primary: tenant.branding.colors?.primary ?? '#0E7490', accent: tenant.branding.colors?.accent ?? '#F59E0B',
    multi_shop_cart: !!tenant.settings.multi_shop_cart, delivery_mode: tenant.settings.delivery_mode ?? 'per_shop',
    courier_fee: tenant.settings.courier_fee_usd != null ? String(tenant.settings.courier_fee_usd) : '', courier_enabled: !!tenant.settings.courier_enabled,
  });
  const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true); setMsg(null);
    const { error } = await sb.from('tenants').update({
      brand_name: f.brand_name.trim(), fx_lbp_rate: Number(f.fx), display_currency: f.display, commission_rate: (Number(f.commission) || 0) / 100,
      settings: { ...tenant.settings, support_phone: f.support_phone.trim() || null, whatsapp_number: f.whatsapp_number.trim() || null,
        multi_shop_cart: f.multi_shop_cart, delivery_mode: f.delivery_mode, courier_fee_usd: f.courier_fee.trim() === '' ? null : Number(f.courier_fee), courier_enabled: f.courier_enabled },
      branding: { ...tenant.branding, colors: { ...(tenant.branding.colors ?? {}), primary: f.primary, accent: f.accent } },
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
