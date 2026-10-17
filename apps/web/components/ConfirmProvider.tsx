'use client';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

// In-page replacement for window.confirm(): a bottom sheet with Cancel / Confirm.
// Native dialogs are blocked in some webviews and look poor on phones. Usage: const ask = useConfirm(); if (!(await ask(text))) return;
type Ask = (message: string, opts?: { confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
type Notify = (message: string, kind?: 'error' | 'ok') => void;
const Ctx = createContext<Ask | null>(null);
const NotifyCtx = createContext<Notify | null>(null);

export function ConfirmProvider({ children, labels }: { children: ReactNode; labels: { confirm: string; cancel: string } }) {
  const [state, setState] = useState<{ message: string; confirmLabel?: string; danger?: boolean } | null>(null);
  const resolver = useRef<(v: boolean) => void>(() => {});
  const ask = useCallback<Ask>((message, opts) => new Promise<boolean>(resolve => { resolver.current = resolve; setState({ message, ...opts }); }), []);
  const close = (v: boolean) => { setState(null); resolver.current(v); };
  // toast: in-page replacement for window.alert()
  const [toast, setToast] = useState<{ message: string; kind: 'error' | 'ok' } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback<Notify>((message, kind = 'error') => {
    setToast({ message, kind });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), kind === 'error' ? 6000 : 3000);
  }, []);
  return (
    <Ctx.Provider value={ask}>
      <NotifyCtx.Provider value={notify}>
      {children}
      {toast && <div className={`toast ${toast.kind}`} role="status" onClick={() => setToast(null)}>{toast.message}</div>}
      {state && (
        <div className="sheet" role="dialog" aria-modal="true" onClick={() => close(false)}>
          <div className="panel stack" onClick={e => e.stopPropagation()}>
            <p style={{ margin: 0, fontSize: 16 }}>{state.message}</p>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => close(false)}>{labels.cancel}</button>
              <button className={`btn ${state.danger ? 'danger' : 'primary'}`} autoFocus onClick={() => close(true)}>{state.confirmLabel ?? labels.confirm}</button>
            </div>
          </div>
        </div>
      )}
      </NotifyCtx.Provider>
    </Ctx.Provider>
  );
}

export function useNotify(): Notify {
  const n = useContext(NotifyCtx);
  return n ?? ((m) => { if (typeof window !== 'undefined') window.alert(m); });
}

export function useConfirm(): Ask {
  const ask = useContext(Ctx);
  // Fallback keeps components usable outside the provider (e.g. tests): native confirm.
  return ask ?? (async (m) => (typeof window !== 'undefined' ? window.confirm(m) : false));
}
