'use client';
import { useEffect, useRef, useState } from 'react';
import { pt, type L } from '../i18n';
import Modal from './Modal';

// Camera scanning: native BarcodeDetector when the browser has it (Chrome/Android), the zxing-wasm ponyfill otherwise (Safari/iPad).
// Loaded only when the camera button is pressed, so the sale screen bundle stays small.
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'qr_code'];

export default function CameraScanner({ open, locale, onScan, onClose }: { open: boolean; locale: L; onScan: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);
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
        let last = ''; let lastAt = 0;
        const tick = async () => {
          if (stop) return;
          try {
            const codes = await det.detect(video.current!);
            const c = codes.find(x => x.rawValue);
            if (c && (c.rawValue !== last || Date.now() - lastAt > 1500)) { last = c.rawValue; lastAt = Date.now(); onScan(c.rawValue); }
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
      <video ref={video} muted playsInline style={{ width: '100%', borderRadius: 12, background: '#000', maxHeight: '60dvh' }} />
    </Modal>
  );
}
