-- 109: move an order BACK to an earlier stage after a wrong tap.
--   Stages, in order: pending → accepted → preparing → ready → out_for_delivery → delivered. Forward moves are unchanged.
--   A step back is a new till operation, 'order.back' (owner; a cashier with the owner's approval), handled by _pos_order_back:
--     · only to an EARLIER stage of an order that is not cancelled or rejected (those are not reopened), and not a counter sale;
--     · "pending" only for an online order; "out_for_delivery" never for a pickup;
--     · from "delivered" only when nothing would be counted twice: no payment left on the order (cancel it first from the operations
--       log), no return, and the driver not already paid for it;
--     · the customer is NOT messaged about a step back; the next forward step messages as usual;
--     · stock is not touched: an online order's stock is taken once (the existing check), so going forward again takes nothing more.
--   The step is written in order_events (note 'step back') and in the audit log like every till operation.
-- No table change. Safe to run twice.

create or replace function suqa.order_stage(s suqa.order_status) returns int language sql immutable as $$
  select case s when 'pending' then 0 when 'accepted' then 1 when 'preparing' then 2 when 'ready' then 3 when 'out_for_delivery' then 4 when 'delivered' then 5 end
$$;

-- the same trigger function as today, plus: a step back announced by _pos_order_back is allowed, and its dates are cleared
create or replace function suqa.orders_on_status_change()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_actor suqa.actor_kind; v_received boolean := coalesce(current_setting('suqa.customer_received', true), '') = new.id::text;
        v_back boolean := coalesce(current_setting('suqa.step_back', true), '') = new.id::text
                          and suqa.order_stage(new.status) is not null and suqa.order_stage(old.status) is not null
                          and suqa.order_stage(new.status) < suqa.order_stage(old.status);
begin
  if new.status = old.status then return new; end if;

  if not v_back and not suqa.order_transition_allowed(old.status, new.status) then
    raise exception 'order %: transition % → % not allowed', old.number, old.status, new.status
      using errcode = 'check_violation';
  end if;

  v_actor := case
    when suqa.is_platform_admin()             then 'platform'
    when suqa.is_tenant_member(new.tenant_id) then 'tenant'
    when suqa.is_shop_member(new.shop_id)     then 'shop'
    when suqa.is_courier(new.tenant_id)       then 'courier'
    when auth.uid() = new.customer_id         then 'customer'
    else 'system' end;

  if v_actor = 'customer' and not ((old.status = 'pending' and new.status = 'cancelled') or (new.status = 'delivered' and v_received)) then
    raise exception 'customers can only cancel a pending order' using errcode = 'insufficient_privilege';
  end if;

  if v_back then
    -- the order is open again: what the later stages stamped is cleared, so going forward stamps the real time
    if old.status = 'delivered' then new.delivered_at = null; new.closed_at = null; end if;
    if suqa.order_stage(new.status) < 4 then new.picked_up_at = null; end if;
    if new.status = 'pending' then new.accepted_at = null; end if;
  else
    if new.status = 'accepted'         then new.accepted_at  = coalesce(new.accepted_at, now()); end if;
    if new.status = 'out_for_delivery' then new.picked_up_at = coalesce(new.picked_up_at, now()); end if;
    if new.status = 'delivered'        then new.delivered_at = coalesce(new.delivered_at, now()); end if;
    if new.status in ('delivered','rejected','cancelled') then new.closed_at = coalesce(new.closed_at, now()); end if;
  end if;

  insert into suqa.order_events(order_id, tenant_id, from_status, to_status, actor_kind, actor_id, note)
  values (new.id, new.tenant_id, old.status, new.status, v_actor, auth.uid(),
          case when v_back then 'step back'
               when new.status = 'rejected' then new.reject_reason
               when v_received then 'confirmed by the customer'
               when new.status = 'cancelled' and new.cancel_reason is not null then new.cancel_reason end);
  return new;
end $function$;

-- the same as today, plus: nobody is messaged about a step back
create or replace function suqa.notify_order_event()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_event text;
begin
  if new.channel = 'walkin' then return new; end if;
  if tg_op = 'UPDATE' and coalesce(current_setting('suqa.step_back', true), '') = new.id::text then return new; end if;
  if tg_op = 'INSERT' then v_event := 'order.created';
  elsif new.status is distinct from old.status then v_event := 'order.status';
  elsif new.driver_id is distinct from old.driver_id and new.driver_id is not null
        and new.status in ('accepted', 'preparing', 'ready', 'out_for_delivery') then v_event := 'order.driver';
  else return new; end if;

  perform suqa._wa_post(new.id, new.tenant_id,
    suqa.order_event_payload(new, v_event, case when tg_op = 'UPDATE' then old.status end)
      || jsonb_build_object('channel', new.channel)
      || case when tg_op = 'UPDATE' then jsonb_build_object('driver_changed', new.driver_id is distinct from old.driver_id) else '{}'::jsonb end);
  return new;
end $function$;

create or replace function suqa._pos_order_back(d suqa.devices, p jsonb, p_user uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare o suqa.orders; v_to suqa.order_status := (p->>'status')::suqa.order_status; v_from suqa.order_status;
begin
  select * into o from suqa.orders where id = (p->>'id')::uuid and shop_id = d.shop_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if o.status = v_to then return jsonb_build_object('noop', true, 'order_status', o.status); end if;    -- sent twice, or another till did it
  if o.parked or o.channel = 'walkin' then raise exception 'not_an_order'; end if;
  if suqa.order_stage(o.status) is null then raise exception 'order_closed'; end if;                   -- cancelled / rejected: not reopened
  if suqa.order_stage(v_to) is null or suqa.order_stage(v_to) >= suqa.order_stage(o.status) then raise exception 'not_a_step_back'; end if;
  if v_to = 'pending' and o.channel <> 'online' then raise exception 'not_a_step_back'; end if;
  if v_to = 'out_for_delivery' and o.fulfillment = 'pickup' then raise exception 'not_a_step_back'; end if;
  if o.status = 'delivered' then
    if exists (select 1 from suqa.payments where order_id = o.id group by currency having sum(amount) <> 0) then raise exception 'has_payments'; end if;
    if exists (select 1 from suqa.returns where order_id = o.id) then raise exception 'has_returns'; end if;
    if o.driver_paid_at is not null then raise exception 'driver_paid'; end if;
  end if;
  v_from := o.status;
  perform set_config('suqa.step_back', o.id::text, true);
  update suqa.orders
     set status = v_to,
         driver_delivered_at = case when v_from = 'delivered' then null else driver_delivered_at end,
         driver_picked_at    = case when suqa.order_stage(v_to) < 4 then null else driver_picked_at end
   where id = o.id;
  perform set_config('suqa.step_back', '', true);
  return jsonb_build_object('order_status', v_to, 'from', v_from);
end $function$;
revoke all on function suqa._pos_order_back(suqa.devices, jsonb, uuid) from public, anon, authenticated;

-- pos_push: the same function as today with two additions — the operation 'order.back', and a cashier needs the owner's approval for it
CREATE OR REPLACE FUNCTION suqa.pos_push(p_device uuid, p_ops jsonb, p_pending integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_dev suqa.devices; v_role text; v_op jsonb; v_id uuid; v_kind text; v_res jsonb; v_out jsonb := '[]'::jsonb;
        v_user uuid := auth.uid(); v_admin boolean; v_detail text;
begin
  if v_user is null then raise exception 'not_signed_in' using errcode = 'insufficient_privilege'; end if;
  select * into v_dev from suqa.devices where id = p_device;
  if not found then raise exception 'device_not_found'; end if;
  if v_dev.revoked_at is not null then raise exception 'device_revoked'; end if;
  v_role := suqa.pos_role(v_dev.shop_id);
  if v_role is null then raise exception 'not_a_member' using errcode = 'insufficient_privilege'; end if;
  v_admin := suqa.is_platform_admin();
  perform set_config('suqa.device', p_device::text, true);
  if jsonb_typeof(p_ops) <> 'array' then raise exception 'bad_ops'; end if;

  for v_op in select * from jsonb_array_elements(p_ops) loop
    v_id := (v_op->>'op_id')::uuid; v_kind := v_op->>'kind';
    select result into v_res from suqa.pos_ops where op_id = v_id;
    if found then
      v_out := v_out || (v_res || jsonb_build_object('op_id', v_id, 'replayed', true));
      continue;
    end if;

    begin
      if v_role = 'setup' and v_kind not in ('product.patch','rate.set') then raise exception 'role_not_allowed' using errcode = 'insufficient_privilege'; end if;
      if v_role = 'stock' and v_kind not in ('stock.move','product.patch') then raise exception 'role_not_allowed' using errcode = 'insufficient_privilege'; end if;
      if v_role = 'cashier' and v_kind in ('rate.set','product.patch','stock.move','return.commit','order.delete','purchase.commit','purchase.void','supplier.pay','customer.merge','customer.delete','supplier.merge','supplier.delete','driver.delete','debt.unsettle','order.back') and coalesce((v_op->'payload'->>'approved_by'), '') = '' then
        raise exception 'owner_approval_required' using errcode = 'insufficient_privilege';
      end if;

      v_res := case v_kind
        when 'sale.commit'   then suqa._pos_sale_commit(v_dev, v_op->'payload', coalesce(nullif(v_op->'payload'->>'staff_user_id','')::uuid, v_user))
        when 'sale.cancel'   then suqa._pos_sale_cancel(v_dev, v_op->'payload', v_user)
        when 'order.status'  then suqa._pos_order_status(v_dev, v_op->'payload', v_user)
        when 'order.back'    then suqa._pos_order_back(v_dev, v_op->'payload', v_user)
        when 'order.edit'    then suqa._pos_order_edit(v_dev, v_op->'payload', v_user)
        when 'order.merge'   then suqa._pos_order_merge(v_dev, v_op->'payload', v_user)
        when 'order.needed'  then suqa._pos_order_needed(v_dev, v_op->'payload', v_user)
        when 'order.info'    then suqa._pos_order_info(v_dev, v_op->'payload', v_user)
        when 'driver.upsert' then suqa._pos_driver_upsert(v_dev, v_op->'payload', v_user)
        when 'driver.delete' then suqa._pos_driver_delete(v_dev, v_op->'payload', v_user)
        when 'order.pay'     then suqa._pos_order_pay(v_dev, v_op->'payload', v_user)
        when 'return.commit' then suqa._pos_return(v_dev, v_op->'payload', v_user)
        when 'stock.move'    then suqa._pos_stock_move(v_dev, v_op->'payload', v_user)
        when 'product.patch' then suqa._pos_product_patch(v_dev, case when v_role = 'setup' and v_op->'payload' ? 'fields' then jsonb_set(v_op->'payload', '{fields}', (v_op->'payload'->'fields') - 'cost_cents' - 'margin_pct' - 'supplier_id') else v_op->'payload' end, v_user)
        when 'shift.open'    then suqa._pos_shift(v_dev, v_op->'payload', v_user, 'shift.open')
        when 'shift.close'   then suqa._pos_shift(v_dev, v_op->'payload', v_user, 'shift.close')
        when 'cash.move'     then suqa._pos_cash_move(v_dev, v_op->'payload', v_user)
        when 'debt.settle'   then suqa._pos_debt_settle(v_dev, v_op->'payload', v_user)
        when 'debt.unsettle' then suqa._pos_debt_unsettle(v_dev, v_op->'payload', v_user)
        when 'driver.payout' then suqa._pos_driver_payout(v_dev, v_op->'payload', v_user)
        when 'order.driver_pay' then suqa._pos_order_driver_pay(v_dev, v_op->'payload', v_user)
        when 'order.driver_cash' then suqa._pos_order_driver_cash(v_dev, v_op->'payload', v_user)
        when 'order.delete'  then suqa._pos_order_delete(v_dev, v_op->'payload', v_user)
        when 'customer.upsert' then suqa._pos_customer_upsert(v_dev, v_op->'payload', v_user)
        when 'supplier.upsert' then suqa._pos_supplier_upsert(v_dev, v_op->'payload', v_user)
        when 'purchase.commit' then suqa._pos_purchase_commit(v_dev, v_op->'payload', v_user)
        when 'purchase.void'   then suqa._pos_purchase_void(v_dev, v_op->'payload', v_user)
        when 'supplier.pay'    then suqa._pos_supplier_pay(v_dev, v_op->'payload', v_user)
        when 'customer.merge'  then suqa._pos_customer_merge(v_dev, v_op->'payload', v_user)
        when 'customer.delete' then suqa._pos_customer_delete(v_dev, v_op->'payload', v_user)
        when 'supplier.merge'  then suqa._pos_supplier_merge(v_dev, v_op->'payload', v_user)
        when 'supplier.delete' then suqa._pos_supplier_delete(v_dev, v_op->'payload', v_user)
        when 'rate.set'      then suqa._pos_rate_set(v_dev, v_op->'payload', v_user)
        else null end;
      if v_res is null then raise exception 'unknown_op' using detail = v_kind; end if;
      v_res := v_res || jsonb_build_object('status', 'ok');
    exception when others then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_res := jsonb_build_object('status', 'rejected', 'error', sqlerrm, 'code', sqlstate, 'detail', coalesce(v_detail, ''));
    end;

    insert into suqa.pos_ops (op_id, device_id, shop_id, kind, schema_version, result)
    values (v_id, p_device, v_dev.shop_id, v_kind, coalesce((v_op->>'schema_version')::int, 1), v_res);
    insert into suqa.audit_log (shop_id, tenant_id, user_id, device_id, action, ref_id, after, acting_as_admin)
    values (v_dev.shop_id, v_dev.tenant_id, v_user, p_device, v_kind, v_op->'payload'->>'id', v_op->'payload' || jsonb_build_object('result', v_res), v_admin);
    v_out := v_out || (v_res || jsonb_build_object('op_id', v_id));
  end loop;

  update suqa.devices set last_sync_at = now(), pending_count = greatest(p_pending, 0) where id = p_device;
  return jsonb_build_object('results', v_out, 'server_now', now());
end $function$;
