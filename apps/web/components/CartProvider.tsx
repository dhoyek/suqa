'use client';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LocalizedText } from '@suqa/shared';

export type CartLine = { product_id: string; name: LocalizedText; unit: string | null; price_usd: number; qty: number };
export type ShopRef = { id: string; slug: string; name: LocalizedText; whatsapp?: string | null; min_order_usd?: number };
export type CartShop = ShopRef & { lines: CartLine[]; selected: boolean };
/** v2: one cart, grouped by shop. `selected` = included in the next checkout (AliExpress-style). */
export type Cart = { v: 2; shops: CartShop[] };

type Ctx = {
  cart: Cart;
  multiShop: boolean;
  /** all lines across shops */ count: number; subtotal: number;
  /** selected shops only */ selectedShops: CartShop[]; selectedCount: number; selectedSubtotal: number;
  shopOf: (shopId: string) => CartShop | undefined;
  qtyOf: (shopId: string, productId: string) => number;
  /** Adds one unit. When multi-shop is off and another shop is in the cart, asks replaceConfirm() first. */
  add: (shop: ShopRef, line: Omit<CartLine, 'qty'>, replaceConfirm: () => Promise<boolean> | boolean) => Promise<void>;
  setQty: (shopId: string, productId: string, qty: number) => void;
  setSelected: (shopId: string, selected: boolean) => void;
  removeShop: (shopId: string) => void;
  /** After a successful checkout: drop the shops that were ordered, keep the rest. */
  removeShops: (shopIds: string[]) => void;
  clear: () => void;
};
const CartCtx = createContext<Ctx | null>(null);
const EMPTY: Cart = { v: 2, shops: [] };

function migrate(raw: any): Cart {
  if (!raw) return EMPTY;
  if (raw.v === 2 && Array.isArray(raw.shops)) return raw as Cart;
  // v1 shape: { shop_id, shop_slug, shop_name, shop_whatsapp, lines }
  if (raw.shop_id && Array.isArray(raw.lines) && raw.lines.length) {
    return { v: 2, shops: [{ id: raw.shop_id, slug: raw.shop_slug, name: raw.shop_name, whatsapp: raw.shop_whatsapp ?? null, lines: raw.lines, selected: true }] };
  }
  return EMPTY;
}
const sum = (shops: CartShop[]) => Math.round(shops.reduce((s, sh) => s + sh.lines.reduce((a, l) => a + l.price_usd * l.qty, 0), 0) * 100) / 100;
const cnt = (shops: CartShop[]) => shops.reduce((n, sh) => n + sh.lines.reduce((a, l) => a + l.qty, 0), 0);

// One cart per tenant, kept in localStorage (per-device convenience; orders themselves are created server-side).
export function CartProvider({ tenantSlug, multiShop, children }: { tenantSlug: string; multiShop: boolean; children: ReactNode }) {
  const key = `suqa:cart:${tenantSlug}`;
  const [cart, setCart] = useState<Cart>(EMPTY);
  const [ready, setReady] = useState(false);
  const cartRef = useRef(cart); cartRef.current = cart;

  useEffect(() => { try { const raw = localStorage.getItem(key); if (raw) setCart(migrate(JSON.parse(raw))); } catch {} setReady(true); }, [key]);
  useEffect(() => { if (ready) { try { localStorage.setItem(key, JSON.stringify(cart)); } catch {} } }, [cart, key, ready]);

  const api = useMemo<Ctx>(() => {
    const selectedShops = cart.shops.filter(s => s.selected && s.lines.length);
    return {
      cart, multiShop,
      count: cnt(cart.shops), subtotal: sum(cart.shops),
      selectedShops, selectedCount: cnt(selectedShops), selectedSubtotal: sum(selectedShops),
      shopOf: id => cart.shops.find(s => s.id === id),
      qtyOf: (shopId, productId) => cart.shops.find(s => s.id === shopId)?.lines.find(l => l.product_id === productId)?.qty ?? 0,
      async add(shop, line, replaceConfirm) {
        const cur = cartRef.current;
        const others = cur.shops.filter(s => s.id !== shop.id && s.lines.length);
        if (!multiShop && others.length) {
          if (!(await replaceConfirm())) return;
          setCart({ v: 2, shops: [{ ...shop, lines: [{ ...line, qty: 1 }], selected: true }] });
          return;
        }
        setCart(prev => {
          const existing = prev.shops.find(s => s.id === shop.id);
          if (!existing) return { v: 2, shops: [...prev.shops, { ...shop, lines: [{ ...line, qty: 1 }], selected: true }] };
          const has = existing.lines.find(l => l.product_id === line.product_id);
          const lines = has ? existing.lines.map(l => l.product_id === line.product_id ? { ...l, qty: l.qty + 1 } : l) : [...existing.lines, { ...line, qty: 1 }];
          return { v: 2, shops: prev.shops.map(s => s.id === shop.id ? { ...s, ...shop, lines, selected: true } : s) };
        });
      },
      setQty(shopId, productId, qty) {
        setCart(prev => ({ v: 2, shops: prev.shops
          .map(s => s.id !== shopId ? s : { ...s, lines: s.lines.map(l => l.product_id === productId ? { ...l, qty } : l).filter(l => l.qty > 0) })
          .filter(s => s.lines.length) }));
      },
      setSelected(shopId, selected) { setCart(prev => ({ v: 2, shops: prev.shops.map(s => s.id === shopId ? { ...s, selected } : s) })); },
      removeShop(shopId) { setCart(prev => ({ v: 2, shops: prev.shops.filter(s => s.id !== shopId) })); },
      removeShops(ids) { setCart(prev => ({ v: 2, shops: prev.shops.filter(s => !ids.includes(s.id)) })); },
      clear() { setCart(EMPTY); },
    };
  }, [cart, multiShop]);

  return <CartCtx.Provider value={api}>{children}</CartCtx.Provider>;
}

export function useCart() {
  const c = useContext(CartCtx);
  if (!c) throw new Error('useCart outside CartProvider');
  return c;
}
