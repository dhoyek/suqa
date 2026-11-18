-- 81_driver_confirm_cash.sql — the driver closes the delivery himself, and the cash he holds is settled with the shop.   (2026-11-18)
--
-- BEFORE: the driver's "🏠 سلّمت الطلب" only recorded a time; the shop still had to mark the order delivered and type the cash in.
-- NOW:    his confirmation is final — the order becomes DELIVERED on the shop's POS — and he says whether he collected the money.
--
-- WHERE THE MONEY IS (nothing is counted twice):
--   * the customer's money stays the order's own payment. What the driver collected is a payment with tender 'driver'
--     ("with the driver"): the order is paid, but the cash is NOT in the shop's drawer and is in no shift.
--   * when he hands it over, a settlement (driver_payouts — the same record that pays his deliveries) closes those payments
--     (payments.settled_at / reference = the settlement). Each 'driver' payment can be closed once; the amount is computed
--     here from the rows, never taken from the device. The POS posts ONE cash move on the open shift for the net
--     (cash he brings in − his pay), so the drawer moves once.
--   * the driver's pay is unchanged (60): orders.courier_fee_cents, settled once per delivery.
--
-- driver_step(order, step, collected)   'delivered' → status delivered (+ payment 'driver' for what was due when collected = true);
--                                       collected = false → delivered and left unpaid for the shop to follow up.
-- order.driver_cash { id, cents }       the shop owner corrects what a driver said he collected (only while not settled; 0 = he collected nothing).
-- order.pay                            if the till records the customer's payment on an order the driver already closed, the
--                                       excess comes off the driver's open amount (the money is in the drawer, counted once).
-- driver.payout { …, cash_order_ids[] } now also closes the cash of those orders (either list may be empty, not both).
-- pos_driver_report                     + cash_cents per driver / per order, + cash in each past settlement.
-- driver_balance(driver)                the driver's own page (/d/me/<driver id>, server only): on the road, cash he holds, pay owed
--                                       to him, the net, and past settlements. He sees only his own deliveries — nothing else of the shop.
--
-- Table changes (base files 21 and 60 list them):
--   payments.tender        check + 'driver'
--   driver_payouts         + cash_cents bigint not null default 0      (cash closed by this settlement, USD cents)
-- Full tables after this script:
--   create table suqa.payments (
--     id uuid primary key, order_id uuid not null references suqa.orders(id) on delete cascade, shop_id uuid not null references suqa.shops(id) on delete cascade,
--     tenant_id uuid not null,
--     tender text not null check (tender in ('cash_usd','cash_lbp','card','wallet','unpaid','driver')),
--     amount bigint not null, currency text not null check (currency in ('usd','lbp')),
--     reference text, unpaid_name text, unpaid_phone text, note text,
--     settled_at timestamptz,            -- 'unpaid': paid later · 'driver': handed to the shop
--     at timestamptz not null default now(), updated_at timestamptz not null default now());
--   create table suqa.driver_payouts (
--     id uuid primary key, shop_id uuid not null references suqa.shops(id) on delete cascade, tenant_id uuid not null,
--     driver_id uuid not null references suqa.shop_drivers(id) on delete restrict,
--     orders_count int not null, amount_cents bigint not null, currency text not null check (currency in ('usd','lbp')),
--     amount bigint not null, rate int not null, from_drawer boolean not null default false, shift_id uuid,
--     collected_cents bigint not null default 0, cash_cents bigint not null default 0,
--     note text, user_id uuid, device_id uuid, at timestamptz not null default now(), created_at timestamptz not null default now());
-- Requires 60, 67, 80. Idempotent.

alter table suqa.payments drop constraint if exists payments_tender_check;
alter table suqa.payments add  constraint payments_tender_check check (tender in ('cash_usd','cash_lbp','card','wallet','unpaid','driver'));
alter table suqa.driver_payouts add column if not exists cash_cents bigint not null default 0;
create index if not exists payments_driver_open_idx on suqa.payments (order_id) where tender = 'driver' and settled_at is null;

-- what is still to collect on an order, in USD cents (storefront orders may carry dollars only)
create or replace function suqa._order_due_cents(o suqa.orders) returns bigint
language sql stable security definer set search_path = public as $$
  select greatest(0, coalesce(o.total_cents, round(coalesce(o.total_usd, 0) * 100)::int)
         - coalesce((select sum(case when p.currency = 'lbp' then round(p.amount * 100.0 / nullif(coalesce(o.rate_lbp_per_usd, o.fx_lbp_rate::int), 0)) else p.amount end)
                       from suqa.payments p where p.order_id = o.id and p.tender <> 'unpaid'), 0))::bigint
$$;
revoke all on function suqa._order_due_cents(suqa.orders) from public, anon, authenticated;

-- ---------- the driver's taps (67 + a final "delivered") ---------------------------------------------------------------
drop function if exists suqa.driver_step(uuid, text);
create or replace function suqa.driver_step(p_order uuid, p_step text, p_collected boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o suqa.orders; v_driver text; v_note text; v_due bigint := 0;
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
  v_due := suqa._order_due_cents(o);
  if coalesce(p_collected, true) and v_due > 0 then
    insert into suqa.payments (id, order_id, shop_id, tenant_id, tender, amount, currency, note, at)
    values (gen_random_uuid(), o.id, o.shop_id, o.tenant_id, 'driver', v_due, 'usd', v_driver, now());
  end if;
  update suqa.orders set
    driver_ack_at       = coalesce(driver_ack_at, now()),
    driver_picked_at    = coalesce(driver_picked_at, now()),
    driver_delivered_at = coalesce(driver_delivered_at, now()),
    paid_usd_cents      = coalesce(paid_usd_cents, 0) + case when coalesce(p_collected, true) then v_due else 0 end,
    total_cents         = coalesce(total_cents, round(coalesce(total_usd, 0) * 100)::int),
    status = 'delivered',
    updated_at = now()
  where id = p_order;
  v_note := '🏠 ' || coalesce(v_driver, '') || ' — سلّم الطلب للزبون'
            || case when v_due = 0 then ' (مدفوع مسبقاً)'
                    when coalesce(p_collected, true) then ' واستلم ' || to_char(v_due / 100.0, 'FM999990.00') || '$ — المبلغ معه'
                    else ' — لم يستلم المبلغ' end;
  insert into suqa.order_events (order_id, tenant_id, actor_kind, note) values (p_order, o.tenant_id, 'system', v_note);
  return jsonb_build_object('ok', true, 'step', p_step, 'at', now(), 'collected_cents', case when coalesce(p_collected, true) then v_due else 0 end);
end $$;
revoke all on function suqa.driver_step(uuid, text, boolean) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function suqa.driver_step(uuid, text, boolean) to service_role;
  end if;
end $$;

-- ---------- the till took the money after all ---------------------------------------------------------------------------
-- A till that had not yet heard of the driver's confirmation (offline) may record the customer's payment itself when he comes
-- back with the cash. The order would then be paid twice: once "with the driver", once in the drawer. The money is in the
-- drawer, so what is over is taken off the driver's open amount — the customer's money stays counted once.
create or replace function suqa._driver_cash_absorb(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o suqa.orders; v_over bigint;
begin
  select * into o from suqa.orders where id = p_order;
  if not found or o.driver_id is null then return; end if;
  if not exists (select 1 from suqa.payments where order_id = p_order and tender = 'driver' and settled_at is null and amount > 0) then return; end if;
  v_over := coalesce((select sum(case when p.currency = 'lbp' then round(p.amount * 100.0 / nullif(coalesce(o.rate_lbp_per_usd, o.fx_lbp_rate::int), 0)) else p.amount end)
                        from suqa.payments p where p.order_id = p_order and p.tender <> 'unpaid'), 0)
            - coalesce(o.total_cents, round(coalesce(o.total_usd, 0) * 100)::int);
  if v_over <= 0 then return; end if;
  update suqa.payments set amount = greatest(0, amount - v_over)
   where id = (select id from suqa.payments where order_id = p_order and tender = 'driver' and settled_at is null order by at limit 1);
end $$;
revoke all on function suqa._driver_cash_absorb(uuid) from public, anon, authenticated;

-- order.pay: today's definition + the call above, just before it answers
do $$
declare v_def text := pg_get_functiondef('suqa._pos_order_pay(suqa.devices, jsonb, uuid)'::regprocedure);
        v_old text := E'  return jsonb_build_object(''ok'', true);\n';
begin
  if position('_driver_cash_absorb' in v_def) > 0 then return; end if;
  if position(v_old in v_def) = 0 then raise exception '_pos_order_pay: anchor not found'; end if;
  execute replace(v_def, v_old, E'  perform suqa._driver_cash_absorb(v_o.id);   -- 81\n' || v_old);
end $$;
revoke all on function suqa._pos_order_pay(suqa.devices, jsonb, uuid) from public, anon, authenticated;

-- ---------- order.driver_cash { id, cents } — the owner corrects what the driver said he collected -------------------------
create or replace function suqa._pos_order_driver_cash(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_o suqa.orders; v_cents bigint := (p->>'cents')::bigint; v_pay suqa.payments; v_max bigint;
begin
  if suqa.pos_role(d.shop_id) is distinct from 'owner' then raise exception 'owner_only' using errcode = 'insufficient_privilege'; end if;
  if v_cents is null or v_cents < 0 then raise exception 'bad_amount'; end if;
  select * into v_o from suqa.orders where id = (p->>'id')::uuid and shop_id = d.shop_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if v_o.driver_id is null or v_o.status <> 'delivered' then raise exception 'not_a_driver_delivery'; end if;
  select * into v_pay from suqa.payments where order_id = v_o.id and tender = 'driver' order by at limit 1 for update;
  if found and v_pay.settled_at is not null then raise exception 'already_settled'; end if;
  -- never more than the order is worth (what is due, plus what this row already holds)
  v_max := suqa._order_due_cents(v_o) + coalesce(v_pay.amount, 0);
  if v_cents > v_max then raise exception 'more_than_due'; end if;
  if v_pay.id is not null then
    update suqa.payments set amount = v_cents where id = v_pay.id;
  elsif v_cents > 0 then
    insert into suqa.payments (id, order_id, shop_id, tenant_id, tender, amount, currency, note, at)
    values (gen_random_uuid(), v_o.id, v_o.shop_id, v_o.tenant_id, 'driver', v_cents, 'usd', (select name from suqa.shop_drivers where id = v_o.driver_id), now());
  end if;
  update suqa.orders set paid_usd_cents = greatest(0, coalesce(paid_usd_cents, 0) + v_cents - coalesce(v_pay.amount, 0)), updated_at = now() where id = v_o.id;
  return jsonb_build_object('ok', true, 'cents', v_cents);
end $$;
revoke all on function suqa._pos_order_driver_cash(suqa.devices, jsonb, uuid) from public, anon, authenticated;

-- ---------- driver.payout (60 + the cash he hands over) ----------------------------------------------------------------
create or replace function suqa._pos_driver_payout(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid := (p->>'id')::uuid; v_driver uuid := (p->>'driver_id')::uuid; v_at timestamptz := coalesce((p->>'at')::timestamptz, now());
        v_ids uuid[]; v_cash_ids uuid[]; v_n int := 0; v_sum bigint := 0; v_val bigint := 0; v_cash bigint := 0; v_cash_n int := 0;
begin
  if exists (select 1 from suqa.driver_payouts where id = v_id) then return jsonb_build_object('ok', true, 'replayed', true); end if;
  if not exists (select 1 from suqa.shop_drivers where id = v_driver and shop_id = d.shop_id) then raise exception 'driver_not_found'; end if;
  select array_agg(x::uuid) into v_ids      from jsonb_array_elements_text(coalesce(p->'order_ids', '[]'::jsonb)) x;
  select array_agg(x::uuid) into v_cash_ids from jsonb_array_elements_text(coalesce(p->'cash_order_ids', '[]'::jsonb)) x;
  if v_ids is null and v_cash_ids is null then raise exception 'nothing_to_pay'; end if;
  -- the settlement row first (orders and payments point at it), then claim: only this driver's delivered orders,
  -- each delivery's pay once and each 'driver' payment once. The amounts are theirs — never the device's.
  insert into suqa.driver_payouts (id, shop_id, tenant_id, driver_id, orders_count, amount_cents, currency, amount, rate, from_drawer, shift_id, collected_cents, cash_cents, note, user_id, device_id, at)
  values (v_id, d.shop_id, d.tenant_id, v_driver, 0, 0, coalesce(p->>'currency', 'usd'), 0, coalesce((p->>'rate')::int, 89500),
          coalesce((p->>'from_drawer')::boolean, false), nullif(p->>'shift_id', '')::uuid, 0, 0, p->>'note', p_user, d.id, v_at);
  if v_ids is not null then
    with upd as (
      update suqa.orders set driver_paid_at = v_at, driver_payout_id = v_id
       where id = any(v_ids) and shop_id = d.shop_id and driver_id = v_driver and status = 'delivered' and driver_paid_at is null
      returning courier_fee_cents, total_cents
    ) select count(*), coalesce(sum(courier_fee_cents), 0), coalesce(sum(total_cents), 0) into v_n, v_sum, v_val from upd;
  end if;
  if v_cash_ids is not null then
    with upd as (
      update suqa.payments pm set settled_at = v_at, reference = v_id::text
        from suqa.orders o
       where pm.order_id = o.id and pm.tender = 'driver' and pm.settled_at is null
         and o.id = any(v_cash_ids) and o.shop_id = d.shop_id and o.driver_id = v_driver and o.status = 'delivered'
      returning pm.amount
    ) select count(*), coalesce(sum(amount), 0) into v_cash_n, v_cash from upd;
  end if;
  if v_n = 0 and v_cash_n = 0 then raise exception 'nothing_to_pay'; end if;      -- undoes the row above
  update suqa.driver_payouts set orders_count = v_n, amount_cents = v_sum, collected_cents = v_val, cash_cents = v_cash,
         amount = coalesce((p->>'amount')::bigint, v_sum)
   where id = v_id;
  return jsonb_build_object('ok', true, 'orders', v_n, 'amount_cents', v_sum, 'cash_orders', v_cash_n, 'cash_cents', v_cash);
end $$;
revoke all on function suqa._pos_driver_payout(suqa.devices, jsonb, uuid) from public, anon, authenticated;

-- ---------- report (60 + cash with the driver) -------------------------------------------------------------------------
create or replace function suqa.pos_driver_report(p_shop uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_from timestamptz := (p_from::timestamp at time zone 'Asia/Beirut');
        v_to   timestamptz := ((p_to + 1)::timestamp at time zone 'Asia/Beirut');
begin
  if suqa.pos_role(p_shop) is distinct from 'owner' then raise exception 'not_owner' using errcode = 'insufficient_privilege'; end if;
  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    'default', (select jsonb_build_object('mode', driver_pay_mode, 'cents', driver_pay_cents) from suqa.shops where id = p_shop),
    'drivers', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', d.id, 'name', d.name, 'phone', d.phone, 'vehicle', d.vehicle, 'active', d.active, 'pay_mode', d.pay_mode, 'pay_cents', d.pay_cents,
        -- in the period
        'deliveries',   (select count(*) from suqa.orders o where o.driver_id = d.id and o.status = 'delivered' and coalesce(o.delivered_at, o.closed_at, o.updated_at) >= v_from and coalesce(o.delivered_at, o.closed_at, o.updated_at) < v_to),
        'value_cents',  (select coalesce(sum(o.total_cents), 0) from suqa.orders o where o.driver_id = d.id and o.status = 'delivered' and coalesce(o.delivered_at, o.closed_at, o.updated_at) >= v_from and coalesce(o.delivered_at, o.closed_at, o.updated_at) < v_to),
        'earned_cents', (select coalesce(sum(o.courier_fee_cents), 0) from suqa.orders o where o.driver_id = d.id and o.status = 'delivered' and coalesce(o.delivered_at, o.closed_at, o.updated_at) >= v_from and coalesce(o.delivered_at, o.closed_at, o.updated_at) < v_to),
        'avg_minutes',  (select round(avg(extract(epoch from (o.driver_delivered_at - o.driver_picked_at)) / 60)) from suqa.orders o where o.driver_id = d.id and o.driver_picked_at is not null and o.driver_delivered_at is not null and o.driver_delivered_at >= v_from and o.driver_delivered_at < v_to),
        'acked',        (select count(*) from suqa.orders o where o.driver_id = d.id and o.driver_ack_at is not null and o.status = 'delivered' and coalesce(o.delivered_at, o.closed_at, o.updated_at) >= v_from and coalesce(o.delivered_at, o.closed_at, o.updated_at) < v_to),
        -- as of now (whatever the period)
        'owed_cents',   (select coalesce(sum(o.courier_fee_cents), 0) from suqa.orders o where o.driver_id = d.id and o.status = 'delivered' and o.driver_paid_at is null),
        'owed_count',   (select count(*) from suqa.orders o where o.driver_id = d.id and o.status = 'delivered' and o.driver_paid_at is null and o.courier_fee_cents > 0),
        'out_count',    (select count(*) from suqa.orders o where o.driver_id = d.id and o.status = 'out_for_delivery'),
        -- cash he collected on delivered orders and has not handed over yet
        'cash_cents',   (select coalesce(sum(pm.amount), 0) from suqa.payments pm join suqa.orders o on o.id = pm.order_id where o.driver_id = d.id and o.status = 'delivered' and pm.tender = 'driver' and pm.settled_at is null),
        'cash_count',   (select count(*) from suqa.payments pm join suqa.orders o on o.id = pm.order_id where o.driver_id = d.id and o.status = 'delivered' and pm.tender = 'driver' and pm.settled_at is null and pm.amount > 0),
        -- still to collect on the orders that are out with him now
        'holding_cents', (select coalesce(sum(suqa._order_due_cents(o)), 0) from suqa.orders o where o.driver_id = d.id and o.status = 'out_for_delivery')
      ) order by d.active desc, d.name), '[]') from suqa.shop_drivers d where d.shop_id = p_shop),
    'orders', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', o.id, 'number', coalesce(o.number, o.local_number), 'driver_id', o.driver_id, 'status', o.status, 'customer', o.customer_name,
        'total_cents', o.total_cents, 'delivery_fee_cents', round(coalesce(o.delivery_fee_usd, 0) * 100), 'pay_cents', o.courier_fee_cents,
        'paid_at', o.driver_paid_at, 'payout_id', o.driver_payout_id, 'at', coalesce(o.delivered_at, o.closed_at, o.updated_at), 'placed_at', o.placed_at,
        'ack_at', o.driver_ack_at, 'picked_at', o.driver_picked_at, 'handed_at', o.driver_delivered_at,
        'due_cents', suqa._order_due_cents(o),
        'cash_cents', (select sum(pm.amount) from suqa.payments pm where pm.order_id = o.id and pm.tender = 'driver'),
        'cash_settled_at', (select max(pm.settled_at) from suqa.payments pm where pm.order_id = o.id and pm.tender = 'driver')
      ) order by coalesce(o.delivered_at, o.closed_at, o.updated_at) desc), '[]')
      from suqa.orders o
     where o.shop_id = p_shop and o.driver_id is not null
       and (   (o.status = 'delivered' and coalesce(o.delivered_at, o.closed_at, o.updated_at) >= v_from and coalesce(o.delivered_at, o.closed_at, o.updated_at) < v_to)
            or (o.status = 'delivered' and o.driver_paid_at is null and o.courier_fee_cents > 0)      -- pay still owed, whatever its date
            or (o.status = 'delivered' and exists (select 1 from suqa.payments pm where pm.order_id = o.id and pm.tender = 'driver' and pm.settled_at is null))   -- cash still with him
            or  o.status = 'out_for_delivery')),
    'payouts', (select coalesce(jsonb_agg(to_jsonb(x) order by x.at desc), '[]') from (select * from suqa.driver_payouts where shop_id = p_shop order by at desc limit 200) x)
  );
end $$;
revoke all on function suqa.pos_driver_report(uuid, date, date) from public, anon;
grant execute on function suqa.pos_driver_report(uuid, date, date) to authenticated;

-- ---------- the driver's own page ---------------------------------------------------------------------------------------
-- Server only (service role), reached by the unguessable driver id like the delivery sheet. His deliveries and his money with
-- this shop — no other figure of the shop.
create or replace function suqa.driver_balance(p_driver uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d suqa.shop_drivers; v_cash bigint; v_owed bigint;
begin
  select * into d from suqa.shop_drivers where id = p_driver;
  if not found then return null; end if;
  select coalesce(sum(pm.amount), 0) into v_cash from suqa.payments pm join suqa.orders o on o.id = pm.order_id
   where o.driver_id = d.id and o.status = 'delivered' and pm.tender = 'driver' and pm.settled_at is null;
  select coalesce(sum(o.courier_fee_cents), 0) into v_owed from suqa.orders o where o.driver_id = d.id and o.status = 'delivered' and o.driver_paid_at is null;
  return jsonb_build_object(
    'driver', jsonb_build_object('id', d.id, 'name', d.name),
    'shop', (select jsonb_build_object('name', s.name, 'phone', s.phone, 'whatsapp', s.whatsapp, 'tenant_id', s.tenant_id) from suqa.shops s where s.id = d.shop_id),
    'rate', (select coalesce((select r.lbp_per_usd from suqa.exchange_rates r where r.shop_id = d.shop_id order by r.effective_at desc limit 1), 89500)),
    'cash_cents', v_cash, 'owed_cents', v_owed, 'net_cents', v_cash - v_owed,
    'on_road', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'number', coalesce(o.number, o.local_number), 'customer', o.customer_name, 'due_cents', suqa._order_due_cents(o), 'picked_at', o.driver_picked_at) order by o.placed_at), '[]')
                  from suqa.orders o where o.driver_id = d.id and o.status in ('accepted', 'preparing', 'ready', 'out_for_delivery')),
    'open', (select coalesce(jsonb_agg(x order by x->>'at' desc), '[]') from (
               select jsonb_build_object('id', o.id, 'number', coalesce(o.number, o.local_number), 'customer', o.customer_name, 'at', coalesce(o.delivered_at, o.closed_at, o.updated_at),
                        'total_cents', o.total_cents,
                        'cash_cents', (select coalesce(sum(pm.amount), 0) from suqa.payments pm where pm.order_id = o.id and pm.tender = 'driver' and pm.settled_at is null),
                        'pay_cents', case when o.driver_paid_at is null then o.courier_fee_cents else 0 end) x
                 from suqa.orders o
                where o.driver_id = d.id and o.status = 'delivered'
                  and ((o.driver_paid_at is null and o.courier_fee_cents > 0)
                       or exists (select 1 from suqa.payments pm where pm.order_id = o.id and pm.tender = 'driver' and pm.settled_at is null and pm.amount > 0))) q),
    'settlements', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'at', p.at, 'orders', p.orders_count, 'cash_cents', p.cash_cents, 'pay_cents', p.amount_cents, 'net_cents', p.cash_cents - p.amount_cents) order by p.at desc), '[]')
                      from (select * from suqa.driver_payouts where driver_id = d.id order by at desc limit 30) p),
    'settled', (select coalesce(jsonb_agg(x order by x->>'at' desc), '[]') from (
               select jsonb_build_object('number', coalesce(o.number, o.local_number), 'at', coalesce(o.delivered_at, o.closed_at, o.updated_at), 'total_cents', o.total_cents,
                        'cash_cents', (select coalesce(sum(pm.amount), 0) from suqa.payments pm where pm.order_id = o.id and pm.tender = 'driver'),
                        'pay_cents', o.courier_fee_cents) x
                 from suqa.orders o
                where o.driver_id = d.id and o.status = 'delivered' and coalesce(o.delivered_at, o.closed_at, o.updated_at) > now() - interval '31 days'
                  and not ((o.driver_paid_at is null and o.courier_fee_cents > 0)
                           or exists (select 1 from suqa.payments pm where pm.order_id = o.id and pm.tender = 'driver' and pm.settled_at is null and pm.amount > 0))
                order by coalesce(o.delivered_at, o.closed_at, o.updated_at) desc limit 60) q)
  );
end $$;
revoke all on function suqa.driver_balance(uuid) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function suqa.driver_balance(uuid) to service_role;
  end if;
end $$;

-- ---------- pos_push: today's definition + one line for order.driver_cash (owner check is inside the function) -----------
do $$
declare v_def text := pg_get_functiondef('suqa.pos_push(uuid, jsonb, int)'::regprocedure);
        v_old text := E'        when ''order.driver_pay'' then suqa._pos_order_driver_pay(v_dev, v_op->''payload'', v_user)\n';
begin
  if position('order.driver_cash' in v_def) > 0 then return; end if;
  if position(v_old in v_def) = 0 then raise exception 'pos_push: anchor not found'; end if;
  execute replace(v_def, v_old, v_old || E'        when ''order.driver_cash'' then suqa._pos_order_driver_cash(v_dev, v_op->''payload'', v_user)\n');
end $$;
revoke all on function suqa.pos_push(uuid, jsonb, int) from public, anon;
grant execute on function suqa.pos_push(uuid, jsonb, int) to authenticated;

select 'driver confirm + cash installed' as result;
