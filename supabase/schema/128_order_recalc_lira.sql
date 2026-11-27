-- 128 — an edited order keeps its lira prices and its lira total.
--
-- _order_recalc (24) re-totals an order after its lines were edited (24 / 57), after a merge (65) and after its delivery fee
-- changed (80). Two things were wrong for lira-priced items:
--   a. it rebuilt the lira total from dollar cents, so the order lost its own lira figure the moment it was touched;
--   b. the edit functions re-price a changed line from its stored DOLLAR unit price (the item's dollar price at the
--      association's rate), not from its lira price at the order's rate — changing a quantity moved the price basis
--      (740,880 L.L. at 89,500 = $8.28 at the till, $8.23 after an edit).
--
-- Now, like the till since 28 Nov (pos-core `totals`, `orderRetotal`): a lira-priced line is worth its lira.
--   line cents = round(round(unit_price_lbp × quantity) × 100 / rate) − line discount          (written back on the line)
--   L          = Σ round(unit_price_lbp × quantity)  over live lira-priced lines
--   subtotal   = Σ line cents, with the lira lines' share replaced by round(L × 100 / rate)
--   total_lbp  = L + round((total_cents − round(L × 100 / rate)) × rate / 100)
-- so the lira total of lira-priced items is the exact sum of their prices; dollar lines, the order discount and the
-- delivery fee are converted at the order's rate. An order with no lira-priced line is computed exactly as before.
-- Lira-priced lines exist only on orders made at the till (online orders carry dollar lines).
--
-- No table change. Same owner, same grants (server only).

create or replace function suqa._order_recalc(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_sub int; v_o suqa.orders; v_rate numeric; v_l bigint := 0; v_lc int := 0; v_per int := 0;
        v_disc int; v_fee int; v_total int;
begin
  select * into v_o from suqa.orders where id = p_order;
  v_rate := coalesce(v_o.rate_lbp_per_usd, v_o.fx_lbp_rate::int);

  if coalesce(v_rate, 0) > 0 then
    -- a lira-priced line is worth its lira at the order's rate
    update suqa.order_items i
       set line_total_cents = x.c, line_total_usd = x.c / 100.0
      from (select id, greatest(0, round(round(unit_price_lbp * quantity) * 100.0 / v_rate)::int - coalesce(discount_cents, 0)) as c
              from suqa.order_items
             where order_id = p_order and not voided and price_currency = 'lbp' and coalesce(unit_price_lbp, 0) > 0) x
     where i.id = x.id and i.line_total_cents is distinct from x.c;

    select coalesce(sum(round(unit_price_lbp * quantity)), 0)::bigint,
           coalesce(sum(line_total_cents + coalesce(discount_cents, 0)), 0)::int
      into v_l, v_per
      from suqa.order_items
     where order_id = p_order and not voided and price_currency = 'lbp' and coalesce(unit_price_lbp, 0) > 0
       and line_total_cents > 0;                                     -- a line eaten whole by its discount keeps its plain amount
    if v_l > 0 then v_lc := round(v_l * 100.0 / v_rate)::int; end if;
  end if;

  select coalesce(sum(coalesce(line_total_cents, round(line_total_usd * 100)::int)), 0) into v_sub from suqa.order_items where order_id = p_order and not voided;
  if v_l > 0 then v_sub := greatest(0, v_sub + v_lc - v_per); end if;
  v_disc  := least(coalesce(v_o.discount_cents, 0), v_sub);
  v_fee   := round(coalesce(v_o.delivery_fee_usd, 0) * 100)::int;
  v_total := v_sub - v_disc + v_fee;

  update suqa.orders set
    subtotal_cents = v_sub, subtotal_usd = v_sub / 100.0,
    discount_cents = v_disc,
    total_cents = v_total,
    total_usd = (v_sub - v_disc) / 100.0 + coalesce(delivery_fee_usd, 0),
    total_lbp = case when v_l > 0 then greatest(0, v_l + round((v_total - v_lc) * v_rate / 100.0))
                     else round(((v_sub - v_disc) / 100.0 + coalesce(delivery_fee_usd, 0)) * v_rate) end,
    commission_usd = round(((v_sub - v_disc) / 100.0) * coalesce(commission_rate, 0), 2)
  where id = p_order;
end $$;

revoke all on function suqa._order_recalc(uuid) from public, anon, authenticated;
grant execute on function suqa._order_recalc(uuid) to service_role;
