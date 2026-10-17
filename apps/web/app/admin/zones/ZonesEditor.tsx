'use client';
import { useConfirm } from '@/components/ConfirmProvider';
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { t as tr, type Locale, type LocalizedText } from '@suqa/shared';

type Zone = { id: string; name: LocalizedText; fee_usd: number; eta_minutes: number | null; is_active: boolean; sort_order: number; geojson: any };
type Labels = Record<'zones' | 'newZone' | 'zoneName' | 'nameAr' | 'nameEn' | 'deliveryFee' | 'etaMinutes' | 'active' | 'drawZone' | 'finish' | 'clearDrawing' | 'save' | 'saved' | 'cancel' | 'remove', string>;
declare global { interface Window { L?: any } }

function loadLeaflet(): Promise<any> {
  if (window.L) return Promise.resolve(window.L);
  return new Promise((res, rej) => {
    const css = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    if (!document.querySelector(`link[href="${css}"]`)) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = css; document.head.appendChild(l); }
    const s = document.createElement('script'); s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'; s.onload = () => res(window.L); s.onerror = rej; document.head.appendChild(s);
  });
}
const COLORS = ['#0E7490', '#b45309', '#15803d', '#7c3aed', '#be123c', '#0369a1'];
const toWkt = (ring: [number, number][]) => `SRID=4326;MULTIPOLYGON(((${[...ring, ring[0]].map(([lat, lng]) => `${lng} ${lat}`).join(', ')})))`;

export default function ZonesEditor({ tenantId, locale: L, center, initial, labels }: { tenantId: string; locale: Locale; center: { lat: number; lng: number }; initial: Zone[]; labels: Labels }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [zones, setZones] = useState<Zone[]>(initial);
  const ask = useConfirm();
  const [editing, setEditing] = useState<Zone | null>(null);
  const [draft, setDraft] = useState({ name_ar: '', name_en: '', fee: '', eta: '', active: true });
  const [drawing, setDrawing] = useState<[number, number][]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const el = useRef<HTMLDivElement>(null); const map = useRef<any>(null); const layers = useRef<any>(null); const drawLayer = useRef<any>(null);
  const drawingRef = useRef(drawing);
  drawingRef.current = drawing;

  useEffect(() => {
    let dead = false;
    loadLeaflet().then(Lf => {
      if (dead || !el.current || map.current) return;
      map.current = Lf.map(el.current).setView([center.lat, center.lng], 14);
      Lf.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map.current);
      layers.current = Lf.layerGroup().addTo(map.current);
      drawLayer.current = Lf.layerGroup().addTo(map.current);
      map.current.on('click', (e: any) => setDrawing(d => [...d, [e.latlng.lat, e.latlng.lng]]));
    });
    return () => { dead = true; map.current?.remove(); map.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // existing zones
  useEffect(() => {
    const Lf = window.L; if (!Lf || !layers.current) return;
    layers.current.clearLayers();
    zones.forEach((z, i) => Lf.geoJSON(z.geojson, { style: { color: COLORS[i % COLORS.length], weight: 2, fillOpacity: z.is_active ? 0.15 : 0.04, dashArray: z.is_active ? undefined : '4 4' } })
      .bindTooltip(`${tr(z.name, L)} · $${Number(z.fee_usd).toFixed(2)}`).addTo(layers.current));
  }, [zones, L, map.current]);

  // in-progress drawing
  useEffect(() => {
    const Lf = window.L; if (!Lf || !drawLayer.current) return;
    drawLayer.current.clearLayers();
    if (drawing.length) { Lf.polyline(drawing, { color: '#F59E0B', weight: 2, dashArray: '6 4' }).addTo(drawLayer.current); drawing.forEach(p => Lf.circleMarker(p, { radius: 4, color: '#F59E0B' }).addTo(drawLayer.current)); }
    if (drawing.length >= 3) Lf.polygon(drawing, { color: '#F59E0B', weight: 1, fillOpacity: 0.2 }).addTo(drawLayer.current);
  }, [drawing]);

  function startEdit(z: Zone | null) {
    setEditing(z ?? ({ id: '', name: {}, fee_usd: 0, eta_minutes: null, is_active: true, sort_order: zones.length + 1, geojson: null } as Zone));
    setDraft({ name_ar: z?.name.ar ?? '', name_en: z?.name.en ?? '', fee: z ? String(z.fee_usd) : '', eta: z?.eta_minutes == null ? '' : String(z.eta_minutes), active: z?.is_active ?? true });
    setDrawing([]); setMsg(null);
  }

  async function save() {
    if (!editing) return;
    const row: any = { name: { ar: draft.name_ar.trim() || draft.name_en.trim(), en: draft.name_en.trim() || draft.name_ar.trim() }, fee_usd: Number(draft.fee) || 0, eta_minutes: draft.eta.trim() === '' ? null : Number(draft.eta), is_active: draft.active };
    if (drawing.length >= 3) row.area = toWkt(drawing);
    if (!editing.id && drawing.length < 3) { setMsg(labels.drawZone); return; }
    const q = editing.id ? sb.from('delivery_zones').update(row).eq('id', editing.id) : sb.from('delivery_zones').insert({ ...row, tenant_id: tenantId, sort_order: editing.sort_order });
    const { error } = await q;
    if (error) { setMsg(error.message); return; }
    const { data } = await sb.rpc('tenant_zones_geojson', { p_tenant: tenantId });
    setZones((data as Zone[]) ?? []); setEditing(null); setDrawing([]); setMsg(labels.saved);
  }
  async function remove(z: Zone) {
    if (!(await ask(`${labels.remove} ${tr(z.name, L)}?`, { danger: true }))) return;
    const { error } = await sb.from('delivery_zones').delete().eq('id', z.id);
    if (error) { alert(error.message); return; }
    setZones(prev => prev.filter(x => x.id !== z.id)); setEditing(null);
  }

  return (
    <div className="stack">
      <div className="row spread"><h1 style={{ margin: 0, fontSize: 20 }}>{labels.zones}</h1><button className="btn primary" onClick={() => startEdit(null)}>+ {labels.newZone}</button></div>
      <div ref={el} className="map" style={{ height: 380 }} />
      {editing && (
        <section className="card stack">
          <div className="muted" style={{ fontSize: 13 }}>{labels.drawZone} ({drawing.length})
            <button className="btn ghost" style={{ minHeight: 30, padding: '2px 8px' }} onClick={() => setDrawing([])}>{labels.clearDrawing}</button></div>
          <div className="row" style={{ alignItems: 'stretch' }}>
            <div style={{ flex: 1 }}><label className="label">{labels.nameAr}</label><input className="input" dir="rtl" value={draft.name_ar} onChange={e => setDraft({ ...draft, name_ar: e.target.value })} /></div>
            <div style={{ flex: 1 }}><label className="label">{labels.nameEn}</label><input className="input" dir="ltr" value={draft.name_en} onChange={e => setDraft({ ...draft, name_en: e.target.value })} /></div>
          </div>
          <div className="row" style={{ alignItems: 'stretch' }}>
            <div style={{ flex: 1 }}><label className="label">{labels.deliveryFee} (USD)</label><input className="input" dir="ltr" inputMode="decimal" value={draft.fee} onChange={e => setDraft({ ...draft, fee: e.target.value })} /></div>
            <div style={{ flex: 1 }}><label className="label">{labels.etaMinutes}</label><input className="input" dir="ltr" inputMode="numeric" value={draft.eta} onChange={e => setDraft({ ...draft, eta: e.target.value })} /></div>
            <label className="row" style={{ alignSelf: 'end', minHeight: 44 }}><input type="checkbox" checked={draft.active} onChange={e => setDraft({ ...draft, active: e.target.checked })} /> {labels.active}</label>
          </div>
          {msg && <div className={msg === labels.saved ? 'muted' : 'error'}>{msg}</div>}
          <div className="row spread">
            <div className="row"><button className="btn" onClick={() => { setEditing(null); setDrawing([]); }}>{labels.cancel}</button>{editing.id && <button className="btn danger" onClick={() => remove(editing)}>{labels.remove}</button>}</div>
            <button className="btn primary" onClick={save}>{labels.save}</button>
          </div>
        </section>
      )}
      <section className="card">
        {zones.map((z, i) => (
          <div className="product" key={z.id}>
            <span className="dot on" style={{ background: COLORS[i % COLORS.length] }} />
            <div style={{ flex: 1 }}><div className="name">{tr(z.name, L)}</div><div className="muted" style={{ fontSize: 13 }}>${Number(z.fee_usd).toFixed(2)}{z.eta_minutes != null ? ` · ~${z.eta_minutes} min` : ''}{z.is_active ? '' : ' · off'}</div></div>
            <button className="btn ghost muted" onClick={() => startEdit(z)}>✎</button>
          </div>
        ))}
      </section>
    </div>
  );
}
