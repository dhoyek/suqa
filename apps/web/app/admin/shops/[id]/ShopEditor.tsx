'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase-browser';
import MapPicker from '@/components/MapPicker';
import { pointToEwkt, type Locale, type Shop } from '@suqa/shared';

type Member = { user_id: string; full_name: string | null; email: string; role: 'owner' | 'staff' };
type Labels = Record<'save' | 'saved' | 'nameAr' | 'nameEn' | 'shopSlug' | 'category' | 'phone' | 'whatsapp' | 'addressText' | 'minOrder' | 'prepMinutes' | 'commissionRate' | 'shopLocation'
  | 'useMyLocation' | 'zonesServed' | 'feeOverride' | 'owners' | 'addByEmail' | 'userNotFound' | 'role' | 'owner' | 'staff' | 'remove' | 'newShop' | 'editProduct' | 'products', string>;

export default function ShopEditor(props: {
  tenantId: string; locale: Locale; shop: Shop | null; location: { lat: number; lng: number };
  categories: { id: string; name: string }[]; zones: { id: string; name: string; fee_usd: number }[];
  served: { zone_id: string; fee_usd: number | null }[]; members: Member[]; labels: Labels;
}) {
  const { tenantId, shop, categories, zones, labels } = props;
  const router = useRouter();
  const sb = useMemo(() => supabaseBrowser(), []);
  const [f, setF] = useState({
    name_ar: shop?.name.ar ?? '', name_en: shop?.name.en ?? '', slug: shop?.slug ?? '', category_id: shop?.category_id ?? categories[0]?.id ?? '',
    phone: shop?.phone ?? '', whatsapp: shop?.whatsapp ?? '', address_text: shop?.address_text ?? '', min_order_usd: String(shop?.min_order_usd ?? 0),
    prep_minutes: String(shop?.prep_minutes ?? 30), commission_rate: shop?.commission_rate == null ? '' : String(Number(shop.commission_rate) * 100),
  });
  const [loc, setLoc] = useState(props.location);
  const [served, setServed] = useState<Record<string, { on: boolean; fee: string }>>(Object.fromEntries(zones.map(z => {
    const s = props.served.find(x => x.zone_id === z.id); return [z.id, { on: !!s, fee: s?.fee_usd == null ? '' : String(s.fee_usd) }];
  })));
  const [members, setMembers] = useState<Member[]>(props.members);
  const [email, setEmail] = useState(''); const [role, setRole] = useState<'owner' | 'staff'>('owner');
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);

  const slugify = (s: string) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  async function save() {
    setBusy(true); setMsg(null);
    const row = {
      tenant_id: tenantId, slug: f.slug || slugify(f.name_en || f.name_ar), name: { ar: f.name_ar.trim() || f.name_en.trim(), en: f.name_en.trim() || f.name_ar.trim() },
      category_id: f.category_id || null, phone: f.phone.trim() || null, whatsapp: f.whatsapp.trim() || null, address_text: f.address_text.trim() || null,
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
    const { data, error } = await sb.rpc('find_user_by_email', { p_tenant: tenantId, p_email: email });
    const u = Array.isArray(data) ? data[0] : data;
    if (error || !u) { alert(labels.userNotFound); return; }
    const { error: e2 } = await sb.from('shop_members').upsert({ shop_id: shop.id, user_id: u.user_id, role });
    if (e2) { alert(e2.message); return; }
    setMembers(prev => [...prev.filter(m => m.user_id !== u.user_id), { user_id: u.user_id, full_name: u.full_name, email: u.email, role }]); setEmail('');
  }
  async function removeMember(m: Member) {
    if (!shop || !confirm(`${labels.remove} ${m.email}?`)) return;
    const { error } = await sb.from('shop_members').delete().eq('shop_id', shop.id).eq('user_id', m.user_id);
    if (error) { alert(error.message); return; }
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
          <strong>{labels.owners}</strong>
          {members.map(m => (
            <div className="row spread" key={m.user_id}>
              <span>{m.full_name || '—'} <span className="muted" style={{ fontSize: 13 }}>{m.email}</span></span>
              <span className="row"><span className="badge">{m.role === 'owner' ? labels.owner : labels.staff}</span><button className="btn ghost muted" onClick={() => removeMember(m)}>✕</button></span>
            </div>
          ))}
          <div className="row">
            <input className="input" style={{ flex: 1 }} dir="ltr" type="email" placeholder={labels.addByEmail} value={email} onChange={e => setEmail(e.target.value)} />
            <select className="input" style={{ width: 'auto' }} value={role} onChange={e => setRole(e.target.value as any)}><option value="owner">{labels.owner}</option><option value="staff">{labels.staff}</option></select>
            <button className="btn" onClick={addMember} disabled={!email.trim()}>+</button>
          </div>
        </section>
      )}
    </div>
  );
}
