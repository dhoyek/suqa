-- 82_lbp_priced_items.sql — an item the shop priced in lira is charged at its own lira price.   (2026-11-18)
--
-- An online order is kept in dollars and its lira is shown at the market's rate (tenants.fx_lbp_rate). A shop that prices an item
-- in lira (products.price_currency = 'lbp', price_lbp) also carries a dollar figure the till worked out at ITS rate. With two
-- rates the customer saw — and was charged — the till's dollars turned back into lira at the market's rate:
--   600,000 L.L. ÷ 89,500 = $6.70 → × 90,000 = 603,000 L.L.   (3,000 more than the shop's price)
-- Now a lira-priced line is  round(quantity × price_lbp ÷ market rate, 2)  dollars, so its lira comes back as quantity × price_lbp
-- (600,000 → $6.67 → 600,000; three of them $20.00 → 1,800,000). Dollar-priced items are unchanged.
--
--   _line_usd(product, quantity, rate)   the dollars of one order line
--   _unit_usd(product, rate)             the unit price kept on the line (2 decimals)
--   _place_shop_order                    today's definition with the two places that priced a line going through the helpers
--                                        (the minimum-order check and the order total use the same figure as the lines)
-- No table changes. The storefront shows the same figure (apps/web/lib/price.ts). Requires 69. Idempotent.

create or replace function suqa._line_usd(p suqa.products, p_qty numeric, p_fx numeric) returns numeric
language sql immutable as $$
  select case when p.price_currency = 'lbp' and coalesce(p.price_lbp, 0) > 0 and coalesce(p_fx, 0) > 0
              then round(p.price_lbp * p_qty / p_fx, 2)
              else round(p.price_usd * p_qty, 2) end
$$;
create or replace function suqa._unit_usd(p suqa.products, p_fx numeric) returns numeric
language sql immutable as $$
  select case when p.price_currency = 'lbp' and coalesce(p.price_lbp, 0) > 0 and coalesce(p_fx, 0) > 0
              then round(p.price_lbp / p_fx, 2)
              else p.price_usd end
$$;
revoke all on function suqa._line_usd(suqa.products, numeric, numeric) from public, anon, authenticated;
revoke all on function suqa._unit_usd(suqa.products, numeric) from public, anon, authenticated;

do $$
declare v_def text; v_oid oid;
        a1 text := 'v_sub := v_sub + round(v_prod.price_usd * v_qty, 2);';
        b1 text := 'v_sub := v_sub + suqa._line_usd(v_prod, v_qty, p_tenant.fx_lbp_rate);   -- 82: a lira-priced item at its own lira price';
        a2 text := 'v_prod.price_usd, v_qty, round(v_prod.price_usd * v_qty, 2), v_item->>''notes'');';
        b2 text := 'suqa._unit_usd(v_prod, p_tenant.fx_lbp_rate), v_qty, suqa._line_usd(v_prod, v_qty, p_tenant.fx_lbp_rate), v_item->>''notes'');';
begin
  select oid into v_oid from pg_proc where pronamespace = 'suqa'::regnamespace and proname = '_place_shop_order';
  v_def := pg_get_functiondef(v_oid);
  if position('_line_usd' in v_def) > 0 then return; end if;
  if position(a1 in v_def) = 0 or position(a2 in v_def) = 0 then raise exception '_place_shop_order: anchor not found'; end if;
  execute replace(replace(v_def, a1, b1), a2, b2);
end $$;

select 'lira-priced items installed' as result;
