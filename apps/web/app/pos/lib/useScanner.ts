'use client';
import { useEffect, useRef } from 'react';

/**
 * HID barcode scanners (keyboard mode) type the code very fast and finish with Enter. This global listener collects bursts
 * of keys with < 40 ms between them and, on Enter, hands the code over — whatever element has focus. Normal typing is slower,
 * so it is left alone (and if the burst lands in an input, the input's own value is restored). "Scan focus always lands in the
 * sale screen" without fighting the focus.
 */
export function useScanner(onScan: (code: string) => void, { minLength = 4, maxGap = 40 } = {}) {
  const buf = useRef(''); const lastT = useRef(0); const target = useRef<HTMLInputElement | null>(null); const before = useRef('');
  const cb = useRef(onScan); cb.current = onScan;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const now = performance.now();
      if (now - lastT.current > maxGap) { buf.current = ''; target.current = null; }
      lastT.current = now;
      if (e.key === 'Enter') {
        if (buf.current.length >= minLength) {
          e.preventDefault(); e.stopPropagation();
          const code = buf.current; buf.current = '';
          if (target.current) { target.current.value = before.current; target.current.dispatchEvent(new Event('input', { bubbles: true })); }
          cb.current(code);
        }
        return;
      }
      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!buf.current) {
        const el = e.target as HTMLElement | null;
        if (el instanceof HTMLInputElement && el.type === 'text') { target.current = el; before.current = el.value; } else target.current = null;
      }
      buf.current += e.key;
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [minLength, maxGap]);
}
