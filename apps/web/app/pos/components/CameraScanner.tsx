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

export default function CameraScanner({ open, locale, onScan, onClose }: { open: boolean; locale: L; onScan: (code: string) => string | void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null); const [flash, setFlash] = useState(false);
  // Deterministic repeat rule: the last code read is "armed off" — it is not counted again, however long or shaky the hold,
  // until the cashier taps +1 or a different barcode is read. No timing heuristics.
  const [lastRead, setLastRead] = useState<{ code: string; label: string; n: number } | null>(null);
  const lastKey = useRef<string>('');
  const onScanRef = useRef(onScan); onScanRef.current = onScan;
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
        // The detector may report one physical symbol under different spellings between frames (UPC-A "012…" vs EAN-13
        // "0012…", with or without the check digit), so compare canonical keys, not raw strings.
        const key = (raw: string) => {
          const c = normBarcode(raw); if (!/^\d{7,14}$/.test(c)) return c;
          const body = [8, 12, 13, 14].includes(c.length) && gtinCheckDigit(c.slice(0, -1)) === Number(c[c.length - 1]) ? c.slice(0, -1) : c;
          return body.replace(/^0+/, '');
        };
        let hitAt = 0;
        const tick = async () => {
          if (stop) return;
          try {
            const codes = await det.detect(video.current!);
            const c = codes.find(x => x.rawValue);
            const now = Date.now();
            if (c && now - hitAt > 500 && key(c.rawValue) !== lastKey.current) {
              lastKey.current = key(c.rawValue); hitAt = now;
              const label = onScanRef.current(c.rawValue) || c.rawValue;
              setLastRead({ code: c.rawValue, label, n: 1 });
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
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal open={open} onClose={onClose} title={pt('cameraScan', locale)}>
      {err ? <p className="bad">{pt('cameraNo', locale)}: {err}</p> : <p className="muted">{pt('cameraHint', locale)}</p>}
      <div style={{ position: 'relative' }}>
        <video ref={video} muted playsInline style={{ width: '100%', borderRadius: 12, background: '#000', maxHeight: '60dvh', display: 'block' }} />
        <div aria-hidden style={{ position: 'absolute', inset: 0, borderRadius: 12, pointerEvents: 'none', boxShadow: flash ? 'inset 0 0 0 6px #16a34a' : 'inset 0 0 0 0 transparent', transition: 'box-shadow .15s' }} />
      </div>
      {lastRead ? (
        <div className="row spread" style={{ alignItems: 'center', gap: 8, marginTop: 8, padding: '8px 10px', background: '#ecfdf5', borderRadius: 10 }}>
          <div style={{ minWidth: 0 }}><strong>✓ {lastRead.label}</strong>{lastRead.n > 1 && <span className="muted"> × {lastRead.n}</span>}<div className="muted" style={{ fontSize: 12 }}>{pt('cameraNextHint', locale)}</div></div>
          <button className="btn primary" onClick={() => { onScanRef.current(lastRead.code); setLastRead(r => r && { ...r, n: r.n + 1 }); beep(); }}>+1</button>
        </div>
      ) : <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>{pt('cameraOnePerAim', locale)}</p>}
    </Modal>
  );
}
