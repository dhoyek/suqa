'use client';
import { useEffect, useRef, useState } from 'react';
import { gtinCheckDigit, normBarcode } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import Modal from './Modal';

// Camera scanning: native BarcodeDetector when the browser has it (Chrome/Android), the zxing-wasm ponyfill otherwise (Safari/iPad).
// Loaded only when the camera button is pressed, so the sale screen bundle stays small.
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'qr_code'];

let audioCtx: AudioContext | null = null;
function beep() {
  try {
    audioCtx ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
    o.type = 'square'; o.frequency.value = 1760; g.gain.value = 0.05; o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.08);
  } catch { /* no audio */ }
}

export default function CameraScanner({ open, locale, onScan, onClose }: { open: boolean; locale: L; onScan: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null); const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!open) return;
    let stream: MediaStream | null = null; let stop = false; let timer: ReturnType<typeof setTimeout> | null = null;
    (async () => {
      try {
        type Det = { detect(src: HTMLVideoElement): Promise<Array<{ rawValue: string }>> };
        type DetCtor = new (o: { formats: string[] }) => Det;
        let Detector: DetCtor | undefined = (globalThis as unknown as { BarcodeDetector?: DetCtor }).BarcodeDetector;
        if (!Detector) { const m = await import('barcode-detector/ponyfill'); Detector = m.BarcodeDetector as unknown as DetCtor; }
        const det = new Detector({ formats: FORMATS });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
        if (stop) return;
        video.current!.srcObject = stream; await video.current!.play();
        // Like a handheld scanner: one read per "aim". After a hit, pause briefly, then the SAME code counts again only
        // once it has left the frame (so holding the camera on a barcode adds exactly one; lift and re-aim to add another).
        // Detection flickers frame to frame even on a steady barcode, so "left the frame" is time-based: the same code
        // is accepted again only when it has not been seen for 1.5 s straight.
        // The detector may report one physical symbol under different spellings between frames (UPC-A "012…" vs EAN-13
        // "0012…", with or without the check digit), so compare canonical keys, not raw strings.
        const key = (raw: string) => {
          const c = normBarcode(raw); if (!/^\d{7,14}$/.test(c)) return c;
          const body = [8, 12, 13, 14].includes(c.length) && gtinCheckDigit(c.slice(0, -1)) === Number(c[c.length - 1]) ? c.slice(0, -1) : c;
          return body.replace(/^0+/, '');
        };
        let last = ''; let hitAt = 0; let lastSeenAt = 0;
        const tick = async () => {
          if (stop) return;
          try {
            const codes = await det.detect(video.current!);
            const c = codes.find(x => x.rawValue);
            const now = Date.now();
            const same = !!c && key(c.rawValue) === last;
            const away = now - lastSeenAt;              // how long since the previous code was last in view
            if (same) lastSeenAt = now;
            if (c && now - hitAt > 700 && (!same || away > 1500)) {
              last = key(c.rawValue); hitAt = now; lastSeenAt = now; onScan(c.rawValue);
              setFlash(true); setTimeout(() => setFlash(false), 350);
              try { navigator.vibrate?.(40); } catch { /* not supported */ }
              beep();
            }
          } catch { /* frame not ready */ }
          timer = setTimeout(tick, 120);
        };
        void tick();
      } catch (e) { setErr((e as Error).message); }
    })();
    return () => { stop = true; if (timer) clearTimeout(timer); stream?.getTracks().forEach(t => t.stop()); };
  }, [open, onScan]);
  return (
    <Modal open={open} onClose={onClose} title={pt('cameraScan', locale)}>
      {err ? <p className="bad">{pt('cameraNo', locale)}: {err}</p> : <p className="muted">{pt('cameraHint', locale)}</p>}
      <div style={{ position: 'relative' }}>
        <video ref={video} muted playsInline style={{ width: '100%', borderRadius: 12, background: '#000', maxHeight: '60dvh', display: 'block' }} />
        <div aria-hidden style={{ position: 'absolute', inset: 0, borderRadius: 12, pointerEvents: 'none', boxShadow: flash ? 'inset 0 0 0 6px #16a34a' : 'inset 0 0 0 0 transparent', transition: 'box-shadow .15s' }} />
      </div>
      <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>{pt('cameraOnePerAim', locale)}</p>
    </Modal>
  );
}
