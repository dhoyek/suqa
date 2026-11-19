-- 83_online_order_cents.sql — online orders carry cents, the rate and the lira total like every other order.   (2026-11-19)
--
-- WHY: an order placed on the storefront (_place_shop_order) was saved in dollars only: subtotal_usd / total_usd / fx_lbp_rate,
-- with total_cents, subtotal_cents, total_lbp, rate_lbp_per_usd and every line's cents left empty. Everything else in the
-- system (POS, reports, debts, drivers, the receipt page, the WhatsApp receipt) reads cents. Each reader had to rebuild them,
-- and the ones that did not showed $0.00 / "paid" / $1 = 0 (HS-000020 in the POS, HS-000030 on the receipt page).
--
-- NOW:
--   * orders_fill_cents       BEFORE INSERT on orders — when an order arrives with dollars but no cents:
--                               total_cents    = total_usd × 100
--                               subtotal_cents = subtotal_usd × 100            discount_cents = 0
--                               rate_lbp_per_usd = the market rate the order was priced at (fx_lbp_rate)
--                               total_lbp      = total_usd × rate, rounded to 1,000 — the lira the customer was shown
--   * order_items_fill_cents  BEFORE INSERT on order_items — unit_price_cents / line_total_cents from the line's dollars.
--     Both only fill what is EMPTY: a POS order (which always sends its own cents and rate) is never touched.
--   * a one-time fill of the online orders already saved (15 orders / 31 lines on prod, 2026-11-19), same rules.
--     The sync log picks the filled rows up, so every till receives the corrected orders on its next sync.
--
-- Money already recorded (payments, paid amounts, driver cash, shifts) is not touched: only the empty cents of an order's own
-- total and lines are written, from the dollars the customer agreed to. No table changes. Requires 82. Idempotent.

create or replace function suqa.orders_fill_cents() returns trigger
language plpgsql as $$
declare v_rate numeric := coalesce(nullif(new.rate_lbp_per_usd, 0), nullif(new.fx_lbp_rate, 0));
begin
  if new.rate_lbp_per_usd is null and v_rate is not null then new.rate_lbp_per_usd := round(v_rate); end if;
  if new.total_cents is null and new.total_usd is not null then
    new.total_cents    := round(new.total_usd * 100);
    new.subtotal_cents := coalesce(new.subtotal_cents, round(coalesce(new.subtotal_usd, new.total_usd - coalesce(new.delivery_fee_usd, 0)) * 100));
    new.discount_cents := coalesce(new.discount_cents, 0);
    if new.total_lbp is null and v_rate is not null then new.total_lbp := round(new.total_usd * v_rate / 1000) * 1000; end if;
  end if;
  return new;
end $$;

create or replace function suqa.order_items_fill_cents() returns trigger
language plpgsql as $$
begin
  if new.line_total_cents is null and new.line_total_usd is not null then
    new.line_total_cents := round(new.line_total_usd * 100);
    new.unit_price_cents := coalesce(new.unit_price_cents, round(coalesce(new.unit_price_usd, 0) * 100));
    new.discount_cents   := coalesce(new.discount_cents, 0);
  end if;
  return new;
end $$;
revoke all on function suqa.orders_fill_cents() from public, anon, authenticated;
revoke all on function suqa.order_items_fill_cents() from public, anon, authenticated;

-- "_1_" so they run after the existing "_0_" before-insert triggers (alphabetical order)
drop trigger if exists orders_1_fill_cents on suqa.orders;
create trigger orders_1_fill_cents before insert on suqa.orders for each row execute function suqa.orders_fill_cents();
drop trigger if exists order_items_1_fill_cents on suqa.order_items;
create trigger order_items_1_fill_cents before insert on suqa.order_items for each row execute function suqa.order_items_fill_cents();

-- ---------- one-time fill of the orders already saved ------------------------------------------------------------------
update suqa.order_items
   set line_total_cents = round(line_total_usd * 100),
       unit_price_cents = coalesce(unit_price_cents, round(coalesce(unit_price_usd, 0) * 100)),
       discount_cents   = coalesce(discount_cents, 0)
 where line_total_cents is null and line_total_usd is not null;

update suqa.orders o
   set rate_lbp_per_usd = coalesce(o.rate_lbp_per_usd, round(coalesce(nullif(o.fx_lbp_rate, 0), t.fx_lbp_rate))),
       total_cents      = coalesce(o.total_cents, round(o.total_usd * 100)),
       subtotal_cents   = coalesce(o.subtotal_cents, round(coalesce(o.subtotal_usd, o.total_usd - coalesce(o.delivery_fee_usd, 0)) * 100)),
       discount_cents   = coalesce(o.discount_cents, 0),
       total_lbp        = coalesce(o.total_lbp, round(o.total_usd * coalesce(nullif(o.fx_lbp_rate, 0), t.fx_lbp_rate) / 1000) * 1000)
  from suqa.tenants t
 where t.id = o.tenant_id and o.total_usd is not null
   and (o.total_cents is null or o.rate_lbp_per_usd is null or o.total_lbp is null);

select 'online order cents installed' as result,
       (select count(*) from suqa.orders where total_cents is null) as orders_still_without_cents,
       (select count(*) from suqa.order_items where line_total_cents is null) as lines_still_without_cents;
