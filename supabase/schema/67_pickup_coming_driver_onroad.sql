-- 67 — The driver's "picked up" tap puts the order on the road; a pickup customer can say "I'm coming".
--   suqa.driver_step(order, 'picked')   also moves the order to out_for_delivery when it is still accepted / preparing / ready
--                                       (the status change messages the customer as usual; the driver is not messaged again — 66)
--   orders.customer_coming_at           when the pickup customer tapped "I'm on my way" on his order page
--   suqa.customer_coming(order)         records it once (pickup orders, accepted / preparing / ready), adds an order event and
--                                       fires event 'order.coming' so the web app tells the shop on WhatsApp.
--                                       The order STATUS does not move: the bag is still in the shop until handover.
-- Service key only (called by /api/d/<id>/step and /api/r/<id>/coming). Base file 06 lists customer_coming_at.
-- Requires 53, 66. Idempotent.

alter table suqa.orders add column if not exists customer_coming_at timestamptz;

-- ---------- driver steps (53 + on the road at pickup) ------------------------------------------------------------------
create or replace function suqa.driver_step(p_order uuid, p_step text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o suqa.orders; v_driver text; v_note text;
begin
  if p_step not in ('ack', 'picked', 'delivered') then raise exception 'bad_step'; end if;
  select * into o from suqa.orders where id = p_order for update;
  if not found then raise exception 'order_not_found'; end if;
  if o.driver_id is null then raise exception 'no_driver'; end if;
  if o.status not in ('accepted', 'preparing', 'ready', 'out_for_delivery') then
    return jsonb_build_object('ok', false, 'reason', 'closed', 'status', o.status);
  end if;
  if p_step = 'ack' then return suqa.driver_ack(p_order, 'sheet'); end if;
  if (p_step = 'picked' and o.driver_picked_at is not null) or (p_step = 'delivered' and o.driver_delivered_at is not null) then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  update suqa.orders set
    driver_ack_at       = coalesce(driver_ack_at, now()),
    driver_picked_at    = coalesce(driver_picked_at, now()),
    driver_delivered_at = case when p_step = 'delivered' then now() else driver_delivered_at end,
    -- the bag left the shop with him → on the road (delivery orders only; the shop still marks "delivered" and takes the cash)
    status = case when o.fulfillment = 'delivery' and o.status in ('accepted', 'preparing', 'ready') then 'out_for_delivery'::suqa.order_status else status end,
    updated_at = now()
  where id = p_order;
  select name into v_driver from suqa.shop_drivers where id = o.driver_id;
  v_note := case p_step when 'picked' then '📦 ' || coalesce(v_driver, '') || ' — استلم الطلب من المحل'
                        else '🏠 ' || coalesce(v_driver, '') || ' — سلّم الطلب للزبون (بانتظار تسجيل الدفع)' end;
  insert into suqa.order_events (order_id, tenant_id, actor_kind, note) values (p_order, o.tenant_id, 'system', v_note);
  return jsonb_build_object('ok', true, 'step', p_step, 'at', now());
end $$;

-- ---------- pickup customer: "I'm on my way" ---------------------------------------------------------------------------
create or replace function suqa.customer_coming(p_order uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o suqa.orders; v_url text; v_secret text;
begin
  select * into o from suqa.orders where id = p_order for update;
  if not found then raise exception 'order_not_found'; end if;
  if o.fulfillment <> 'pickup' or o.channel = 'walkin' or o.status not in ('accepted', 'preparing', 'ready') then
    return jsonb_build_object('ok', false, 'reason', 'closed', 'status', o.status);
  end if;
  if o.customer_coming_at is not null then return jsonb_build_object('ok', true, 'already', true, 'at', o.customer_coming_at); end if;
  update suqa.orders set customer_coming_at = now(), updated_at = now() where id = p_order returning * into o;
  insert into suqa.order_events (order_id, tenant_id, actor_kind, note)
  values (p_order, o.tenant_id, 'system', '🚶 ' || coalesce(nullif(o.customer_name, ''), 'الزبون') || ' — في الطريق لاستلام الطلب');
  select value into v_url    from suqa.integration_config where key = 'wa_events_url';
  select value into v_secret from suqa.integration_config where key = 'wa_events_secret';
  if v_url is not null and v_secret is not null then
    perform net.http_post(
      url     := v_url,
      body    := suqa.order_event_payload(o, 'order.coming', o.status) || jsonb_build_object('channel', o.channel),
      headers := jsonb_build_object('content-type', 'application/json', 'x-suqa-secret', v_secret),
      timeout_milliseconds := 8000);
  end if;
  return jsonb_build_object('ok', true, 'at', o.customer_coming_at);
end $$;

revoke all on function suqa.driver_step(uuid, text) from public, anon, authenticated;
revoke all on function suqa.customer_coming(uuid) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function suqa.driver_step(uuid, text) to service_role;
    grant execute on function suqa.customer_coming(uuid) to service_role;
  end if;
end $$;

select 'pickup coming + driver on the road installed' as result;
