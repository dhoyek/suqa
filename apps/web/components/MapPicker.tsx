'use client';
import { useEffect, useRef } from 'react';

// Draggable pin on OpenStreetMap tiles via Leaflet loaded from a CDN (no npm dep, no API key).
declare global { interface Window { L?: any } }
const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';

function loadLeaflet(): Promise<any> {
  if (window.L) return Promise.resolve(window.L);
  return new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = LEAFLET_CSS; document.head.appendChild(l); }
    const s = document.createElement('script'); s.src = LEAFLET_JS; s.onload = () => resolve(window.L); s.onerror = reject; document.head.appendChild(s);
  });
}

export default function MapPicker({ value, onChange, useMyLocationLabel }: { value: { lat: number; lng: number }; onChange: (v: { lat: number; lng: number }) => void; useMyLocationLabel: string }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<any>(null);
  const marker = useRef<any>(null);

  useEffect(() => {
    let dead = false;
    loadLeaflet().then(L => {
      if (dead || !el.current || map.current) return;
      map.current = L.map(el.current, { zoomControl: true, attributionControl: true }).setView([value.lat, value.lng], 16);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map.current);
      marker.current = L.marker([value.lat, value.lng], { draggable: true }).addTo(map.current);
      marker.current.on('dragend', () => { const p = marker.current.getLatLng(); onChange({ lat: p.lat, lng: p.lng }); });
      map.current.on('click', (e: any) => { marker.current.setLatLng(e.latlng); onChange({ lat: e.latlng.lat, lng: e.latlng.lng }); });
    }).catch(() => {});
    return () => { dead = true; if (map.current) { map.current.remove(); map.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (marker.current) { marker.current.setLatLng([value.lat, value.lng]); map.current?.panTo([value.lat, value.lng]); } }, [value.lat, value.lng]);

  function locate() {
    navigator.geolocation?.getCurrentPosition(pos => { onChange({ lat: pos.coords.latitude, lng: pos.coords.longitude }); map.current?.setView([pos.coords.latitude, pos.coords.longitude], 17); }, () => {}, { enableHighAccuracy: true, timeout: 8000 });
  }

  return (
    <div className="stack">
      <div ref={el} className="map" />
      <button type="button" className="btn" onClick={locate}>📍 {useMyLocationLabel}</button>
    </div>
  );
}
