'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Re-render the server page every `seconds` while the order is still moving (status, driver, ETA), and when the tab comes back. */
export default function AutoRefresh({ seconds = 30 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') router.refresh(); }, seconds * 1000);
    const v = () => { if (document.visibilityState === 'visible') router.refresh(); };
    document.addEventListener('visibilitychange', v);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', v); };
  }, [router, seconds]);
  return null;
}
