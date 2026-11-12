'use client';
import { useEffect, useRef, type ReactNode } from 'react';

/** Minimal modal: Esc closes, backdrop click closes, body scroll locked. */
export default function Modal({ open, onClose, title, children, wide, footer }: { open: boolean; onClose: () => void; title?: string; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  // dialogs stack (a PIN prompt over the pay dialog): only the one on top answers Esc, otherwise Esc closed the dialog underneath
  const me = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('[data-esc-layer]')) return;                                  // an open menu inside the dialog takes Esc first
      const all = document.querySelectorAll('.pos-modal-backdrop'); if (all.length && all[all.length - 1] !== me.current) return;
      e.stopPropagation(); onClose();
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="pos-modal-backdrop" ref={me} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`pos-modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        {title && <div className="pos-modal-title">{title}<button className="btn icon" onClick={onClose} aria-label="close">✕</button></div>}
        <div className="pos-modal-body">{children}</div>
        {footer && <div className="pos-modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

/** Numeric keypad used by qty / price / amounts. Emits the full string; the caller parses. */
export function NumPad({ value, onChange, decimal = true, onEnter, big }: { value: string; onChange: (v: string) => void; decimal?: boolean; onEnter?: () => void; big?: boolean }) {
  const press = (k: string) => {
    if (k === 'C') return onChange('');
    if (k === '⌫') return onChange(value.slice(0, -1));
    if (k === '.' && (!decimal || value.includes('.'))) return;
    if (value === '0' && k !== '.') return onChange(k);
    onChange(value + k);
  };
  return (
    <div className={`numpad ${big ? 'big' : ''}`}>
      {['7', '8', '9', '4', '5', '6', '1', '2', '3'].map(k => <button key={k} type="button" onClick={() => press(k)}>{k}</button>)}
      <button type="button" onClick={() => press(decimal ? '.' : 'C')} className="muted">{decimal ? '.' : 'C'}</button>
      <button type="button" onClick={() => press('0')}>0</button>
      <button type="button" onClick={() => press('⌫')} className="muted">⌫</button>
      {onEnter && <button type="button" className="enter primary" onClick={onEnter}>↵</button>}
    </div>
  );
}
