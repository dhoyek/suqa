-- 86_customer_close_cancel.sql — the customer can say "I received it" and ask to cancel an order the shop already accepted.   (2026-11-20)
--
-- WHY: a customer saw an order that had reached him still open (HS-000030, "preparing"), with no way to close it, and no way to
-- cancel an order once the shop had accepted it (cancel existed only while "pending").
--
-- NOW:
--   * suqa.customer_confirm_received(order)  — the order's own customer, while it is accepted / preparing / ready / on the way:
--     the order becomes "delivered", recorded as done by the customer ("confirmed by the customer"). No money is written: the shop
--     still records the payment in the POS as for any delivered order, so nothing is counted twice.
--   * suqa.order_cancel_requests              — once accepted, the customer ASKS to cancel (a reason, optional); the shop answers.
--     customer_request_cancel(order, reason)   — own order, accepted / preparing / ready / on the way; one open request per order.
--     shop_answer_cancel(order, accept, note)  — the shop's owner / cashier: accept → the order is cancelled (refused if a payment
--                                                 is already recorded on it: that goes through a return); refuse → the order goes on.
--   * orders_on_status_change: the customer may now also close his order as delivered, but only through customer_confirm_received
--     (a flag set inside that function) — never by writing the status himself. Everything else in it is unchanged.
--   Pending orders: the customer still cancels them himself at once, as before.
--
-- Table changes: NEW table suqa.order_cancel_requests. Function changes: orders_on_status_change (one condition), 3 new functions.
-- Idempotent.

create table if not exists suqa.order_cancel_requests (
  order_id     uuid primary key references suqa.orders(id) on delete cascade,
  tenant_id    uuid not null references suqa.tenants(id) on delete cascade,
  shop_id      uuid not null references suqa.shops(id) on delete cascade,
  customer_id  uuid not null,
  reason       text,
  status       text not null default 'open',
  shop_note    text,
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  decided_by   uuid,
  constraint order_cancel_requests_status check (status in ('open', 'accepted', 'refused')),
  constraint order_cancel_requests_sizes check (length(coalesce(reason, '')) <= 300 and length(coalesce(shop_note, '')) <= 300)
);
create index if not exists order_cancel_requests_shop_open on suqa.order_cancel_requests (shop_id) where status = 'open';
alter table suqa.order_cancel_requests enable row level security;
revoke all on suqa.order_cancel_requests from public, anon;
grant select on suqa.order_cancel_requests to authenticated;
drop policy if exists order_cancel_requests_read on suqa.order_cancel_requests;
create policy order_cancel_requests_read on suqa.order_cancel_requests for select to authenticated
  using (customer_id = auth.uid() or suqa.is_shop_member(shop_id));                     -- the customer and the shop; written only by the functions

-- ---------- the status trigger: one more case for the customer (unchanged otherwise) ----------
create or replace function suqa.orders_on_status_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_actor suqa.actor_kind; v_received boolean := coalesce(current_setting('suqa.customer_received', true), '') = new.id::text;
begin
  if new.status = old.status then return new; end if;

  if not suqa.order_transition_allowed(old.status, new.status) then
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

  -- a customer cancels a pending order himself, and closes his order as delivered only through customer_confirm_received (86)
  if v_actor = 'customer' and not ((old.status = 'pending' and new.status = 'cancelled') or (new.status = 'delivered' and v_received)) then
    raise exception 'customers can only cancel a pending order' using errcode = 'insufficient_privilege';
  end if;

  if new.status = 'accepted'         then new.accepted_at  = coalesce(new.accepted_at, now()); end if;
  if new.status = 'out_for_delivery' then new.picked_up_at = coalesce(new.picked_up_at, now()); end if;
  if new.status = 'delivered'        then new.delivered_at = coalesce(new.delivered_at, now()); end if;
  if new.status in ('delivered','rejected','cancelled') then new.closed_at = coalesce(new.closed_at, now()); end if;

  insert into suqa.order_events(order_id, tenant_id, from_status, to_status, actor_kind, actor_id, note)
  values (new.id, new.tenant_id, old.status, new.status, v_actor, auth.uid(),
          case when new.status = 'rejected' then new.reject_reason
               when v_received then 'confirmed by the customer'
               when new.status = 'cancelled' and new.cancel_reason is not null then new.cancel_reason end);
  return new;
end $$;

-- ---------- "I received it" ----------
create or replace function suqa.customer_confirm_received(p_order uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  select id, customer_id, status into o from suqa.orders where id = p_order for update;
  if o.id is null or o.customer_id is distinct from auth.uid() then raise exception 'not_your_order'; end if;
  if o.status = 'delivered' then return jsonb_build_object('ok', true, 'status', 'delivered'); end if;   -- pressed twice: nothing more
  if o.status not in ('accepted', 'preparing', 'ready', 'out_for_delivery') then raise exception 'order_not_open'; end if;
  perform set_config('suqa.customer_received', p_order::text, true);
  update suqa.orders set status = 'delivered' where id = p_order;
  perform set_config('suqa.customer_received', '', true);
  update suqa.order_cancel_requests set status = 'refused', shop_note = coalesce(shop_note, 'received'), decided_at = now()
   where order_id = p_order and status = 'open';                                       -- received: an open cancel request is moot
  return jsonb_build_object('ok', true, 'status', 'delivered');
end $$;

-- ---------- ask to cancel (after the shop accepted) ----------
create or replace function suqa.customer_request_cancel(p_order uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  select id, tenant_id, shop_id, customer_id, status into o from suqa.orders where id = p_order;
  if o.id is null or o.customer_id is distinct from auth.uid() then raise exception 'not_your_order'; end if;
  if o.status = 'pending' then raise exception 'cancel_it_yourself'; end if;            -- still pending: the plain cancel button
  if o.status not in ('accepted', 'preparing', 'ready', 'out_for_delivery') then raise exception 'order_not_open'; end if;
  insert into suqa.order_cancel_requests (order_id, tenant_id, shop_id, customer_id, reason)
  values (o.id, o.tenant_id, o.shop_id, auth.uid(), nullif(left(trim(p_reason), 300), ''))
  on conflict (order_id) do update
    set reason = excluded.reason, status = 'open', shop_note = null, created_at = now(), decided_at = null, decided_by = null
    where suqa.order_cancel_requests.status <> 'open';                                  -- an open request is not repeated
  return jsonb_build_object('ok', true, 'status', 'open');
end $$;

-- ---------- the shop answers ----------
create or replace function suqa.shop_answer_cancel(p_order uuid, p_accept boolean, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; o record; v_role text;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  select * into r from suqa.order_cancel_requests where order_id = p_order for update;
  if r.order_id is null then raise exception 'no_request'; end if;
  v_role := suqa.pos_role(r.shop_id);
  if v_role is null or v_role not in ('owner', 'cashier') then raise exception 'not_shop_staff'; end if;
  if r.status <> 'open' then return jsonb_build_object('ok', true, 'status', r.status); end if;   -- answered already (another till)
  select id, status into o from suqa.orders where id = p_order for update;
  if p_accept then
    if exists (select 1 from suqa.payments where order_id = p_order) then raise exception 'has_payments'; end if;   -- money in: a return, not a cancel
    if o.status not in ('accepted', 'preparing', 'ready', 'out_for_delivery') then raise exception 'order_not_open'; end if;
    update suqa.orders set status = 'cancelled', cancel_reason = left(coalesce('الزبون: ' || r.reason, 'الزبون طلب الإلغاء'), 300) where id = p_order;
  end if;
  update suqa.order_cancel_requests set status = case when p_accept then 'accepted' else 'refused' end,
         shop_note = nullif(left(trim(p_note), 300), ''), decided_at = now(), decided_by = auth.uid()
   where order_id = p_order;
  return jsonb_build_object('ok', true, 'status', case when p_accept then 'accepted' else 'refused' end);
end $$;

revoke all on function suqa.customer_confirm_received(uuid) from public, anon;
revoke all on function suqa.customer_request_cancel(uuid, text) from public, anon;
revoke all on function suqa.shop_answer_cancel(uuid, boolean, text) from public, anon;
grant execute on function suqa.customer_confirm_received(uuid) to authenticated;
grant execute on function suqa.customer_request_cancel(uuid, text) to authenticated;
grant execute on function suqa.shop_answer_cancel(uuid, boolean, text) to authenticated;

select 'customer close / cancel installed' as result;
