-- 129 — the till takes the money of an order that was saved as debt: the debt is paid, not doubled.
--
-- An order can be saved "unpaid" at the till (a debt line on the order) before it is handed over. When the money is then taken
-- at handover (Orders → collect payment), `_pos_order_pay` (24 / 25 / 81) added the new payment NEXT to the debt line and left
-- the debt open: the drawer had the money and the customer still owed it. 127 fixed the same thing on the driver's screen.
--
-- Now, as in 127:
--   · money taken now (cash, card, wallet — net of the change given back) comes off the order's open debt first
--     (what was already collected against it through the Debts screen stays collected);
--   · "still not paid" at handover adds only the part of the debt that is not already on the order.
-- A payment row is written once (same id = nothing happens, as before), and the debt is touched only when this call wrote a row.
--
-- No table change. Everything else in the function is 81 unchanged.

create or replace function suqa._pos_order_pay(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_o suqa.orders; v_l jsonb; v_status suqa.order_status; v_rate numeric; v_new int := 0; v_n int;
        v_money bigint := 0; v_change bigint := 0; v_debt bigint := 0; v_left bigint; v_val bigint; v_take bigint; v_amt bigint; r suqa.payments;
begin
  select * into v_o from suqa.orders where id = (p->>'id')::uuid and shop_id = d.shop_id;
  if not found then raise exception 'order_not_found'; end if;
  v_rate := coalesce(nullif(v_o.rate_lbp_per_usd, 0), nullif(v_o.fx_lbp_rate, 0), 89500);

  -- the order's debt still open before this payment (its debt lines less what was collected against them)
  select greatest(0, coalesce(sum(case when pm.currency = 'lbp' then round(pm.amount * 100.0 / v_rate) else pm.amount end), 0)
                     - coalesce((select sum(a.amount_cents) from suqa.debt_allocations a where a.order_id = v_o.id), 0))
    into v_debt from suqa.payments pm where pm.order_id = v_o.id and pm.tender = 'unpaid' and pm.amount > 0;

  -- money taken now, written once
  for v_l in select * from jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) loop
    continue when v_l->>'tender' = 'unpaid';
    insert into suqa.payments (id, order_id, shop_id, tenant_id, tender, amount, currency, reference, unpaid_name, unpaid_phone, note, at)
    values ((v_l->>'id')::uuid, v_o.id, d.shop_id, d.tenant_id, v_l->>'tender', (v_l->>'amount')::bigint, v_l->>'currency', v_l->>'reference', v_l->>'unpaid_name', v_l->>'unpaid_phone', v_l->>'note', coalesce((v_l->>'at')::timestamptz, now()))
    on conflict (id) do nothing;
    get diagnostics v_n = row_count;
    if v_n > 0 then
      v_new := v_new + 1;
      v_money := v_money + case when v_l->>'currency' = 'lbp' then round((v_l->>'amount')::bigint * 100.0 / v_rate) else (v_l->>'amount')::bigint end;
    end if;
  end loop;

  -- that money pays the order's own debt first
  if v_new > 0 and v_debt > 0 then
    v_change := coalesce((p->>'change_usd_cents')::bigint, 0) + round(coalesce((p->>'change_lbp')::bigint, 0) * 100.0 / v_rate);
    v_left := least(v_debt, greatest(0, v_money - v_change));
    v_debt := v_debt - v_left;
    for r in select * from suqa.payments where order_id = v_o.id and tender = 'unpaid' and amount > 0 order by at desc for update loop
      exit when v_left <= 0;
      v_val := case when r.currency = 'lbp' then round(r.amount * 100.0 / v_rate) else r.amount end;
      v_take := least(v_left, v_val);
      update suqa.payments set amount = case when v_take >= v_val then 0 when r.currency = 'lbp' then r.amount - round(v_take * v_rate / 100.0) else r.amount - v_take end,
             note = concat_ws(' · ', nullif(note, ''), 'دُفع عند التسليم'), updated_at = now() where id = r.id;
      v_left := v_left - v_take;
    end loop;
  end if;

  -- "still not paid" at handover: only the part that is not already a debt on this order
  for v_l in select * from jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) loop
    continue when v_l->>'tender' <> 'unpaid';
    continue when exists (select 1 from suqa.payments where id = (v_l->>'id')::uuid);
    v_val := case when v_l->>'currency' = 'lbp' then round((v_l->>'amount')::bigint * 100.0 / v_rate) else (v_l->>'amount')::bigint end;
    v_take := least(v_debt, v_val);                 -- already on the order
    v_debt := v_debt - v_take;
    v_amt := case when v_take <= 0 then (v_l->>'amount')::bigint
                  when v_take >= v_val then 0
                  when v_l->>'currency' = 'lbp' then (v_l->>'amount')::bigint - round(v_take * v_rate / 100.0)
                  else (v_l->>'amount')::bigint - v_take end;
    insert into suqa.payments (id, order_id, shop_id, tenant_id, tender, amount, currency, reference, unpaid_name, unpaid_phone, note, at)
    values ((v_l->>'id')::uuid, v_o.id, d.shop_id, d.tenant_id, 'unpaid', v_amt, v_l->>'currency', v_l->>'reference', v_l->>'unpaid_name', v_l->>'unpaid_phone', v_l->>'note', coalesce((v_l->>'at')::timestamptz, now()))
    on conflict (id) do nothing;
  end loop;

  v_status := coalesce(p->>'status', 'delivered')::suqa.order_status;
  update suqa.orders set
    paid_usd_cents = coalesce((p->>'paid_usd_cents')::int, paid_usd_cents), paid_lbp = coalesce((p->>'paid_lbp')::bigint, paid_lbp),
    change_usd_cents = coalesce((p->>'change_usd_cents')::int, change_usd_cents), change_lbp = coalesce((p->>'change_lbp')::bigint, change_lbp),
    courier_fee_cents = coalesce((p->>'courier_fee_cents')::int, courier_fee_cents), courier_name = coalesce(nullif(p->>'courier_name', ''), courier_name),
    shift_id = coalesce(nullif(p->>'shift_id', '')::uuid, shift_id), device_id = coalesce(device_id, d.id), staff_user_id = coalesce(staff_user_id, p_user),
    status = case when status <> v_status and suqa.order_transition_allowed(status, v_status) then v_status else status end,
    delivered_at = case when v_status = 'delivered' then coalesce(delivered_at, now()) else delivered_at end,
    closed_at = case when v_status = 'delivered' then coalesce(closed_at, now()) else closed_at end
  where id = v_o.id;
  perform suqa._driver_cash_absorb(v_o.id);   -- 81
  return jsonb_build_object('ok', true);
end $$;
