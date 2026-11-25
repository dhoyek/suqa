-- 120: the shop is told when its driver confirms he got the order.
--   Before: driver_ack only wrote the time on the order (the till shows "✓ confirmed" after its next sync) and a history line.
--   Now it also fires the event 'order.driver_ack' (once per order, with the first confirmation only), which the web app turns into
--     · a notification on the shop's devices that have notifications on, and
--     · a WhatsApp message to the shop's WhatsApp number.
--   The customer is not messaged. The order's status does not move. Everything else in the function is as in 52.
--   _wa_post never fails the confirmation: if the message cannot be queued the driver's confirmation still stands.
-- No table change. Safe to run twice.

create or replace function suqa.driver_ack(p_order uuid, p_via text default 'sheet')
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare o suqa.orders; v_driver text;
begin
  select * into o from suqa.orders where id = p_order for update;
  if not found then raise exception 'order_not_found'; end if;
  if o.driver_id is null then raise exception 'no_driver'; end if;
  if o.status not in ('accepted', 'preparing', 'ready', 'out_for_delivery') then
    return jsonb_build_object('ok', false, 'reason', 'closed', 'status', o.status, 'ack_at', o.driver_ack_at);
  end if;
  if o.driver_ack_at is not null then return jsonb_build_object('ok', true, 'already', true, 'ack_at', o.driver_ack_at); end if;
  update suqa.orders set driver_ack_at = now(), updated_at = now() where id = p_order returning * into o;
  select name into v_driver from suqa.shop_drivers where id = o.driver_id;
  insert into suqa.order_events (order_id, tenant_id, actor_kind, note)
  values (p_order, o.tenant_id, 'system', '🛵✅ ' || coalesce(v_driver, '') || ' — ' || case when p_via = 'whatsapp' then 'أكّد عبر واتساب' else 'أكّد استلام الطلب' end);
  -- 120: tell the shop (notification + WhatsApp), once
  perform suqa._wa_post(o.id, o.tenant_id, suqa.order_event_payload(o, 'order.driver_ack', o.status) || jsonb_build_object('channel', o.channel));
  return jsonb_build_object('ok', true, 'ack_at', now(), 'driver', v_driver);
end $function$;
revoke all on function suqa.driver_ack(uuid, text) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function suqa.driver_ack(uuid, text) to service_role; end if;
end $$;
