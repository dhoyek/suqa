'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase-browser';
import type { Tenant } from '@suqa/shared';

type Labels = Record<'settings' | 'brandName' | 'fxRate' | 'displayCurrencyLabel' | 'defaultCommission' | 'supportPhone' | 'whatsapp' | 'primaryColor' | 'accentColor' | 'save' | 'saved' | 'notAllowed', string>;

export default function SettingsForm({ tenant, canEdit, labels }: { tenant: Tenant; canEdit: boolean; labels: Labels }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const router = useRouter();
  const [f, setF] = useState({
    brand_name: tenant.brand_name, fx: String(tenant.fx_lbp_rate), display: tenant.display_currency, commission: String(Number(tenant.commission_rate) * 100),
    support_phone: tenant.settings.support_phone ?? '', whatsapp_number: tenant.settings.whatsapp_number ?? '',
    primary: tenant.branding.colors?.primary ?? '#0E7490', accent: tenant.branding.colors?.accent ?? '#F59E0B',
  });
  const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true); setMsg(null);
    const { error } = await sb.from('tenants').update({
      brand_name: f.brand_name.trim(), fx_lbp_rate: Number(f.fx), display_currency: f.display, commission_rate: (Number(f.commission) || 0) / 100,
      settings: { ...tenant.settings, support_phone: f.support_phone.trim() || null, whatsapp_number: f.whatsapp_number.trim() || null },
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
