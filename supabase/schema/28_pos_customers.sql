-- 28_pos_customers.sql — POS: shop customers (shared across devices; feeds the order dialog and the debt book)   (2026-11-08)
-- Requires 27. Idempotent. Base file 04 carries shops.default_delivery_fee_usd.

alter table suqa.shops add column if not exists default_delivery_fee_usd numeric(12,2) not null default 0;

-- Canonical local key so "+961 70 000 000", "0096170000000", "070000000" and "70000000" are one customer.
create or replace function suqa._phone_key(p text) returns text language sql immutable as $$
  select regexp_replace(regexp_replace(regexp_replace(suqa._digits(p), '^00', ''), '^961', ''), '^0', '')
$$;

create table if not exists suqa.shop_customers (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references suqa.shops(id) on delete cascade,
  tenant_id     uuid not null,
  phone         text not null,                 -- as typed / last seen
  phone_key     text not null,                 -- suqa._phone_key(phone)
  name          text not null default '',
  address       jsonb not null default '{}'::jsonb,   -- { line1, notes, map_url, lat, lng }
  notes         text,
  user_id       uuid,                          -- online account when known
  orders_count  int not null default 0,
  last_order_at timestamptz,
  active        boolean not null default true,     -- 33: hidden from pickers when false
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (shop_id, phone_key)
);
create index if not exists shop_customers_name_idx on suqa.shop_customers(shop_id, lower(name));
drop trigger if exists set_updated_at on suqa.shop_customers;
create trigger set_updated_at before update on suqa.shop_customers for each row execute function suqa.set_updated_at();
drop trigger if exists sync_log on suqa.shop_customers;
create trigger sync_log after insert or update or delete on suqa.shop_customers for each row execute function suqa.sync_log_row();
alter table suqa.shop_customers enable row level security;
select suqa._policy('shop_customers','sc_read','select','authenticated','suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)');
grant select on suqa.shop_customers to authenticated;

-- Create or refresh a customer from an order / the POS. An empty name or address never overwrites a filled one.
create or replace function suqa._customer_touch(p_shop uuid, p_tenant uuid, p_phone text, p_name text, p_address jsonb, p_user uuid, p_at timestamptz, p_count boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_key text := suqa._phone_key(p_phone); v_id uuid;
begin
  if v_key is null or length(v_key) < 6 then return null; end if;
  insert into suqa.shop_customers (shop_id, tenant_id, phone, phone_key, name, address, user_id, orders_count, last_order_at)
  values (p_shop, p_tenant, p_phone, v_key, coalesce(nullif(trim(p_name), ''), ''), coalesce(p_address, '{}'::jsonb), p_user, case when p_count then 1 else 0 end, case when p_count then p_at end)
  on conflict (shop_id, phone_key) do update set
    phone = excluded.phone,
    name = case when nullif(trim(excluded.name), '') is null then suqa.shop_customers.name else excluded.name end,
    address = case when excluded.address is null or excluded.address = '{}'::jsonb then suqa.shop_customers.address else suqa.shop_customers.address || excluded.address end,
    user_id = coalesce(excluded.user_id, suqa.shop_customers.user_id),
    orders_count = suqa.shop_customers.orders_count + case when p_count then 1 else 0 end,
    last_order_at = case when p_count then greatest(coalesce(suqa.shop_customers.last_order_at, p_at), p_at) else suqa.shop_customers.last_order_at end
  returning id into v_id;
  return v_id;
end $$;

create or replace function suqa.orders_touch_customer_row(o suqa.orders) returns void
language plpgsql security definer set search_path = public as $$
declare v_phone text := o.customer_phone; v_name text := o.customer_name;
begin
  if o.parked then return; end if;
  if (v_phone is null or v_phone = '') and o.customer_id is not null then select phone, full_name into v_phone, v_name from suqa.profiles where id = o.customer_id; end if;
  if v_phone is null or v_phone = '' then return; end if;
  perform suqa._customer_touch(o.shop_id, o.tenant_id, v_phone, v_name, case when o.fulfillment = 'delivery' then o.address else null end, o.customer_id, o.placed_at, true);
end $$;

-- Every order (any channel) touches the customer. Online orders bring the profile name and the delivery address.
create or replace function suqa.orders_touch_customer() returns trigger
language plpgsql security definer set search_path = public as $$
begin perform suqa.orders_touch_customer_row(new); return new; end $$;
drop trigger if exists orders_touch_customer on suqa.orders;
create trigger orders_touch_customer after insert on suqa.orders for each row execute function suqa.orders_touch_customer();

-- POS op: { phone, name, address?, notes? } — explicit edits from the customer dialog (any role). An address sent replaces the saved one.
create or replace function suqa._pos_customer_upsert(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  v_id := suqa._customer_touch(d.shop_id, d.tenant_id, p->>'phone', p->>'name', null, null, now(), false);
  if v_id is null then raise exception 'bad_phone'; end if;
  update suqa.shop_customers set
    name = coalesce(nullif(trim(p->>'name'), ''), name),
    address = case when p ? 'address' then coalesce(p->'address', '{}'::jsonb) else address end,
    notes = case when p ? 'notes' then p->>'notes' else notes end
  where id = v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- Backfill once from existing orders (oldest first, so the latest name / address wins).
do $$ declare o suqa.orders; begin
  if not exists (select 1 from suqa.shop_customers) then
    for o in select * from suqa.orders where not parked and (customer_phone <> '' or customer_id is not null) order by placed_at loop
      perform suqa.orders_touch_customer_row(o);
    end loop;
  end if;
end $$;

-- Owner edits of the POS settings from the POS itself (whitelisted keys; the shops row then syncs to every device).
create or replace function suqa.pos_shop_settings(p_shop uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if suqa.pos_role(p_shop) <> 'owner' then raise exception 'not_owner' using errcode = 'insufficient_privilege'; end if;
  update suqa.shops set
    default_delivery_fee_usd = coalesce((p_patch->>'default_delivery_fee_usd')::numeric, default_delivery_fee_usd),
    max_discount_pct         = coalesce((p_patch->>'max_discount_pct')::numeric, max_discount_pct),
    lbp_rounding_step        = coalesce((p_patch->>'lbp_rounding_step')::int, lbp_rounding_step),
    allow_negative_stock     = coalesce((p_patch->>'allow_negative_stock')::boolean, allow_negative_stock),
    hide_online_when_zero    = coalesce((p_patch->>'hide_online_when_zero')::boolean, hide_online_when_zero),
    deduct_stock_at          = coalesce(p_patch->>'deduct_stock_at', deduct_stock_at),
    receipt_footer           = case when p_patch ? 'receipt_footer' then p_patch->>'receipt_footer' else receipt_footer end,
    offline_days             = coalesce(least(greatest((p_patch->>'offline_days')::int, 1), 90), offline_days)
  where id = p_shop;
  insert into suqa.audit_log (shop_id, tenant_id, user_id, action, ref_tbl, ref_id, after)
  select p_shop, tenant_id, auth.uid(), 'shop.settings', 'shops', p_shop::text, p_patch from suqa.shops where id = p_shop;
  return (select to_jsonb(s) - 'printer' from suqa.shops s where id = p_shop);
end $$;
grant execute on function suqa.pos_shop_settings(uuid, jsonb) to authenticated;

-- ---------- dispatcher (27 + customer.upsert) ------------------------------------------------------------------
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
      if v_role = 'cashier' and v_kind in ('rate.set','product.patch','stock.move','return.commit','order.delete') and coalesce((v_op->'payload'->>'approved_by'), '') = '' then
        raise exception 'owner_approval_required' using errcode = 'insufficient_privilege';
      end if;

      v_res := case v_kind
        when 'sale.commit'   then suqa._pos_sale_commit(v_dev, v_op->'payload', coalesce(nullif(v_op->'payload'->>'staff_user_id','')::uuid, v_user))
        when 'sale.cancel'   then suqa._pos_sale_cancel(v_dev, v_op->'payload', v_user)
        when 'order.status'  then suqa._pos_order_status(v_dev, v_op->'payload', v_user)
        when 'order.edit'    then suqa._pos_order_edit(v_dev, v_op->'payload', v_user)
        when 'order.pay'     then suqa._pos_order_pay(v_dev, v_op->'payload', v_user)
        when 'return.commit' then suqa._pos_return(v_dev, v_op->'payload', v_user)
        when 'stock.move'    then suqa._pos_stock_move(v_dev, v_op->'payload', v_user)
        when 'product.patch' then suqa._pos_product_patch(v_dev, v_op->'payload', v_user)
        when 'shift.open'    then suqa._pos_shift(v_dev, v_op->'payload', v_user, 'shift.open')
        when 'shift.close'   then suqa._pos_shift(v_dev, v_op->'payload', v_user, 'shift.close')
        when 'cash.move'     then suqa._pos_cash_move(v_dev, v_op->'payload', v_user)
        when 'debt.settle'   then suqa._pos_debt_settle(v_dev, v_op->'payload', v_user)
        when 'order.delete'  then suqa._pos_order_delete(v_dev, v_op->'payload', v_user)
        when 'customer.upsert' then suqa._pos_customer_upsert(v_dev, v_op->'payload', v_user)
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



-- ---------- snapshot (26 + shop_customers) ----------------------------------------------------------------------
create or replace function suqa.pos_snapshot(p_device uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_dev suqa.devices; v_role text; v_cursor bigint; v_owner boolean;
begin
  select * into v_dev from suqa.devices where id = p_device;
  if not found then raise exception 'device_not_found'; end if;
  if v_dev.revoked_at is not null then raise exception 'device_revoked'; end if;
  v_role := suqa.pos_role(v_dev.shop_id);
  if v_role is null then raise exception 'not_a_member' using errcode = 'insufficient_privilege'; end if;
  v_owner := v_role = 'owner';
  select coalesce(max(seq), 0) into v_cursor from suqa.sync_log;

  return jsonb_build_object(
    'cursor', v_cursor, 'server_now', now(), 'role', v_role,
    'device', jsonb_build_object('id', v_dev.id, 'prefix', v_dev.prefix, 'name', v_dev.name),
    'shop', (select to_jsonb(s) - 'commission_rate' - 'cover_url' - 'location' from suqa.shops s where s.id = v_dev.shop_id),
    'categories', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from suqa.categories c where c.tenant_id = v_dev.tenant_id),
    'products', (select coalesce(jsonb_agg(case when v_owner then to_jsonb(p) else to_jsonb(p) - 'cost_cents' end), '[]')
                   from suqa.products p where p.shop_id = v_dev.shop_id and p.is_active),
    'product_barcodes', (select coalesce(jsonb_agg(to_jsonb(b)), '[]') from suqa.product_barcodes b where b.shop_id = v_dev.shop_id),
    'quick_buttons', (select coalesce(jsonb_agg(to_jsonb(q)), '[]') from suqa.quick_buttons q where q.shop_id = v_dev.shop_id),
    'exchange_rates', (select coalesce(jsonb_agg(to_jsonb(r)), '[]') from (select * from suqa.exchange_rates where shop_id = v_dev.shop_id order by effective_at desc limit 50) r),
    'shop_members', (select coalesce(jsonb_agg(to_jsonb(m) || jsonb_build_object('full_name', p.full_name)), '[]')
                       from suqa.shop_members m left join suqa.profiles p on p.id = m.user_id where m.shop_id = v_dev.shop_id),
    'devices', (select coalesce(jsonb_agg(to_jsonb(d)), '[]') from suqa.devices d where d.shop_id = v_dev.shop_id),
    'orders', (select coalesce(jsonb_agg(to_jsonb(o)), '[]') from suqa.orders o
                where o.shop_id = v_dev.shop_id and (o.closed_at is null or o.placed_at > now() - interval '7 days' or o.id in (select order_id from suqa.payments where shop_id = v_dev.shop_id and tender = 'unpaid'))),
    'order_items', (select coalesce(jsonb_agg(case when v_owner then to_jsonb(i) else to_jsonb(i) - 'cost_cents' end), '[]')
                      from suqa.order_items i join suqa.orders o on o.id = i.order_id
                     where o.shop_id = v_dev.shop_id and (o.closed_at is null or o.placed_at > now() - interval '7 days' or o.id in (select order_id from suqa.payments where shop_id = v_dev.shop_id and tender = 'unpaid'))),
    'payments', (select coalesce(jsonb_agg(to_jsonb(p)), '[]') from suqa.payments p join suqa.orders o on o.id = p.order_id
                  where o.shop_id = v_dev.shop_id and (o.closed_at is null or o.placed_at > now() - interval '7 days' or o.id in (select order_id from suqa.payments where shop_id = v_dev.shop_id and tender = 'unpaid'))),
    'shifts', (select coalesce(jsonb_agg(to_jsonb(s)), '[]') from suqa.shifts s where s.shop_id = v_dev.shop_id and (s.closed_at is null or s.opened_at > now() - interval '7 days')),
    'cash_moves', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from suqa.cash_moves c join suqa.shifts s on s.id = c.shift_id
                    where s.shop_id = v_dev.shop_id and (s.closed_at is null or s.opened_at > now() - interval '7 days')),
    'shop_customers', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from suqa.shop_customers x where x.shop_id = v_dev.shop_id),
    'debt_settlements', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from suqa.debt_settlements x where x.shop_id = v_dev.shop_id),
    'debt_allocations', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from suqa.debt_allocations x where x.shop_id = v_dev.shop_id),
    'stock_moves', (select coalesce(jsonb_agg(to_jsonb(m)), '[]') from (select * from suqa.stock_moves where shop_id = v_dev.shop_id order by at desc limit 2000) m)
  );
end $$;

select 'pos customers installed' as result;
