'use client';
import { useConfirm, useNotify } from '@/components/ConfirmProvider';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase-browser';
import MapPicker from '@/components/MapPicker';
import RestorePanel from './RestorePanel';
import { pointToEwkt, type Locale, type Shop } from '@suqa/shared';

type Member = { user_id: string; full_name: string | null; email: string; role: 'owner' | 'staff' };
type Labels = Record<'save' | 'saved' | 'nameAr' | 'nameEn' | 'shopSlug' | 'category' | 'phone' | 'whatsapp' | 'addressText' | 'minOrder' | 'prepMinutes' | 'commissionRate' | 'shopLocation'
  | 'useMyLocation' | 'zonesServed' | 'feeOverride' | 'owners' | 'addByEmail' | 'userNotFound' | 'role' | 'owner' | 'staff' | 'remove' | 'newShop' | 'editProduct' | 'products', string>;

export default function ShopEditor(props: {
  tenantId: string; locale: Locale; shop: Shop | null; location: { lat: number; lng: number };
  categories: { id: string; name: string }[]; zones: { id: string; name: string; fee_usd: number }[];
  served: { zone_id: string; fee_usd: number | null }[]; members: Member[]; labels: Labels;
}) {
  const { tenantId, shop, categories, zones, labels } = props; const ar = props.locale === 'ar';
  const router = useRouter();
  const sb = useMemo(() => supabaseBrowser(), []);
  const notify = useNotify();
  const [f, setF] = useState({
    name_ar: shop?.name.ar ?? '', name_en: shop?.name.en ?? '', known_as: (shop as unknown as { known_as?: string | null } | null)?.known_as ?? '', known_as_en: (shop as unknown as { known_as_en?: string | null } | null)?.known_as_en ?? '', slug: shop?.slug ?? '', category_id: shop?.category_id ?? categories[0]?.id ?? '',
    phone: shop?.phone ?? '', whatsapp: shop?.whatsapp ?? '', address_text: shop?.address_text ?? '', min_order_usd: String(shop?.min_order_usd ?? 0),
    prep_minutes: String(shop?.prep_minutes ?? 30), commission_rate: shop?.commission_rate == null ? '' : String(Number(shop.commission_rate) * 100),
  });
  const [loc, setLoc] = useState(props.location);
  const ask = useConfirm();
  const [served, setServed] = useState<Record<string, { on: boolean; fee: string }>>(Object.fromEntries(zones.map(z => {
    const s = props.served.find(x => x.zone_id === z.id); return [z.id, { on: !!s, fee: s?.fee_usd == null ? '' : String(s.fee_usd) }];
  })));
  const [members, setMembers] = useState<Member[]>(props.members);
  // people added by number who have not signed in yet: their role waits for them (shown so the box is not mistaken for empty)
  type Invite = { id: string; phone: string; role: string; display_name: string | null };
  const [invites, setInvites] = useState<Invite[]>([]);
  const loadInvites = async () => {
    if (!props.shop) return;
    const { data } = await sb.from('staff_invites').select('id,phone,role,display_name').eq('shop_id', props.shop.id).is('claimed_at', null).order('created_at');
    setInvites((data as Invite[] | null) ?? []);
  };
  useEffect(() => { void loadInvites(); }, [props.shop?.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const [email, setEmail] = useState(''); const [role, setRole] = useState<'owner' | 'staff'>('owner');
  const [pos, setPos] = useState<boolean>(!!(shop as unknown as { pos_enabled?: boolean } | null)?.pos_enabled);
  // the tenant switches the point of sale on per shop; without it the shop's people cannot open /pos
  async function togglePos(on: boolean) {
    if (!shop) return;
    const { error } = await sb.from('shops').update({ pos_enabled: on }).eq('id', shop.id);
    if (error) { notify(error.message); return; }
    setPos(on);
  }
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);

  const slugify = (s: string) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  async function save() {
    setBusy(true); setMsg(null);
    const row = {
      tenant_id: tenantId, slug: f.slug || slugify(f.name_en || f.name_ar), name: { ar: f.name_ar.trim() || f.name_en.trim(), en: f.name_en.trim() || f.name_ar.trim() },
      category_id: f.category_id || null,
      // only sent when used, so saving still works on a database without the column (schema 69)
      ...(f.known_as_en.trim() || (shop as unknown as { known_as_en?: string | null } | null)?.known_as_en ? { known_as_en: f.known_as_en.trim().slice(0, 60) || null } : {}),
      ...(f.known_as.trim() || (shop as unknown as { known_as?: string | null } | null)?.known_as ? { known_as: f.known_as.trim().slice(0, 60) || null } : {}),
      phone: f.phone.trim() || null, whatsapp: f.whatsapp.trim() || null, address_text: f.address_text.trim() || null,
      min_order_usd: Number(f.min_order_usd) || 0, prep_minutes: Number(f.prep_minutes) || 30,
      commission_rate: f.commission_rate.trim() === '' ? null : Number(f.commission_rate) / 100, location: pointToEwkt(loc),
    };
    let id = shop?.id;
    if (id) { const { error } = await sb.from('shops').update(row).eq('id', id); if (error) { setMsg(error.message); setBusy(false); return; } }
    else { const { data, error } = await sb.from('shops').insert({ ...row, status: 'pending' }).select('id').single(); if (error) { setMsg(error.message); setBusy(false); return; } id = (data as any).id; }
    // zones served
    const rows = Object.entries(served).filter(([, v]) => v.on).map(([zone_id, v]) => ({ shop_id: id!, zone_id, fee_usd: v.fee.trim() === '' ? null : Number(v.fee) }));
    await sb.from('shop_delivery_zones').delete().eq('shop_id', id!);
    if (rows.length) { const { error } = await sb.from('shop_delivery_zones').insert(rows); if (error) { setMsg(error.message); setBusy(false); return; } }
    setBusy(false); setMsg(labels.saved);
    if (!shop) router.replace(`/admin/shops/${id}`);
  }

  async function addMember() {
    if (!shop) return;
    // a phone / WhatsApp number: attach that account now, or keep the role waiting for the number's first sign-in
    if (!email.includes('@')) {
      const { data, error } = await sb.rpc('admin_account_invite', { p_tenant: tenantId, p_phone: email.trim(), p_name: null, p_tenant_role: null, p_shop: shop.id, p_shop_role: role });
      if (error) { notify(error.message); return; }
      const applied = (data as { status?: string } | null)?.status === 'applied';
      notify(applied ? labels.saved : (ar ? 'الرقم غير مسجّل بعد — سيُضاف تلقائياً عند أول دخول له.' : 'Number not signed up yet — it will be added on its first sign-in.'));
      setEmail(''); if (applied) window.location.reload(); else void loadInvites();
      return;
    }
    const { data, error } = await sb.rpc('find_user_by_email', { p_tenant: tenantId, p_email: email });
    const u = Array.isArray(data) ? data[0] : data;
    if (error || !u) { notify(labels.userNotFound); return; }
    const { error: e2 } = await sb.from('shop_members').upsert({ shop_id: shop.id, user_id: u.user_id, role });
    if (e2) { notify(e2.message); return; }
    setMembers(prev => [...prev.filter(m => m.user_id !== u.user_id), { user_id: u.user_id, full_name: u.full_name, email: u.email, role }]); setEmail('');
  }
  async function removeMember(m: Member) {
    if (!shop || !(await ask(`${labels.remove} ${m.email}?`, { danger: true }))) return;
    const { error } = await sb.from('shop_members').delete().eq('shop_id', shop.id).eq('user_id', m.user_id);
    if (error) { notify(error.message); return; }
    setMembers(prev => prev.filter(x => x.user_id !== m.user_id));
  }

  // plain function (not a component) so inputs keep focus across re-renders
  const field = (k: keyof typeof f, label: string, dir?: 'ltr' | 'rtl') => (
    <div><label className="label">{label}</label><input className="input" dir={dir} value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} /></div>
  );

  return (
    <div className="stack">
      <h1 style={{ margin: 0, fontSize: 20 }}>{shop ? (f.name_ar || f.name_en) : labels.newShop}</h1>
      <section className="card stack">
        <div className="row" style={{ alignItems: 'stretch' }}>
          <div style={{ flex: 1 }}>{field('name_ar', labels.nameAr, 'rtl')}</div>
          <div style={{ flex: 1 }}>{field('name_en', labels.nameEn, 'ltr')}</div>
        </div>
        <div className="row" style={{ alignItems: 'stretch' }}>
          <div style={{ flex: 1 }}>{field('slug', labels.shopSlug, 'ltr')}</div>
          <div style={{ flex: 1 }}><label className="label">{labels.category}</label>
            <select className="input" value={f.category_id} onChange={e => setF({ ...f, category_id: e.target.value })}>{categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        </div>
        <div><div className="row" style={{ alignItems: 'stretch' }}>
          <div style={{ flex: 1 }}>{field('known_as', ar ? 'معروف باسم — عربي (اختياري) — مثلاً: أبو إيلي' : 'Known as — Arabic (optional)', 'rtl')}</div>
          <div style={{ flex: 1 }}>{field('known_as_en', ar ? 'معروف باسم — إنكليزي (اختياري) — مثلاً: Abou Elie' : 'Known as — English (optional) — e.g. Abou Elie', 'ltr')}</div>
        </div>
          <small className="muted">{ar ? 'يظهر تحت اسم المتجر في القائمة ويُبحث به. اتركه فارغاً إن لم يرغب صاحب المتجر بإظهار اسمه.' : 'Shown under the shop name in the list and searchable. Leave empty if the owner prefers not to show a name.'}</small></div>
        <div className="row" style={{ alignItems: 'stretch' }}>
          <div style={{ flex: 1 }}>{field('phone', labels.phone, 'ltr')}</div>
          <div style={{ flex: 1 }}>{field('whatsapp', labels.whatsapp, 'ltr')}</div>
        </div>
        {field('address_text', labels.addressText)}
        <div className="row" style={{ alignItems: 'stretch' }}>
          <div style={{ flex: 1 }}>{field('min_order_usd', `${labels.minOrder} (USD)`, 'ltr')}</div>
          <div style={{ flex: 1 }}>{field('prep_minutes', labels.prepMinutes, 'ltr')}</div>
          <div style={{ flex: 1 }}>{field('commission_rate', labels.commissionRate, 'ltr')}</div>
        </div>
        <div><div className="label">{labels.shopLocation}</div><MapPicker value={loc} onChange={setLoc} useMyLocationLabel={labels.useMyLocation} /></div>
        <div>
          <div className="label">{labels.zonesServed}</div>
          {zones.map(z => (
            <div className="row" key={z.id} style={{ padding: '6px 0' }}>
              <label className="row" style={{ flex: 1, cursor: 'pointer' }}><input type="checkbox" checked={served[z.id]?.on ?? false} onChange={e => setServed({ ...served, [z.id]: { ...served[z.id], on: e.target.checked } })} /> {z.name} <span className="muted">(${z.fee_usd.toFixed(2)})</span></label>
              <input className="input" style={{ width: 120 }} dir="ltr" placeholder={labels.feeOverride} value={served[z.id]?.fee ?? ''} onChange={e => setServed({ ...served, [z.id]: { ...served[z.id], fee: e.target.value } })} />
            </div>
          ))}
        </div>
        {msg && <div className={msg === labels.saved ? 'muted' : 'error'}>{msg}</div>}
        <button className="btn primary" disabled={busy} onClick={save}>{labels.save}</button>
      </section>

      {shop && (
        <section className="card stack">
          <label className="row" style={{ gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={pos} onChange={e => togglePos(e.target.checked)} />
            <strong>🖥️ {ar ? 'نقطة البيع (POS) مفعّلة لهذا المتجر' : 'Point of sale (POS) enabled for this shop'}</strong>
          </label>
          <small className="muted">{ar ? 'عند التفعيل يستطيع صاحب المتجر وموظفوه فتح /pos. كل شخص يختار رمزه السري عند أول دخول.' : 'When on, the owner and staff below can open /pos. Each person chooses a PIN on first use.'}</small>
        </section>
      )}

      {shop && (
        <section className="card stack">
          <strong>{labels.owners}</strong>
          {members.map(m => (
            <div className="row spread" key={m.user_id}>
              <span>{m.full_name || '—'} <span className="muted" style={{ fontSize: 13 }}>{m.email}</span></span>
              <span className="row"><span className="badge">{m.role === 'owner' ? labels.owner : labels.staff}</span><button className="btn ghost muted" onClick={() => removeMember(m)}>✕</button></span>
            </div>
          ))}
          {invites.map(i => (
            <div className="row spread" key={i.id}>
              <span>{i.display_name ? i.display_name + ' ' : ''}<bdi dir="ltr">+{i.phone}</bdi> <span className="muted" style={{ fontSize: 13 }}>· ⏳ {ar ? 'بانتظار أول دخول له' : 'waiting for first sign-in'}</span></span>
              <span className="row"><span className="badge">{i.role === 'owner' ? labels.owner : labels.staff}</span><button className="btn ghost muted" onClick={async () => {
                if (!(await ask(`${labels.remove} +${i.phone}?`, { danger: true }))) return;
                const { error } = await sb.from('staff_invites').delete().eq('id', i.id);
                if (error) { notify(error.message); return; }
                setInvites(prev => prev.filter(x => x.id !== i.id));
              }}>✕</button></span>
            </div>
          ))}
          <div className="row">
            <input className="input" style={{ flex: 1 }} dir="ltr" type="text" inputMode="email" placeholder={ar ? 'رقم واتساب (⁦70 123 456⁩) أو بريد إلكتروني' : 'WhatsApp number (70 123 456) or email'} value={email} onChange={e => setEmail(e.target.value)} />
            <select className="input" style={{ width: 'auto' }} value={role} onChange={e => setRole(e.target.value as any)}><option value="owner">{labels.owner}</option><option value="staff">{labels.staff}</option></select>
            <button className="btn" onClick={addMember} disabled={!email.trim()}>+</button>
          </div>
        </section>
      )}
      {shop && <RestorePanel shopId={shop.id} locale={props.locale} />}
    </div>
  );
}
