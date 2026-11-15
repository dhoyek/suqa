-- 66 — Choose the driver while the order is still in the shop (accepted / preparing / ready).
--   order.status { id, status: <unchanged>, driver_id }   assigns / changes the driver without moving the status
--   → event 'order.driver' to the web app, which sends him the order on WhatsApp so he can come for it
--   order.status events now carry 'driver_changed': the app skips the driver message at "out for delivery"
--     when the same driver was already on the order (he has his message)
--   a different driver starts clean: driver_ack_at / driver_picked_at / driver_delivered_at are cleared
--   fix: the 🔔 "notify customer" switch on an order (same status + notify_customer) was not saved — it is now
-- Replaces: suqa._pos_order_status (37), suqa.notify_order_event (21), trigger orders_notify_update (19).
-- No table changes. Requires 37, 52, 53. Idempotent.

-- ---------- order.status (37 + early driver) ---------------------------------------------------------------------------
create or replace function suqa._pos_order_status(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_order suqa.orders; v_m record; v_drv suqa.shop_drivers; v_set boolean := p ? 'driver_id'; v_new uuid; v_changed boolean := false;
begin
  select * into v_order from suqa.orders where id = (p->>'id')::uuid and shop_id = d.shop_id;
  if not found then raise exception 'order_not_found'; end if;
  -- driver assignment ('driver_id' key present: a driver, or null = the shop delivers itself)
  v_new := v_order.driver_id;
  if v_set then
    v_new := nullif(p->>'driver_id', '')::uuid;
    if v_new is not null then
      select * into v_drv from suqa.shop_drivers where id = v_new and shop_id = d.shop_id;
      if v_drv.id is null then raise exception 'driver_not_found'; end if;
      update suqa.shop_drivers set last_used_at = now() where id = v_drv.id;
    end if;
    v_changed := v_new is distinct from v_order.driver_id;
  end if;

  -- same status: only the driver and / or the notify switch change
  if v_order.status::text = p->>'status' then
    if v_changed or (p ? 'notify_customer') then
      update suqa.orders
         set driver_id = v_new,
             courier_name = case when v_set and v_new is not null then v_drv.name else courier_name end,
             driver_ack_at = case when v_changed then null else driver_ack_at end,
             driver_picked_at = case when v_changed then null else driver_picked_at end,
             driver_delivered_at = case when v_changed then null else driver_delivered_at end,
             notify_customer = coalesce((p->>'notify_customer')::boolean, notify_customer)
       where id = v_order.id;
    end if;
    return jsonb_build_object('status', v_order.status, 'noop', true);
  end if;

  -- one UPDATE for status + driver, so the driver is messaged once
  update suqa.orders
     set status = (p->>'status')::suqa.order_status,
         driver_id = v_new,
         courier_name = case when v_set and v_new is not null then v_drv.name else courier_name end,
         driver_ack_at = case when v_changed then null else driver_ack_at end,
         driver_picked_at = case when v_changed then null else driver_picked_at end,
         driver_delivered_at = case when v_changed then null else driver_delivered_at end,
         reject_reason = coalesce(p->>'reject_reason', reject_reason),
         cancel_reason = coalesce(p->>'cancel_reason', cancel_reason),
         shop_notes = coalesce(p->>'shop_notes', shop_notes),
         notify_customer = coalesce((p->>'notify_customer')::boolean, notify_customer),
         eta_minutes = coalesce((p->>'eta_minutes')::int, eta_minutes)
   where id = v_order.id;
  if v_order.channel in ('whatsapp','phone') and (p->>'status') in ('rejected','cancelled') then
    for v_m in select product_id, sum(qty) q from suqa.stock_moves where ref_order_id = v_order.id and kind in ('sale','return') group by product_id having sum(qty) < 0 loop
      insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, ref_order_id, device_id, user_id, note)
      values (gen_random_uuid(), v_order.shop_id, v_order.tenant_id, v_m.product_id, -v_m.q, 'return', v_order.id, d.id, p_user, 'cancelled');
    end loop;
  end if;
  return jsonb_build_object('status', p->>'status');
end $$;

revoke all on function suqa._pos_order_status(suqa.devices, jsonb, uuid) from public, anon, authenticated;

-- ---------- order events (21 + order.driver) ---------------------------------------------------------------------------
create or replace function suqa.notify_order_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_url text; v_secret text; v_event text;
begin
  if new.channel = 'walkin' then return new; end if;
  if tg_op = 'INSERT' then v_event := 'order.created';
  elsif new.status is distinct from old.status then v_event := 'order.status';
  elsif new.driver_id is distinct from old.driver_id and new.driver_id is not null
        and new.status in ('accepted', 'preparing', 'ready', 'out_for_delivery') then v_event := 'order.driver';
  else return new; end if;

  select value into v_url    from suqa.integration_config where key = 'wa_events_url';
  select value into v_secret from suqa.integration_config where key = 'wa_events_secret';
  if v_url is null or v_secret is null then return new; end if;

  perform net.http_post(
    url     := v_url,
    body    := suqa.order_event_payload(new, v_event, case when tg_op = 'UPDATE' then old.status end)
               || jsonb_build_object('channel', new.channel)
               || case when tg_op = 'UPDATE' then jsonb_build_object('driver_changed', new.driver_id is distinct from old.driver_id) else '{}'::jsonb end,
    headers := jsonb_build_object('content-type', 'application/json', 'x-suqa-secret', v_secret),
    timeout_milliseconds := 8000);
  return new;
end $$;

drop trigger if exists orders_notify_update on suqa.orders;
create trigger orders_notify_update
  after update of status, driver_id on suqa.orders
  for each row execute function suqa.notify_order_event();

select 'early driver assignment installed' as result;
