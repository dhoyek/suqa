'use client';
import { useEffect, useRef, useState } from 'react';
import type { Map as LMap, Marker } from 'leaflet';
import { pt, type L } from '../i18n';
import Modal from './Modal';

/** Drop a pin on an OpenStreetMap map (no API key). Loads leaflet on demand; the pin can also jump to the device's GPS position. */
export default function MapPicker({ locale, initial, onDone, onClose }: { locale: L; initial?: { lat: number; lng: number } | null; onDone: (p: { lat: number; lng: number }) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<LMap | null>(null); const pin = useRef<Marker | null>(null);
  const [pos, setPos] = useState<{ lat: number; lng: number }>(initial ?? { lat: 34.2545, lng: 35.6615 });   // Batroun by default
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const Lf = (await import('leaflet')).default;
      if (!alive || !box.current) return;
      if (!document.getElementById('leaflet-css')) { const l = document.createElement('link'); l.id = 'leaflet-css'; l.rel = 'stylesheet'; l.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; document.head.appendChild(l); }
      const m = Lf.map(box.current, { zoomControl: true, attributionControl: true }).setView([pos.lat, pos.lng], initial ? 17 : 14);
      Lf.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
      const icon = Lf.divIcon({ className: '', html: '<div style="font-size:32px;line-height:32px;transform:translate(-50%,-100%)">📍</div>', iconSize: [0, 0] });
      const mk = Lf.marker([pos.lat, pos.lng], { draggable: true, icon }).addTo(m);
      mk.on('dragend', () => { const p = mk.getLatLng(); setPos({ lat: p.lat, lng: p.lng }); });
      m.on('click', e => { mk.setLatLng(e.latlng); setPos({ lat: e.latlng.lat, lng: e.latlng.lng }); });
      map.current = m; pin.current = mk;
      setTimeout(() => m.invalidateSize(), 50);
    })().catch(e => setErr(String(e)));
    return () => { alive = false; map.current?.remove(); map.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const locate = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(g => { const p = { lat: g.coords.latitude, lng: g.coords.longitude }; setPos(p); pin.current?.setLatLng([p.lat, p.lng]); map.current?.setView([p.lat, p.lng], 17); }, e => setErr(e.message), { enableHighAccuracy: true, timeout: 8000 });
  };
  return (
    <Modal open onClose={onClose} title={pt('pickOnMap', locale)} wide
      footer={<><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><button className="btn" onClick={locate}>📡 {pt('myLocation', locale)}</button><span style={{ flex: 1 }} /><span className="muted" dir="ltr" style={{ fontSize: 12 }}>{pos.lat.toFixed(5)}, {pos.lng.toFixed(5)}</span><button className="btn primary" onClick={() => onDone(pos)}>{pt('ok', locale)}</button></>}>
      <div ref={box} style={{ height: 'min(60vh, 480px)', borderRadius: 10, overflow: 'hidden', background: '#e5e7eb' }} />
      <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>{pt('mapHint', locale)}{err ? ` · ${err}` : ''}</p>
    </Modal>
  );
}
