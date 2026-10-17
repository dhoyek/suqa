'use client';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { LocalizedText } from '@suqa/shared';

export type CartLine = { product_id: string; name: LocalizedText; unit: string | null; price_usd: number; qty: number };
export type Cart = { shop_id: string | null; shop_slug: string | null; shop_name: LocalizedText | null; shop_whatsapp?: string | null; lines: CartLine[] };

type Ctx = {
  cart: Cart; count: number; subtotal: number;
  add: (shop: { id: string; slug: string; name: LocalizedText; whatsapp?: string | null }, line: Omit<CartLine, 'qty'>, replaceConfirm: () => boolean) => void;
  setQty: (product_id: string, qty: number) => void;
  clear: () => void;
};
const CartCtx = createContext<Ctx | null>(null);
const EMPTY: Cart = { shop_id: null, shop_slug: null, shop_name: null, lines: [] };

// One cart per tenant, kept in localStorage (per-device convenience; the order itself is created server-side).
export function CartProvider({ tenantSlug, children }: { tenantSlug: string; children: ReactNode }) {
  const key = `suqa:cart:${tenantSlug}`;
  const [cart, setCart] = useState<Cart>(EMPTY);
  const [ready, setReady] = useState(false);

  useEffect(() => { try { const raw = localStorage.getItem(key); if (raw) setCart(JSON.parse(raw)); } catch {} setReady(true); }, [key]);
  useEffect(() => { if (ready) { try { localStorage.setItem(key, JSON.stringify(cart)); } catch {} } }, [cart, key, ready]);

  const api = useMemo<Ctx>(() => ({
    cart,
    count: cart.lines.reduce((n, l) => n + l.qty, 0),
    subtotal: Math.round(cart.lines.reduce((s, l) => s + l.price_usd * l.qty, 0) * 100) / 100,
    add(shop, line, replaceConfirm) {
      setCart(prev => {
        if (prev.shop_id && prev.shop_id !== shop.id && prev.lines.length) {
          if (!replaceConfirm()) return prev;
          return { shop_id: shop.id, shop_slug: shop.slug, shop_name: shop.name, shop_whatsapp: shop.whatsapp ?? null, lines: [{ ...line, qty: 1 }] };
        }
        const existing = prev.lines.find(l => l.product_id === line.product_id);
        const lines = existing ? prev.lines.map(l => l.product_id === line.product_id ? { ...l, qty: l.qty + 1 } : l) : [...prev.lines, { ...line, qty: 1 }];
        return { shop_id: shop.id, shop_slug: shop.slug, shop_name: shop.name, shop_whatsapp: shop.whatsapp ?? prev.shop_whatsapp ?? null, lines };
      });
    },
    setQty(product_id, qty) {
      setCart(prev => {
        const lines = prev.lines.map(l => l.product_id === product_id ? { ...l, qty } : l).filter(l => l.qty > 0);
        return lines.length ? { ...prev, lines } : EMPTY;
      });
    },
    clear() { setCart(EMPTY); },
  }), [cart]);

  return <CartCtx.Provider value={api}>{children}</CartCtx.Provider>;
}

export function useCart() {
  const c = useContext(CartCtx);
  if (!c) throw new Error('useCart outside CartProvider');
  return c;
}
