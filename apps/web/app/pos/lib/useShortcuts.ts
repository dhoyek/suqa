'use client';
import { useEffect, useRef } from 'react';

/** PC keyboard shortcuts for the sale screen. Function keys work regardless of focus; Esc is handled by whatever is open. */
export function useShortcuts(map: Record<string, () => void>, enabled = true) {
  const ref = useRef(map); ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    const h = (e: KeyboardEvent) => {
      const key = (e.ctrlKey ? 'ctrl+' : '') + e.key;
      const fn = ref.current[key];
      if (fn) { e.preventDefault(); e.stopPropagation(); fn(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [enabled]);
}
