'use client';
import { useEffect, useRef } from 'react';
import { ScanBuffer } from '@/lib/scan-buffer';

/**
 * HID barcode scanners (keyboard mode) type the code very fast and finish with Enter. This global listener collects bursts
 * of keys with < 40 ms between them (a few slower gaps are forgiven for long codes) and, on Enter, hands the code over — whatever element has focus. Normal typing is slower,
 * so it is left alone (and if the burst lands in an input, the input's own value is restored). "Scan focus always lands in the
 * sale screen" without fighting the focus.
 */
export function useScanner(onScan: (code: string) => void, { minLength = 4, maxGap = 40 } = {}) {
  const target = useRef<HTMLInputElement | null>(null); const before = useRef('');
  const cb = useRef(onScan); cb.current = onScan;
  useEffect(() => {
    const scan = new ScanBuffer({ minLength, maxGap });      // forgives a lagging first key or two on a slow computer (lib/scan-buffer.ts)
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement) return;      // free text (a pasted customer message, a long note) is never a barcode
      const now = performance.now();
      if (e.key === 'Enter') {
        const code = scan.enter(now);
        if (code) {
          e.preventDefault(); e.stopPropagation();
          if (target.current) { target.current.value = before.current; target.current.dispatchEvent(new Event('input', { bubbles: true })); }
          cb.current(code);
        }
        target.current = null;
        return;
      }
      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
      if (scan.char(e.key, now)) {                              // first key of a burst: remember what the focused box held, to put it back
        const el = e.target as HTMLElement | null;
        if (el instanceof HTMLInputElement && el.type === 'text') { target.current = el; before.current = el.value; } else target.current = null;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [minLength, maxGap]);
}
