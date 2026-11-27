-- 127: the driver's pay screen — the customer can also have paid by CARD.
--   Until now the driver could record: cash in dollars / lira (he holds it until he hands it to the shop), Whish / OMT (the customer
--   paid the shop directly), and debt (dayn) for what was not paid. This adds a card payment.
--   WHO HOLDS THE MONEY (unchanged rule, now also for a card):
--     cash                    -> payment 'driver': with the driver, settled when he hands it over.
--     Whish / OMT, card, debt -> payment 'wallet' / 'card' / 'unpaid': the driver holds NOTHING for it. His delivery pay
--                                (orders.courier_fee_cents) stays owed to him by the shop until a settlement, as for every delivery.
--   driver_step      = 81 + pay.card (cents, >= 0): counted in what covers the order, stored as a 'card' payment, in paid_usd_cents.
--                      A screen that sends no card (older version) behaves exactly as before.
--   driver_pay_info  = 81 + 'card_ok': true, so the screen offers the card only where the database takes it.
-- No table change. Safe to run twice.

create or replace function suqa.driver_pay_info(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o suqa.orders; v_step int; v_limit bigint;
begin
  select * into o from suqa.orders where id = p_order;
  if not found then return null; end if;
  select coalesce(lbp_rounding_step, 5000) into v_step from suqa.shops where id = o.shop_id;
  select nullif(credit_limit_cents, 0) into v_limit from suqa.shop_customers where shop_id = o.shop_id and phone_key = suqa._phone_key(o.customer_phone);
  return jsonb_build_object('due_cents', suqa._order_due_cents(o), 'rate', suqa._order_rate(o), 'lbp_step', v_step,
    'card_ok', true,       -- 127: this database takes a card payment from the driver's screen
    'can_debt', length(coalesce(suqa._phone_key(o.customer_phone), '')) >= 6,
    'credit_limit_cents', v_limit, 'debt_cents', case when v_limit is not null then suqa._customer_debt_cents(o.shop_id, o.customer_phone) end);
end $$;

create or replace function suqa.driver_step(p_order uuid, p_step text, p_pay jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o suqa.orders; v_driver text; v_note text; v_due bigint := 0; v_rate numeric; v_step int; v_tol bigint; v_limit bigint;
        v_usd bigint := 0; v_lbp bigint := 0; v_cusd bigint := 0; v_clbp bigint := 0; v_wallet bigint := 0; v_unpaid bigint := 0; v_card bigint := 0;
        v_net_usd bigint; v_net_lbp bigint; v_cash bigint; v_cover bigint;
begin
  if p_step not in ('ack', 'picked', 'delivered') then raise exception 'bad_step'; end if;
  select * into o from suqa.orders where id = p_order for update;
  if not found then raise exception 'order_not_found'; end if;
  if o.driver_id is null then raise exception 'no_driver'; end if;
  if o.status not in ('accepted', 'preparing', 'ready', 'out_for_delivery') then
    return jsonb_build_object('ok', o.status = 'delivered' and p_step = 'delivered', 'already', o.status = 'delivered', 'reason', 'closed', 'status', o.status);
  end if;
  if p_step = 'ack' then return suqa.driver_ack(p_order, 'sheet'); end if;
  if p_step = 'picked' and o.driver_picked_at is not null then return jsonb_build_object('ok', true, 'already', true); end if;
  select name into v_driver from suqa.shop_drivers where id = o.driver_id;

  if p_step = 'picked' then
    update suqa.orders set
      driver_ack_at    = coalesce(driver_ack_at, now()),
      driver_picked_at = coalesce(driver_picked_at, now()),
      -- the bag left the shop with him → on the road (delivery orders only)
      status = case when o.fulfillment = 'delivery' and o.status in ('accepted', 'preparing', 'ready') then 'out_for_delivery'::suqa.order_status else status end,
      updated_at = now()
    where id = p_order;
    insert into suqa.order_events (order_id, tenant_id, actor_kind, note) values (p_order, o.tenant_id, 'system', '📦 ' || coalesce(v_driver, '') || ' — استلم الطلب من المحل');
    return jsonb_build_object('ok', true, 'step', p_step, 'at', now());
  end if;

  -- delivered: final. The money first (so the order is already paid when its status changes), then the status.
  v_due := suqa._order_due_cents(o); v_rate := suqa._order_rate(o);
  if v_due > 0 then
    if p_pay is null or jsonb_typeof(p_pay) <> 'object' then raise exception 'pay_required'; end if;
    v_usd := coalesce((p_pay->>'usd')::bigint, 0); v_lbp := coalesce((p_pay->>'lbp')::bigint, 0);
    v_cusd := coalesce((p_pay->>'change_usd')::bigint, 0); v_clbp := coalesce((p_pay->>'change_lbp')::bigint, 0);
    v_wallet := coalesce((p_pay->>'wallet')::bigint, 0); v_unpaid := coalesce((p_pay->>'unpaid')::bigint, 0); v_card := coalesce((p_pay->>'card')::bigint, 0);
    if least(v_usd, v_lbp, v_cusd, v_clbp, v_wallet, v_unpaid, v_card) < 0 then raise exception 'bad_amount'; end if;
    v_net_usd := v_usd - v_cusd; v_net_lbp := v_lbp - v_clbp;
    v_cash := v_net_usd + round(v_net_lbp * 100.0 / v_rate);
    if v_cash < 0 then raise exception 'bad_amount'; end if;             -- he cannot give back more than he took
    select coalesce(lbp_rounding_step, 5000) into v_step from suqa.shops where id = o.shop_id;
    v_tol := ceil(v_step * 100.0 / v_rate) + 1;                            -- one note of lira: the rounding of a lira payment or change
    v_cover := v_cash + v_wallet + v_card + v_unpaid;
    if v_cover < v_due - 1 then raise exception 'not_covered' using detail = (v_due - v_cover)::text; end if;
    if v_cover > v_due + v_tol then raise exception 'too_much' using detail = (v_cover - v_due)::text; end if;
    if v_unpaid > 0 then
      if length(coalesce(suqa._phone_key(o.customer_phone), '')) < 6 then raise exception 'debt_needs_customer'; end if;
      select nullif(credit_limit_cents, 0) into v_limit from suqa.shop_customers where shop_id = o.shop_id and phone_key = suqa._phone_key(o.customer_phone);
      if v_limit is not null and suqa._customer_debt_cents(o.shop_id, o.customer_phone) + v_unpaid > v_limit then raise exception 'over_credit_limit'; end if;
      insert into suqa.payments (id, order_id, shop_id, tenant_id, tender, amount, currency, unpaid_name, unpaid_phone, note, at)
      values (gen_random_uuid(), o.id, o.shop_id, o.tenant_id, 'unpaid', v_unpaid, 'usd', o.customer_name, o.customer_phone, '🛵 ' || coalesce(v_driver, ''), now());
    end if;
    if v_net_usd <> 0 then insert into suqa.payments (id, order_id, shop_id, tenant_id, tender, amount, currency, note, at) values (gen_random_uuid(), o.id, o.shop_id, o.tenant_id, 'driver', v_net_usd, 'usd', v_driver, now()); end if;
    if v_net_lbp <> 0 then insert into suqa.payments (id, order_id, shop_id, tenant_id, tender, amount, currency, note, at) values (gen_random_uuid(), o.id, o.shop_id, o.tenant_id, 'driver', v_net_lbp, 'lbp', v_driver, now()); end if;
    if v_wallet > 0  then insert into suqa.payments (id, order_id, shop_id, tenant_id, tender, amount, currency, note, at) values (gen_random_uuid(), o.id, o.shop_id, o.tenant_id, 'wallet', v_wallet, 'usd', '🛵 ' || coalesce(v_driver, ''), now()); end if;
    -- 127: paid by card — like Whish it went to the shop, the driver holds nothing
    if v_card > 0    then insert into suqa.payments (id, order_id, shop_id, tenant_id, tender, amount, currency, note, at) values (gen_random_uuid(), o.id, o.shop_id, o.tenant_id, 'card', v_card, 'usd', '🛵 ' || coalesce(v_driver, ''), now()); end if;
  end if;
  update suqa.orders set
    driver_ack_at       = coalesce(driver_ack_at, now()),
    driver_picked_at    = coalesce(driver_picked_at, now()),
    driver_delivered_at = coalesce(driver_delivered_at, now()),
    paid_usd_cents      = coalesce(paid_usd_cents, 0) + coalesce(v_net_usd, 0) + v_wallet + v_card,
    paid_lbp            = coalesce(paid_lbp, 0) + coalesce(v_net_lbp, 0),
    total_cents         = coalesce(total_cents, round(coalesce(total_usd, 0) * 100)::int),
    status = 'delivered',
    updated_at = now()
  where id = p_order;
  v_note := '🏠 ' || coalesce(v_driver, '') || ' — سلّم الطلب للزبون'
            || case when v_due = 0 then ' (مدفوع مسبقاً)' else '' end
            || case when coalesce(v_net_usd, 0) <> 0 or coalesce(v_net_lbp, 0) <> 0 then ' · نقد معه: '
                    || concat_ws(' + ', case when v_net_usd <> 0 then to_char(v_net_usd / 100.0, 'FM999990.00') || '$' end, case when v_net_lbp <> 0 then to_char(v_net_lbp, 'FM999,999,990') || ' ل.ل.' end) else '' end
            || case when v_wallet > 0 then ' · Whish / OMT ' || to_char(v_wallet / 100.0, 'FM999990.00') || '$' else '' end
            || case when v_card > 0 then ' · بطاقة ' || to_char(v_card / 100.0, 'FM999990.00') || '$' else '' end
            || case when v_unpaid > 0 then ' · دين ' || to_char(v_unpaid / 100.0, 'FM999990.00') || '$' else '' end;
  insert into suqa.order_events (order_id, tenant_id, actor_kind, note) values (p_order, o.tenant_id, 'system', v_note);
  return jsonb_build_object('ok', true, 'step', p_step, 'at', now(), 'cash_usd_cents', coalesce(v_net_usd, 0), 'cash_lbp', coalesce(v_net_lbp, 0), 'wallet_cents', v_wallet, 'card_cents', v_card, 'unpaid_cents', v_unpaid);
end $$;

revoke all on function suqa.driver_step(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function suqa.driver_pay_info(uuid) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function suqa.driver_step(uuid, text, jsonb) to service_role;
    grant execute on function suqa.driver_pay_info(uuid) to service_role;
  end if;
end $$;
