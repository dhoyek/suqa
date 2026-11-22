// Records one search for the association's Demand page (script 99, suqa.search_note): the words, found or not, the shop.
// Signed in → the person; otherwise a random key that lives in this browser tab only. Never throws, never blocks the page:
// before script 99 is installed, or offline, nothing happens.
import { supabaseBrowser } from '@/lib/supabase-browser';

function visitorKey(): string | null {
  try {
    let v = sessionStorage.getItem('suqa.visitor');
    if (!v) { v = Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem('suqa.visitor', v); }
    return v;
  } catch { return null; }
}

export function noteSearch(tenantId: string | null, shopId: string | null, phrase: string, found: boolean): void {
  const p = phrase.trim().slice(0, 80);
  if (p.length < 2 || typeof navigator === 'undefined' || navigator.onLine === false) return;
  try {
    void supabaseBrowser().rpc('search_note', { p_tenant: tenantId, p_shop: shopId, p_phrase: p, p_found: found, p_visitor: visitorKey() }).then(() => null, () => null);
  } catch { /* the search itself is what matters */ }
}
