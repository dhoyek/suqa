// What an offer looks like to a customer (shop page and the all-shops Offers page): one shape for both kinds.
// Prices are dollar cents at the shop's rate — what the server charges for an online order (130 / 131).
import { bundleView, saleView, sortOffers, type Offer, type OfferProduct } from '@suqa/pos-core';
import type { LocalizedText } from '@suqa/shared';

export type OfferLine = { id: string; name: LocalizedText; qty: number; unit: string | null; image: string | null; normal: number; normalLbp: number | null };
export type OfferVM = {
  id: string; kind: 'bundle' | 'discount'; offer: Offer; ok: boolean; title: LocalizedText; description: LocalizedText; hot: boolean; pct: number;
  pics: string[]; lines: OfferLine[]; normal: number; charged: number; saving: number;
  /** a lira price offer: its lira as the shop typed it (and the item's own lira), shown without rounding */ lbp: number | null; normalLbp: number | null;
  /** price offer: the item it is on */ product?: OfferProduct & { unit?: string | null; decimal_qty?: boolean; unit_kind?: string | null };
};
const lira = (p: OfferProduct) => (p.price_currency === 'lbp' && Number(p.price_lbp) > 0 ? Math.round(Number(p.price_lbp)) : null);

/** The offers a customer can see now: on sale, or waiting for an item to come back ("not available now"). Hot first. */
export function offerVMs<P extends OfferProduct>(offers: Offer[], byId: (id: string) => P | undefined, fx: number, now: Date): OfferVM[] {
  const out: OfferVM[] = [];
  for (const o of sortOffers(offers)) {
    if (o.kind === 'bundle') {
      const v = bundleView<P>(o, byId, fx, 'online', now, now.getDay()); if (!(v.ok || v.why === 'item')) continue;
      out.push({ id: o.id, kind: 'bundle', offer: o, ok: v.ok, title: o.name as LocalizedText, description: (o.description ?? {}) as LocalizedText, hot: o.is_hot, pct: v.pct,
        pics: o.image_url ? [o.image_url] : (v.lines.map(l => l.product.image_url).filter(Boolean).slice(0, 4) as string[]),
        lines: v.lines.map(l => ({ id: l.product.id, name: l.product.name as LocalizedText, qty: l.quantity, unit: l.product.unit ?? null, image: l.product.image_url ?? null, normal: l.normal, normalLbp: lira(l.product) })),
        normal: v.normal, charged: v.charged, saving: v.saving, lbp: null, normalLbp: null });
    } else if (o.kind === 'discount') {
      const v = saleView<P>(o, byId, fx, 'online', now, now.getDay()); if (!v.product || !(v.ok || v.why === 'item')) continue;
      const p = v.product;
      out.push({ id: o.id, kind: 'discount', offer: o, ok: v.ok, title: o.name as LocalizedText, description: (o.description ?? {}) as LocalizedText, hot: o.is_hot, pct: v.pct,
        pics: [o.image_url || p.image_url].filter(Boolean) as string[],
        lines: [{ id: p.id, name: p.name as LocalizedText, qty: 1, unit: p.unit ?? null, image: p.image_url ?? null, normal: v.normal, normalLbp: v.normalLbp }],
        normal: v.normal, charged: v.price, saving: v.saving, lbp: v.lbp, normalLbp: v.normalLbp, product: p });
    }
  }
  return out;
}
