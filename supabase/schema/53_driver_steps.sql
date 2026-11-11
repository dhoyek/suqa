-- 53_driver_steps.sql — the driver's next taps on his sheet after "✅ استلمت الطلب":   (2026-11-11)
--   📦 "استلمت من المحل"  → orders.driver_picked_at   (bag left the shop with him)
--   🏠 "سلّمت الطلب"       → orders.driver_delivered_at (handed to the customer)
-- They only record times + an order event; the order STATUS and any payment stay with the shop (it marks "delivered" and records the
-- cash when the driver comes back), so nothing is counted twice. Each step implies the earlier ones (a "delivered" tap also fills
-- ack/picked when he skipped them). Same access as 52: service key only, called by /api/d/<id>/step.
-- Base file 06 lists driver_delivered_at. Requires 52. Idempotent.

alter table suqa.orders add column if not exists driver_delivered_at timestamptz;

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
    updated_at = now()
  where id = p_order;
  select name into v_driver from suqa.shop_drivers where id = o.driver_id;
  v_note := case p_step when 'picked' then '📦 ' || coalesce(v_driver, '') || ' — استلم الطلب من المحل'
                        else '🏠 ' || coalesce(v_driver, '') || ' — سلّم الطلب للزبون (بانتظار تسجيل الدفع)' end;
  insert into suqa.order_events (order_id, tenant_id, actor_kind, note) values (p_order, o.tenant_id, 'system', v_note);
  return jsonb_build_object('ok', true, 'step', p_step, 'at', now());
end $$;

revoke all on function suqa.driver_step(uuid, text) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function suqa.driver_step(uuid, text) to service_role;
  end if;
end $$;

select 'driver steps installed' as result;
