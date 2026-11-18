/**
 * The dollar price the storefront shows and charges for an item.
 * An item the shop priced in LIRA keeps its lira price: its dollars are that price at the MARKET's rate (the same rate the lira
 * on every screen and on the order is worked out with), so a 600,000 L.L. item reads 600,000 L.L. — not the till's own dollar
 * figure converted back at another rate. The database prices order lines the same way (82_lbp_priced_items).
 * Not rounded here: rounding happens once, on the line (quantity × price), so three of them are 1,800,000 and not 1,801,000.
 */
export function usdPrice(p: { price_usd: number | string; price_currency?: string | null; price_lbp?: number | string | null }, fx: number | string | null | undefined): number {
  const lbp = Number(p.price_lbp ?? 0), rate = Number(fx ?? 0);
  return p.price_currency === 'lbp' && lbp > 0 && rate > 0 ? lbp / rate : Number(p.price_usd);
}
