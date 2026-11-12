-- 60_driver_pay.sql — how the shop's drivers are paid, what each delivery earns, and settling with a driver.   (2026-11-12)
--
-- PAY RULE — a shop default that applies to all its drivers, and an override per driver (one may be on the payroll while another
-- is paid per order):
--     'none'          nothing per order (salaried)
--     'per_delivery'  a fixed amount per delivery            (…_pay_cents, USD cents)
--     'delivery_fee'  the delivery fee the customer paid on that order
--   shops.driver_pay_mode / driver_pay_cents            the default
--   shop_drivers.pay_mode / pay_cents                   null = follow the shop default
--   pos_set_driver_pay(shop, driver|null, mode|null, cents)   owner only; driver null → sets the shop default, mode null → driver follows the default
--
-- WHAT A DELIVERY EARNS — orders.courier_fee_cents (exists since 25: "paid to the driver"). It is fixed when the order becomes
-- 'delivered' with a shop driver on it (trigger orders_driver_pay, from the rule above) unless the till already entered a fee.
-- The owner can change it while it is not settled (op order.driver_pay).
--
-- SETTLING — two separate records so nothing is counted twice:
--   * the customer's money is the order's payment (as today, full amount, into the shift when the shop records it)
--   * the driver's pay is a row in driver_payouts covering a set of deliveries; each delivery can be in ONE payout only
--     (orders.driver_paid_at / driver_payout_id). The amount is computed here from the orders, never taken from the device.
--     from_drawer = true → the till also posts the matching cash-out on the open shift (as it does for supplier payments).
--   op driver.payout { id, driver_id, order_ids[], currency, amount, rate, from_drawer, shift_id, note, at }
--   Fees typed at hand-over before this file were paid from the drawer on the spot → marked as settled (backfill below).
--
-- REPORT — pos_driver_report(shop, from, to): owner only. Per driver: deliveries, value, times, pay earned / settled / owed, cash
-- he is holding now (orders out with him, not yet paid in), the deliveries themselves and past payouts.
--
-- Changes: columns on shops, shop_drivers, orders; new table driver_payouts; trigger; 4 functions; pos_push re-created from 54
-- with the two new kinds. Base files 04 (shops), 06 (orders) and 37 (shop_drivers) list the new columns. Requires 37, 54, 58.
-- Idempotent.

alter table suqa.shops        add column if not exists driver_pay_mode  text not null default 'none';
alter table suqa.shops        add column if not exists driver_pay_cents int  not null default 0;
alter table suqa.shop_drivers add column if not exists pay_mode  text;
alter table suqa.shop_drivers add column if not exists pay_cents int;
alter table suqa.orders       add column if not exists driver_paid_at   timestamptz;
alter table suqa.orders       add column if not exists driver_payout_id uuid;
alter table suqa.shops        drop constraint if exists shops_driver_pay_mode_check;
alter table suqa.shops        add  constraint shops_driver_pay_mode_check check (driver_pay_mode in ('none','per_delivery','delivery_fee') and driver_pay_cents >= 0);
alter table suqa.shop_drivers drop constraint if exists shop_drivers_pay_mode_check;
alter table suqa.shop_drivers add  constraint shop_drivers_pay_mode_check check ((pay_mode is null or pay_mode in ('none','per_delivery','delivery_fee')) and (pay_cents is null or pay_cents >= 0));
create index if not exists orders_driver_unpaid_idx on suqa.orders (driver_id) where driver_id is not null and driver_paid_at is null;

create table if not exists suqa.driver_payouts (
  id              uuid primary key,
  shop_id         uuid not null references suqa.shops(id) on delete cascade,
  tenant_id       uuid not null,
  driver_id       uuid not null references suqa.shop_drivers(id) on delete restrict,
  orders_count    int  not null,
  amount_cents    bigint not null,                    -- the driver's pay for those deliveries, USD cents (sum of orders.courier_fee_cents)
  currency        text not null check (currency in ('usd','lbp')),
  amount          bigint not null,                    -- what was handed to him, in `currency` (USD cents / LBP)
  rate            int  not null,
  from_drawer     boolean not null default false,     -- true → the POS also posted a cash-out on the open shift
  shift_id        uuid,
  collected_cents bigint not null default 0,          -- value of those deliveries (information: what he brought in)
  note            text,
  user_id         uuid,
  device_id       uuid,
  at              timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
create index if not exists driver_payouts_driver_idx on suqa.driver_payouts (driver_id, at desc);
alter table suqa.driver_payouts enable row level security;
revoke all on table suqa.driver_payouts from public, anon;
grant select on table suqa.driver_payouts to authenticated;
select suqa._policy('driver_payouts', 'driver_payouts_read', 'select', 'authenticated', 'suqa.is_shop_owner(shop_id) or suqa.is_tenant_member(tenant_id)');

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'orders_driver_payout_fk') then
    alter table suqa.orders add constraint orders_driver_payout_fk foreign key (driver_payout_id) references suqa.driver_payouts(id) on delete set null;
  end if;
end $$;

-- fees typed at hand-over so far left the drawer on the spot: they are settled
update suqa.orders set driver_paid_at = coalesce(closed_at, delivered_at, updated_at)
 where courier_fee_cents > 0 and driver_paid_at is null and status = 'delivered';

-- ---------- the rule ------------------------------------------------------------------------------------------------
create or replace function suqa.driver_pay_for(p_driver uuid, p_delivery_fee_usd numeric) returns int
language sql stable security definer set search_path = public as $$
  select case coalesce(d.pay_mode, s.driver_pay_mode)
           when 'per_delivery' then coalesce(case when d.pay_mode is not null then d.pay_cents end, s.driver_pay_cents, 0)
           when 'delivery_fee' then greatest(0, round(coalesce(p_delivery_fee_usd, 0) * 100))::int
           else 0 end
    from suqa.shop_drivers d join suqa.shops s on s.id = d.shop_id
   where d.id = p_driver
$$;
revoke all on function suqa.driver_pay_for(uuid, numeric) from public, anon, authenticated;

create or replace function suqa.orders_driver_pay_trg() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'delivered' and old.status is distinct from new.status and new.driver_id is not null
     and coalesce(new.courier_fee_cents, 0) = 0 and new.driver_paid_at is null then
    new.courier_fee_cents := coalesce(suqa.driver_pay_for(new.driver_id, new.delivery_fee_usd), 0);
  end if;
  return new;
end $$;
drop trigger if exists orders_driver_pay on suqa.orders;
create trigger orders_driver_pay before update on suqa.orders for each row execute function suqa.orders_driver_pay_trg();

create or replace function suqa.pos_set_driver_pay(p_shop uuid, p_driver uuid, p_mode text, p_cents int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tenant uuid;
begin
  if suqa.pos_role(p_shop) is distinct from 'owner' then raise exception 'owner_only' using errcode = 'insufficient_privilege'; end if;
  if p_mode is not null and p_mode not in ('none','per_delivery','delivery_fee') then raise exception 'bad_mode'; end if;
  if coalesce(p_cents, 0) < 0 then raise exception 'bad_amount'; end if;
  select tenant_id into v_tenant from suqa.shops where id = p_shop;
  if p_driver is null then
    if p_mode is null then raise exception 'bad_mode'; end if;
    update suqa.shops set driver_pay_mode = p_mode, driver_pay_cents = case when p_mode = 'per_delivery' then coalesce(p_cents, 0) else 0 end where id = p_shop;
  else
    update suqa.shop_drivers set pay_mode = p_mode, pay_cents = case when p_mode = 'per_delivery' then coalesce(p_cents, 0) else null end
     where id = p_driver and shop_id = p_shop;
    if not found then raise exception 'driver_not_found'; end if;
  end if;
  insert into suqa.audit_log (shop_id, tenant_id, user_id, action, ref_tbl, ref_id, after)
  values (p_shop, v_tenant, auth.uid(), 'driver.pay_rule', case when p_driver is null then 'shops' else 'shop_drivers' end, coalesce(p_driver, p_shop)::text, jsonb_build_object('mode', p_mode, 'cents', p_cents));
  return jsonb_build_object('ok', true);
end $$;
revoke all on function suqa.pos_set_driver_pay(uuid, uuid, text, int) from public, anon;
grant execute on function suqa.pos_set_driver_pay(uuid, uuid, text, int) to authenticated;

-- ---------- order.driver_pay { id, cents } — owner changes what one delivery earns (only while not settled) --------------
create or replace function suqa._pos_order_driver_pay(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_o suqa.orders; v_cents int := (p->>'cents')::int;
begin
  if suqa.pos_role(d.shop_id) is distinct from 'owner' then raise exception 'owner_only' using errcode = 'insufficient_privilege'; end if;
  if v_cents is null or v_cents < 0 then raise exception 'bad_amount'; end if;
  select * into v_o from suqa.orders where id = (p->>'id')::uuid and shop_id = d.shop_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if v_o.driver_paid_at is not null then raise exception 'already_settled'; end if;
  update suqa.orders set courier_fee_cents = v_cents where id = v_o.id;
  return jsonb_build_object('ok', true, 'cents', v_cents);
end $$;

-- ---------- driver.payout ---------------------------------------------------------------------------------------------
create or replace function suqa._pos_driver_payout(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid := (p->>'id')::uuid; v_driver uuid := (p->>'driver_id')::uuid; v_at timestamptz := coalesce((p->>'at')::timestamptz, now());
        v_ids uuid[]; v_n int; v_sum bigint; v_val bigint;
begin
  if exists (select 1 from suqa.driver_payouts where id = v_id) then return jsonb_build_object('ok', true, 'replayed', true); end if;
  if not exists (select 1 from suqa.shop_drivers where id = v_driver and shop_id = d.shop_id) then raise exception 'driver_not_found'; end if;
  select array_agg(x::uuid) into v_ids from jsonb_array_elements_text(coalesce(p->'order_ids', '[]'::jsonb)) x;
  if v_ids is null then raise exception 'nothing_to_pay'; end if;
  -- the payout row first (orders point at it), then claim the deliveries: only this driver's delivered, not yet settled ones
  -- count, and the amount is theirs — never the device's
  insert into suqa.driver_payouts (id, shop_id, tenant_id, driver_id, orders_count, amount_cents, currency, amount, rate, from_drawer, shift_id, collected_cents, note, user_id, device_id, at)
  values (v_id, d.shop_id, d.tenant_id, v_driver, 0, 0, coalesce(p->>'currency', 'usd'), 0, coalesce((p->>'rate')::int, 89500),
          coalesce((p->>'from_drawer')::boolean, false), nullif(p->>'shift_id', '')::uuid, 0, p->>'note', p_user, d.id, v_at);
  with upd as (
    update suqa.orders set driver_paid_at = v_at, driver_payout_id = v_id
     where id = any(v_ids) and shop_id = d.shop_id and driver_id = v_driver and status = 'delivered' and driver_paid_at is null
    returning courier_fee_cents, total_cents
  ) select count(*), coalesce(sum(courier_fee_cents), 0), coalesce(sum(total_cents), 0) into v_n, v_sum, v_val from upd;
  if v_n = 0 then raise exception 'nothing_to_pay'; end if;      -- undoes the row above
  update suqa.driver_payouts set orders_count = v_n, amount_cents = v_sum, collected_cents = v_val,
         amount = coalesce((p->>'amount')::bigint, v_sum)
   where id = v_id;
  return jsonb_build_object('ok', true, 'orders', v_n, 'amount_cents', v_sum);
end $$;

-- ---------- report ----------------------------------------------------------------------------------------------------
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
        'holding_cents', (select coalesce(sum(greatest(0, o.total_cents - coalesce((select sum(case when p.currency = 'lbp' then round(p.amount * 100.0 / nullif(o.rate_lbp_per_usd, 0)) else p.amount end) from suqa.payments p where p.order_id = o.id and p.tender <> 'unpaid'), 0))), 0)
                            from suqa.orders o where o.driver_id = d.id and o.status = 'out_for_delivery')
      ) order by d.active desc, d.name), '[]') from suqa.shop_drivers d where d.shop_id = p_shop),
    'orders', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', o.id, 'number', coalesce(o.number, o.local_number), 'driver_id', o.driver_id, 'status', o.status, 'customer', o.customer_name,
        'total_cents', o.total_cents, 'delivery_fee_cents', round(coalesce(o.delivery_fee_usd, 0) * 100), 'pay_cents', o.courier_fee_cents,
        'paid_at', o.driver_paid_at, 'payout_id', o.driver_payout_id, 'at', coalesce(o.delivered_at, o.closed_at, o.updated_at), 'placed_at', o.placed_at,
        'ack_at', o.driver_ack_at, 'picked_at', o.driver_picked_at, 'handed_at', o.driver_delivered_at,
        'due_cents', greatest(0, o.total_cents - coalesce((select sum(case when p.currency = 'lbp' then round(p.amount * 100.0 / nullif(o.rate_lbp_per_usd, 0)) else p.amount end) from suqa.payments p where p.order_id = o.id and p.tender <> 'unpaid'), 0))
      ) order by coalesce(o.delivered_at, o.closed_at, o.updated_at) desc), '[]')
      from suqa.orders o
     where o.shop_id = p_shop and o.driver_id is not null
       and (   (o.status = 'delivered' and coalesce(o.delivered_at, o.closed_at, o.updated_at) >= v_from and coalesce(o.delivered_at, o.closed_at, o.updated_at) < v_to)
            or (o.status = 'delivered' and o.driver_paid_at is null and o.courier_fee_cents > 0)      -- still owed, whatever its date
            or  o.status = 'out_for_delivery')),
    'payouts', (select coalesce(jsonb_agg(to_jsonb(x) order by x.at desc), '[]') from (select * from suqa.driver_payouts where shop_id = p_shop order by at desc limit 200) x)
  );
end $$;
revoke all on function suqa.pos_driver_report(uuid, date, date) from public, anon;
grant execute on function suqa.pos_driver_report(uuid, date, date) to authenticated;

-- ---------- dispatcher (54 + driver.payout, order.driver_pay) ----------------------------------------------------------
create or replace function suqa.pos_push(p_device uuid, p_ops jsonb, p_pending int default 0)
returns jsonb
language plpgsql security definer set search_path = public as $$
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
      if v_role = 'stock' and v_kind not in ('stock.move','product.patch') then raise exception 'role_not_allowed' using errcode = 'insufficient_privilege'; end if;
      if v_role = 'cashier' and v_kind in ('rate.set','product.patch','stock.move','return.commit','order.delete','purchase.commit','purchase.void','supplier.pay','customer.merge','customer.delete','supplier.merge','supplier.delete','driver.delete','debt.unsettle') and coalesce((v_op->'payload'->>'approved_by'), '') = '' then
        raise exception 'owner_approval_required' using errcode = 'insufficient_privilege';
      end if;

      v_res := case v_kind
        when 'sale.commit'   then suqa._pos_sale_commit(v_dev, v_op->'payload', coalesce(nullif(v_op->'payload'->>'staff_user_id','')::uuid, v_user))
        when 'sale.cancel'   then suqa._pos_sale_cancel(v_dev, v_op->'payload', v_user)
        when 'order.status'  then suqa._pos_order_status(v_dev, v_op->'payload', v_user)
        when 'order.edit'    then suqa._pos_order_edit(v_dev, v_op->'payload', v_user)
        when 'order.needed'  then suqa._pos_order_needed(v_dev, v_op->'payload', v_user)
        when 'driver.upsert' then suqa._pos_driver_upsert(v_dev, v_op->'payload', v_user)
        when 'driver.delete' then suqa._pos_driver_delete(v_dev, v_op->'payload', v_user)
        when 'order.pay'     then suqa._pos_order_pay(v_dev, v_op->'payload', v_user)
        when 'return.commit' then suqa._pos_return(v_dev, v_op->'payload', v_user)
        when 'stock.move'    then suqa._pos_stock_move(v_dev, v_op->'payload', v_user)
        when 'product.patch' then suqa._pos_product_patch(v_dev, v_op->'payload', v_user)
        when 'shift.open'    then suqa._pos_shift(v_dev, v_op->'payload', v_user, 'shift.open')
        when 'shift.close'   then suqa._pos_shift(v_dev, v_op->'payload', v_user, 'shift.close')
        when 'cash.move'     then suqa._pos_cash_move(v_dev, v_op->'payload', v_user)
        when 'debt.settle'   then suqa._pos_debt_settle(v_dev, v_op->'payload', v_user)
        when 'debt.unsettle' then suqa._pos_debt_unsettle(v_dev, v_op->'payload', v_user)
        when 'driver.payout' then suqa._pos_driver_payout(v_dev, v_op->'payload', v_user)
        when 'order.driver_pay' then suqa._pos_order_driver_pay(v_dev, v_op->'payload', v_user)
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
end $$;

-- internal helpers are not callable from the API (58)
revoke all on function suqa._pos_driver_payout(suqa.devices, jsonb, uuid) from public, anon, authenticated;
revoke all on function suqa._pos_order_driver_pay(suqa.devices, jsonb, uuid) from public, anon, authenticated;
revoke all on function suqa.orders_driver_pay_trg() from public, anon, authenticated;

select 'driver pay installed' as result;
