'use client';
import { useEffect } from 'react';

// Rendered inside the root layout when a page throws. Keeps the brand shell; never shows stack traces.
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  const ar = typeof document !== 'undefined' && document.documentElement.lang === 'ar';
  return (
    <main className="login">
      <div className="card stack" style={{ textAlign: 'center' }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>{ar ? 'حدث خطأ ما' : 'Something went wrong'}</h1>
        <p className="muted">{ar ? 'حاول مجدداً، وإذا استمرّت المشكلة تواصل مع الجمعية.' : 'Please try again. If it keeps happening, contact the association.'}</p>
        {error.digest && <p className="muted" dir="ltr" style={{ fontSize: 12 }}>ref {error.digest}</p>}
        <button className="btn primary" onClick={reset}>{ar ? 'إعادة المحاولة' : 'Try again'}</button>
      </div>
    </main>
  );
}
