-- 110: reopen an order that was cancelled or rejected by mistake.
--   pos_order_reopen(shop, order, approved_by): the shop's owner, or a cashier with the owner's approval — online, in one step on the
--   server (like pos_op_cancel), so every till receives the reopened order by sync. The order goes back to the stage it had just
--   before it was cancelled / rejected (from its own history; a rejected online order goes back to "pending").
--   Refused when: the customer cancelled it himself or asked for the cancel (86); it was cancelled because it was merged into
--   another order (its items live there now); it is a counter sale or a parked cart; the stock is no longer there.
--   Stock, so nothing is counted twice and nothing is lost:
--     · WhatsApp / phone order — the cancel gave its items back; the reopen takes them again ('sale' moves), only what is missing,
--       and only if the shelf has them (or the shop allows selling below zero);
--     · online order cancelled BEFORE its stock was taken — the cancel released its reservation; the reopen removes those release
--       rows, so the reservation stands exactly as before the cancel (and is taken / released later by the usual rules), only if
--       the items are still free;
--     · online order cancelled AFTER its stock was taken — the cancel never gave it back, so there is nothing to take again.
--   The customer is NOT messaged about the reopen; the next step forward sends its message as usual.
--   orders_on_status_change and notify_order_event: the 109 versions plus the announced reopen. No table change. Safe to run twice.

-- the same trigger function as 109, plus: a reopen announced by pos_order_reopen is allowed
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
        v_reopen boolean := coalesce(current_setting('suqa.reopen', true), '') = new.id::text
                            and old.status in ('cancelled', 'rejected') and suqa.order_stage(new.status) is not null and new.status <> 'delivered';
begin
  if new.status = old.status then return new; end if;

  if not v_back and not v_reopen and not suqa.order_transition_allowed(old.status, new.status) then
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

  if v_reopen then
    new.closed_at = null;                                                 -- open again; the times of the stages it had reached stay
  elsif v_back then
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
          case when v_reopen then 'reopened'
               when v_back then 'step back'
               when new.status = 'rejected' then new.reject_reason
               when v_received then 'confirmed by the customer'
               when new.status = 'cancelled' and new.cancel_reason is not null then new.cancel_reason end);
  return new;
end $function$;

-- the same as 109, plus: nobody is messaged about a reopen
create or replace function suqa.notify_order_event()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_event text;
begin
  if new.channel = 'walkin' then return new; end if;
  if tg_op = 'UPDATE' and new.id::text in (coalesce(current_setting('suqa.step_back', true), ''), coalesce(current_setting('suqa.reopen', true), '')) then return new; end if;
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

create or replace function suqa.pos_order_reopen(p_shop uuid, p_order uuid, p_approved_by uuid default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare o suqa.orders; v_role text := suqa.pos_role(p_shop); v_to suqa.order_status; v_from suqa.order_status; v_last suqa.order_events;
        v_neg boolean; r record; v_need numeric; v_free numeric; v_name text;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if coalesce(v_role, '') not in ('owner', 'cashier') then raise exception 'not_allowed' using errcode = 'insufficient_privilege'; end if;
  if v_role = 'cashier' and p_approved_by is null then raise exception 'owner_approval_required' using errcode = 'insufficient_privilege'; end if;
  select * into o from suqa.orders where id = p_order and shop_id = p_shop for update;
  if not found then raise exception 'order_not_found'; end if;
  if o.status not in ('cancelled', 'rejected') then return jsonb_build_object('ok', true, 'noop', true, 'status', o.status); end if;   -- a second tap, or another till did it
  if o.parked or o.channel = 'walkin' then raise exception 'not_an_order'; end if;
  if exists (select 1 from suqa.audit_log a where a.shop_id = p_shop and a.action = 'order.merged' and a.after->>'from' = o.id::text) then raise exception 'merged'; end if;
  if exists (select 1 from suqa.order_cancel_requests q where q.order_id = o.id and q.status = 'accepted') then raise exception 'cancelled_by_customer'; end if;
  select * into v_last from suqa.order_events e where e.order_id = o.id and e.to_status = o.status order by e.created_at desc, e.id desc limit 1;
  if v_last.actor_kind = 'customer' then raise exception 'cancelled_by_customer'; end if;
  v_from := o.status;
  v_to := coalesce(v_last.from_status, (case when o.channel = 'online' and o.status = 'rejected' then 'pending' else 'accepted' end)::suqa.order_status);
  if suqa.order_stage(v_to) is null or v_to = 'delivered' then v_to := 'accepted'; end if;

  select allow_negative_stock into v_neg from suqa.shops where id = p_shop;
  if o.channel = 'online' then
    -- its reservation comes back: the release rows written by the cancel go (a product whose stock was already taken keeps its rows)
    for r in select m.product_id, -sum(m.qty) q from suqa.stock_moves m
              where m.ref_order_id = o.id and m.kind = 'release'
                and not exists (select 1 from suqa.stock_moves s where s.ref_order_id = o.id and s.product_id = m.product_id and s.kind = 'sale')
              group by m.product_id having sum(m.qty) < 0 loop
      select on_hand - reserved, coalesce(name->>'ar', name->>'en') into v_free, v_name from suqa.products where id = r.product_id for update;
      if v_free < r.q then raise exception 'out_of_stock' using detail = v_name; end if;
      delete from suqa.stock_moves m where m.ref_order_id = o.id and m.product_id = r.product_id and m.kind = 'release';
    end loop;
  else
    -- its items leave the shelf again: per product, what the lines need minus what the order's moves still hold
    for r in select i.product_id, sum(i.quantity) q from suqa.order_items i join suqa.products p on p.id = i.product_id
              where i.order_id = o.id and not i.voided and p.track_stock group by i.product_id loop
      v_need := r.q + coalesce((select sum(m.qty) from suqa.stock_moves m where m.ref_order_id = o.id and m.product_id = r.product_id and m.kind in ('sale', 'return')), 0);
      continue when v_need <= 0;
      select on_hand - reserved, coalesce(name->>'ar', name->>'en') into v_free, v_name from suqa.products where id = r.product_id for update;
      if v_free < v_need and not coalesce(v_neg, false) then raise exception 'out_of_stock' using detail = v_name; end if;
      insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, ref_order_id, user_id, note)
      values (gen_random_uuid(), o.shop_id, o.tenant_id, r.product_id, -v_need, 'sale', o.id, auth.uid(), 'reopened');
    end loop;
  end if;

  perform set_config('suqa.reopen', o.id::text, true);
  update suqa.orders set status = v_to, cancel_reason = null, reject_reason = null where id = o.id;
  perform set_config('suqa.reopen', '', true);
  insert into suqa.audit_log (shop_id, tenant_id, user_id, action, ref_tbl, ref_id, after)
  values (p_shop, o.tenant_id, auth.uid(), 'order.reopen', 'orders', o.id::text,
          jsonb_build_object('id', o.id, 'number', coalesce(o.number, o.local_number), 'from', v_from, 'status', v_to, 'approved_by', p_approved_by, 'result', jsonb_build_object('status', 'ok')));
  return jsonb_build_object('ok', true, 'status', v_to, 'from', v_from);
end $function$;
revoke all on function suqa.pos_order_reopen(uuid, uuid, uuid) from public, anon;
grant execute on function suqa.pos_order_reopen(uuid, uuid, uuid) to authenticated;
