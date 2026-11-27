-- 128 — an edited order keeps its lira total.
--
-- _order_recalc (24) re-totals an order after its lines were edited (24 / 57), after a merge (65) and after its delivery fee
-- changed (80). It rebuilt the lira total from dollar cents, so an order of lira-priced items lost its own lira figure the
-- moment it was touched (221,760 L.L. → 249 cents → 222,855 or 221,610 depending on the rate).
--
-- Now, like the till since 28 Nov (pos-core `totals`): lira-priced lines are added up IN LIRA and only that sum is turned
-- into cents; dollar lines, the order discount and the delivery fee are converted at the order's rate.
--   L        = Σ round(unit_price_lbp × quantity)  over live lira-priced lines
--   subtotal = Σ line cents, with the lira lines' share replaced by round(L × 100 / rate)
--   total_lbp = L + round((total_cents − round(L × 100 / rate)) × rate / 100)
-- This applies only when the lira lines' stored cents agree with their lira prices up to rounding (half a cent per unit
-- + one per line). Otherwise — an order whose cents were set on another basis — everything is computed as before (24).
-- An order with no lira-priced line is computed exactly as before.
--
-- No table change. Same owner, same grants (server only).

create or replace function suqa._order_recalc(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_sub int; v_o suqa.orders; v_rate numeric; v_l bigint; v_lc int; v_stored int; v_tol numeric; v_native boolean := false;
        v_disc int; v_fee int; v_total int;
begin
  select * into v_o from suqa.orders where id = p_order;
  select coalesce(sum(coalesce(line_total_cents, round(line_total_usd * 100)::int)), 0) into v_sub from suqa.order_items where order_id = p_order and not voided;
  v_rate := coalesce(v_o.rate_lbp_per_usd, v_o.fx_lbp_rate::int);

  if coalesce(v_rate, 0) > 0 then
    select coalesce(sum(round(unit_price_lbp * quantity)), 0)::bigint,
           coalesce(sum(coalesce(line_total_cents, 0) + coalesce(discount_cents, 0)), 0)::int,
           coalesce(sum(0.5 * quantity + 1), 0)
      into v_l, v_stored, v_tol
      from suqa.order_items
     where order_id = p_order and not voided and price_currency = 'lbp' and coalesce(unit_price_lbp, 0) > 0
       and coalesce(line_total_cents, 0) > 0;                       -- a line eaten whole by its discount keeps its plain amount
    if v_l > 0 then
      v_lc := round(v_l * 100.0 / v_rate)::int;
      v_native := abs(v_lc - v_stored) <= v_tol;
    end if;
  end if;

  if v_native then v_sub := greatest(0, v_sub + v_lc - v_stored); end if;
  v_disc  := least(coalesce(v_o.discount_cents, 0), v_sub);
  v_fee   := round(coalesce(v_o.delivery_fee_usd, 0) * 100)::int;
  v_total := v_sub - v_disc + v_fee;

  update suqa.orders set
    subtotal_cents = v_sub, subtotal_usd = v_sub / 100.0,
    discount_cents = v_disc,
    total_cents = v_total,
    total_usd = (v_sub - v_disc) / 100.0 + coalesce(delivery_fee_usd, 0),
    total_lbp = case when v_native then greatest(0, v_l + round((v_total - v_lc) * v_rate / 100.0))
                     else round(((v_sub - v_disc) / 100.0 + coalesce(delivery_fee_usd, 0)) * v_rate) end,
    commission_usd = round(((v_sub - v_disc) / 100.0) * coalesce(commission_rate, 0), 2)
  where id = p_order;
end $$;

revoke all on function suqa._order_recalc(uuid) from public, anon, authenticated;
grant execute on function suqa._order_recalc(uuid) to service_role;
