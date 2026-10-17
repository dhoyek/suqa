'use client';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

// In-page replacement for window.confirm(): a bottom sheet with Cancel / Confirm.
// Native dialogs are blocked in some webviews and look poor on phones. Usage: const ask = useConfirm(); if (!(await ask(text))) return;
type Ask = (message: string, opts?: { confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
const Ctx = createContext<Ask | null>(null);

export function ConfirmProvider({ children, labels }: { children: ReactNode; labels: { confirm: string; cancel: string } }) {
  const [state, setState] = useState<{ message: string; confirmLabel?: string; danger?: boolean } | null>(null);
  const resolver = useRef<(v: boolean) => void>(() => {});
  const ask = useCallback<Ask>((message, opts) => new Promise<boolean>(resolve => { resolver.current = resolve; setState({ message, ...opts }); }), []);
  const close = (v: boolean) => { setState(null); resolver.current(v); };
  return (
    <Ctx.Provider value={ask}>
      {children}
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
    </Ctx.Provider>
  );
}

export function useConfirm(): Ask {
  const ask = useContext(Ctx);
  // Fallback keeps components usable outside the provider (e.g. tests): native confirm.
  return ask ?? (async (m) => (typeof window !== 'undefined' ? window.confirm(m) : false));
}
