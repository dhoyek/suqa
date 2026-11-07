'use client';
import { useEffect, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';

// Star toggle for a shop. Hidden until we know the user is signed in; optimistic update; stored in suqa.favorites.
export default function FavoriteButton({ shopId, tenantId, initial, labels, onChange }: { shopId: string; tenantId: string; initial?: boolean; labels: { add: string; remove: string }; onChange?: (on: boolean) => void }) {
  const [on, setOn] = useState(!!initial);
  const [uid, setUid] = useState<string | null>(null);
  useEffect(() => { supabaseBrowser().auth.getSession().then(({ data }) => setUid(data.session?.user.id ?? null)); }, []);
  useEffect(() => { setOn(!!initial); }, [initial]);
  if (!uid) return null;
  const toggle = async (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const next = !on; setOn(next); onChange?.(next);
    const sb = supabaseBrowser();
    const { error } = next
      ? await sb.from('favorites').insert({ user_id: uid, shop_id: shopId, tenant_id: tenantId })
      : await sb.from('favorites').delete().eq('user_id', uid).eq('shop_id', shopId);
    if (error) { setOn(!next); onChange?.(!next); }
  };
  return <button type="button" className={`fav ${on ? 'on' : ''}`} onClick={toggle} aria-pressed={on} title={on ? labels.remove : labels.add} aria-label={on ? labels.remove : labels.add}>{on ? '★' : '☆'}</button>;
}
