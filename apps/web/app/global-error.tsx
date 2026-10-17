'use client';

// Last resort: the root layout itself failed (e.g. database unreachable).
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en"><body style={{ fontFamily: 'system-ui, sans-serif', display: 'grid', placeItems: 'center', minHeight: '100dvh', margin: 0, padding: 16 }}>
      <div style={{ textAlign: 'center', maxWidth: 380 }}>
        <h1 style={{ fontSize: 20 }}>Service temporarily unavailable</h1>
        <p dir="rtl" style={{ color: '#666' }}>الخدمة غير متاحة مؤقتاً — حاول بعد قليل.</p>
        {error.digest && <p style={{ color: '#999', fontSize: 12 }}>ref {error.digest}</p>}
        <button onClick={reset} style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', cursor: 'pointer' }}>Try again</button>
      </div>
    </body></html>
  );
}
