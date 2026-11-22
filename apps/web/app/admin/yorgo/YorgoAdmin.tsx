'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { useNotify } from '@/components/ConfirmProvider';

type Settings = { enabled: boolean; shopper_enabled: boolean; whatsapp_enabled: boolean; cap_global_usd: number; cap_shop_usd: number; cap_user_usd: number; cap_wa_phone_usd: number; rate_per_min: number };
type Usage = { day: string; shop_id: string | null; user_id: string | null; messages: number; model_calls: number; cost_usd: number };
const DEFAULTS: Settings = { enabled: false, shopper_enabled: false, whatsapp_enabled: false, cap_global_usd: 20, cap_shop_usd: 5, cap_user_usd: 0.5, cap_wa_phone_usd: 2, rate_per_min: 6 };
const usd = (n: number) => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);

function Bar({ value, cap }: { value: number; cap: number }) {
  const pct = cap > 0 ? Math.min(100, (value / cap) * 100) : 0;
  return <div className="yorgo-bar" title={`${pct.toFixed(0)}%`}><div style={{ width: `${pct}%`, background: pct >= 90 ? 'var(--bad)' : pct >= 60 ? 'var(--warn)' : 'var(--ok)' }} /></div>;
}

export default function YorgoAdmin({ tenantId, locale, today, hasKey, settings, shops, yshops, usage, misses }: {
  tenantId: string; locale: 'ar' | 'en'; today: string; hasKey: boolean; settings: Settings | null;
  shops: { id: string; name: string }[]; yshops: { shop_id: string; enabled: boolean; cap_usd: number | null }[]; usage: Usage[];
  misses: { id: string; shop_id: string | null; phrase: string; times: number }[];
}) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const notify = useNotify();
  const T = (a: string, e: string) => (locale === 'ar' ? a : e);
  const [s, setS] = useState<Settings>(settings ?? DEFAULTS);
  const [saved, setSaved] = useState<Settings>(settings ?? DEFAULTS);
  const [on, setOn] = useState<Record<string, boolean>>(Object.fromEntries(yshops.map(y => [y.shop_id, y.enabled])));
  const [busy, setBusy] = useState(false);
  const [missList, setMissList] = useState(misses);
  const dirty = JSON.stringify(s) !== JSON.stringify(saved) || !settings;

  const total = usage.reduce((a, u) => a + u.cost_usd, 0);
  const messages = usage.reduce((a, u) => a + u.messages, 0);
  const calls = usage.reduce((a, u) => a + u.model_calls, 0);
  const byShop = new Map<string, { cost: number; messages: number }>();
  const byUser = new Map<string, number>();                                   // shoppers only (shop_id null)
  const byDay = new Map<string, { cost: number; messages: number }>();
  for (const u of usage) {
    if (u.shop_id) { const x = byShop.get(u.shop_id) ?? { cost: 0, messages: 0 }; x.cost += u.cost_usd; x.messages += u.messages; byShop.set(u.shop_id, x); }
    else if (u.user_id) byUser.set(u.user_id, (byUser.get(u.user_id) ?? 0) + u.cost_usd);
    const d = byDay.get(u.day) ?? { cost: 0, messages: 0 }; d.cost += u.cost_usd; d.messages += u.messages; byDay.set(u.day, d);
  }
  const shopperCost = [...byUser.values()].reduce((a, b) => a + b, 0);
  const topShopper = Math.max(0, ...byUser.values());
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 14);
  const maxDay = Math.max(0.000001, ...days.map(d => d[1].cost));
  const dayOfMonth = Number(today.slice(8, 10)), daysInMonth = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0).getDate();
  const forecast = dayOfMonth ? (total / dayOfMonth) * daysInMonth : 0;
  const shopName = (id: string | null) => (id ? shops.find(x => x.id === id)?.name ?? '—' : T('كل السوق', 'Whole market'));

  async function save() {
    const clean = { ...s, cap_global_usd: Math.max(0, s.cap_global_usd || 0), cap_shop_usd: Math.max(0, s.cap_shop_usd || 0), cap_user_usd: Math.max(0, s.cap_user_usd || 0), cap_wa_phone_usd: Math.max(0, s.cap_wa_phone_usd || 0), rate_per_min: Math.min(60, Math.max(1, Math.round(s.rate_per_min || 6))) };
    setBusy(true);
    const { error } = await sb.from('yorgo_settings').upsert({ tenant_id: tenantId, ...clean, updated_at: new Date().toISOString() }, { onConflict: 'tenant_id' });
    setBusy(false);
    if (error) { notify(error.message); return; }
    setS(clean); setSaved(clean); notify(T('تم الحفظ.', 'Saved.'));
  }
  async function toggleShop(id: string) {
    const v = !on[id]; setOn(o => ({ ...o, [id]: v }));
    const { error } = await sb.from('yorgo_shops').upsert({ shop_id: id, tenant_id: tenantId, enabled: v, updated_at: new Date().toISOString() }, { onConflict: 'shop_id' });
    if (error) { setOn(o => ({ ...o, [id]: !v })); notify(error.message); }
  }
  async function dismiss(id: string) { setMissList(l => l.filter(m => m.id !== id)); await sb.rpc('yorgo_miss_dismiss', { p_id: id }); }
  const num = (k: keyof Settings, step: string) => <input className="input" type="number" min="0" step={step} inputMode="decimal" style={{ maxWidth: 120 }} value={Number.isFinite(s[k] as number) ? (s[k] as number) : ''} onChange={e => setS(x => ({ ...x, [k]: e.target.value === '' ? 0 : Number(e.target.value) }))} />;

  return (
    <div className="stack">
      <div className="row spread" style={{ alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>✨ Yorgo <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>· {T('المساعد الذكي', 'AI assistant')}</span></h2>
        <Link href="/admin/yorgo/demand" className="btn">📊 {T('الطلب', 'Demand')}</Link>
      </div>
      {!hasKey && <div className="card paused">{T('لا يوجد مفتاح API على هذا الموقع، فيورغو متوقف مهما كانت الإعدادات.', 'No API key is configured on this site, so Yorgo is off whatever the switches say.')}</div>}

      <div className="grid">
        <div className="card stack"><span className="muted">{T('صُرف هذا الشهر', 'Spent this month')}</span><strong style={{ fontSize: 26 }}>{usd(total)} <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>/ {usd(saved.cap_global_usd)}</span></strong><Bar value={total} cap={saved.cap_global_usd} />
          <span className="muted" style={{ fontSize: 13 }}>{T('المتوقع حتى آخر الشهر', 'Forecast for the month')}: {usd(forecast)}</span></div>
        <div className="card stack"><span className="muted">{T('الرسائل', 'Messages')}</span><strong style={{ fontSize: 26 }}>{messages}</strong>
          <span className="muted" style={{ fontSize: 13 }}>{T('كلفة الرسالة', 'Cost per message')}: {messages ? `$${(total / messages).toFixed(4)}` : '—'} · {calls} {T('طلب للنموذج', 'model calls')}</span></div>
        <div className="card stack"><span className="muted">{T('المتسوّقون', 'Shoppers')}</span><strong style={{ fontSize: 26 }}>{byUser.size}</strong>
          <span className="muted" style={{ fontSize: 13 }}>{usd(shopperCost)} · {T('أعلى متسوّق', 'top shopper')}: {usd(topShopper)} / {usd(saved.cap_user_usd)}</span></div>
      </div>

      <div className="card stack">
        <strong>{T('التشغيل والحدود', 'Switches and limits')}</strong>
        <label className="row"><input type="checkbox" checked={s.enabled} onChange={e => setS(x => ({ ...x, enabled: e.target.checked }))} /> {T('يورغو مفعّل (المفتاح الرئيسي)', 'Yorgo is on (master switch)')}</label>
        <label className="row"><input type="checkbox" checked={s.shopper_enabled} onChange={e => setS(x => ({ ...x, shopper_enabled: e.target.checked }))} /> {T('يورغو للمتسوّقين على الموقع', 'Yorgo for shoppers on the storefront')}</label>
        <label className="row"><input type="checkbox" checked={s.whatsapp_enabled} onChange={e => setS(x => ({ ...x, whatsapp_enabled: e.target.checked }))} /> {T('يورغو على واتساب السوق: يردّ على الرسائل المكتوبة بسلة مقترحة ورابط (يحتاج المفتاحين أعلاه)', 'Yorgo on the market\'s WhatsApp: answers text messages with a basket draft and a link (needs the two switches above)')}</label>
        <div className="row"><span style={{ minWidth: 220 }}>{T('الحد الشهري الإجمالي ($)', 'Monthly cap, everything ($)')}</span>{num('cap_global_usd', '1')}</div>
        <div className="row"><span style={{ minWidth: 220 }}>{T('الحد الشهري لكل محل ($)', 'Monthly cap per shop ($)')}</span>{num('cap_shop_usd', '1')}</div>
        <div className="row"><span style={{ minWidth: 220 }}>{T('الحد الشهري لكل متسوّق ($)', 'Monthly cap per shopper ($)')}</span>{num('cap_user_usd', '0.1')}</div>
        <div className="row"><span style={{ minWidth: 220 }}>{T('الحد الشهري لكل رقم واتساب ($)', 'Monthly cap per WhatsApp phone ($)')}</span>{num('cap_wa_phone_usd', '0.1')}</div>
        <div className="row"><span style={{ minWidth: 220 }}>{T('رسائل في الدقيقة لكل شخص', 'Messages per minute per person')}</span>{num('rate_per_min', '1')}</div>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>{T('عند بلوغ الحد يتوقف يورغو حتى أول الشهر التالي؛ الطلب والبيع يعملان كالعادة.', 'When a cap is reached Yorgo pauses until the first of next month; ordering and selling work as usual.')}</p>
        <div><button className="btn primary" disabled={busy || !dirty} onClick={save}>{T('حفظ', 'Save')}</button></div>
      </div>

      <div className="card stack">
        <strong>{T('يورغو في نقطة البيع، لكل محل', 'Yorgo in the point of sale, per shop')}</strong>
        {shops.map(sh => { const u = byShop.get(sh.id) ?? { cost: 0, messages: 0 }; const cap = yshops.find(y => y.shop_id === sh.id)?.cap_usd ?? saved.cap_shop_usd; return (
          <div key={sh.id} className="row" style={{ justifyContent: 'space-between', borderTop: '1px solid var(--line)', paddingTop: 8 }}>
            <label className="row" style={{ flex: 1, minWidth: 180 }}><input type="checkbox" checked={!!on[sh.id]} onChange={() => void toggleShop(sh.id)} /> {sh.name}</label>
            <span className="muted" style={{ fontSize: 13 }}>{u.messages} {T('رسالة', 'messages')} · {usd(u.cost)} / {usd(cap)}</span>
            <div style={{ width: 120 }}><Bar value={u.cost} cap={cap} /></div>
          </div>); })}
      </div>

      <div className="card stack">
        <strong>{T('آخر ١٤ يوماً', 'Last 14 days')}</strong>
        {!days.length && <span className="muted">{T('لا استخدام هذا الشهر بعد.', 'No usage this month yet.')}</span>}
        {days.map(([day, d]) => (
          <div key={day} className="row" style={{ gap: 10 }}>
            <span className="muted" style={{ width: 92, fontSize: 13 }} dir="ltr">{day}</span>
            <div className="yorgo-bar" style={{ flex: 1 }}><div style={{ width: `${(d.cost / maxDay) * 100}%`, background: '#7c3aed' }} /></div>
            <span style={{ width: 150, fontSize: 13, textAlign: 'end' }}>{d.messages} {T('رسالة', 'msgs')} · {usd(d.cost)}</span>
          </div>))}
      </div>

      {!!missList.length && <div className="card stack">
        <strong>{T('طُلب ولم يُعثر عليه', 'Asked for and not found')}</strong>
        <span className="muted" style={{ fontSize: 13 }}>{T('كلمات فقط مع عدد المرات — بلا أسماء أشخاص وبلا محادثات. مفيدة لمعرفة ما ينقص المحلات.', 'Words only, with a count — no people, no conversations. Useful to see what shops are missing.')}</span>
        {missList.map(m => (
          <div key={m.id} className="row" style={{ justifyContent: 'space-between' }}>
            <span><strong dir="auto">{m.phrase}</strong> <span className="muted">×{m.times} · {shopName(m.shop_id)}</span></span>
            <button className="btn ghost" onClick={() => void dismiss(m.id)}>✕</button>
          </div>))}
      </div>}
      <p className="muted" style={{ fontSize: 12, margin: 0 }}>{T('الأرقام تقدير من أسعار النموذج المعلنة. لا أحد في الإدارة يرى نصّ الرسائل.', 'Figures are estimates from the model\'s published prices. Nobody in the association can read the messages.')}</p>
    </div>
  );
}
