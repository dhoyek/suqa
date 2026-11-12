-- 37_pos_drivers.sql — shop drivers (drivers-lite)   (2026-11-09)
-- Requires 34. Idempotent. Base files: 06 (orders.driver_id).
-- A shop's contracted drivers: just a name and a WhatsApp number — no account needed. If a user signs up with that
-- number, the driver row is linked (user_id) so the association courier app can show him his orders too.
--   shop_drivers                      per-shop list, synced to POS devices (snapshot + sync_log)
--   driver.upsert { id?, name, phone, vehicle, active, available, notes }
--   order.status  + { driver_id }     assignment travels with the status change (null = the shop delivers itself)
--   order_event_payload               carries 'driver' so the webhook can message him

create table if not exists suqa.shop_drivers (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references suqa.shops(id) on delete cascade,
  tenant_id     uuid not null references suqa.tenants(id) on delete cascade,
  name          text not null,
  phone         text not null,
  phone_key     text not null,                             -- suqa._phone_key(phone)
  vehicle       text,                                      -- 'moto', 'car', … free text
  active        boolean not null default true,
  available     boolean not null default true,             -- quick on/off: "not today"
  notes         text,
  user_id       uuid references auth.users(id) on delete set null,   -- linked when a user with this number exists
  last_used_at  timestamptz,
  pay_mode      text check (pay_mode is null or pay_mode in ('none','per_delivery','delivery_fee')),   -- 60: null = follow the shop default
  pay_cents     int  check (pay_cents is null or pay_cents >= 0),                                    -- 60: fixed amount per delivery when pay_mode = 'per_delivery'
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (shop_id, phone_key)
);
alter table suqa.shop_drivers add column if not exists user_id uuid references auth.users(id) on delete set null;
alter table suqa.shop_drivers add column if not exists last_used_at timestamptz;
alter table suqa.orders add column if not exists driver_id uuid references suqa.shop_drivers(id) on delete set null;
create index if not exists orders_driver_idx on suqa.orders (driver_id) where driver_id is not null;

do $$ declare t text; begin
  foreach t in array array['shop_drivers'] loop
    execute format('drop trigger if exists set_updated_at on suqa.%I', t);
    execute format('create trigger set_updated_at before update on suqa.%I for each row execute function suqa.set_updated_at()', t);
    execute format('drop trigger if exists sync_log on suqa.%I', t);
    execute format('create trigger sync_log after insert or update or delete on suqa.%I for each row execute function suqa.sync_log_row()', t);
    execute format('alter table suqa.%I enable row level security', t);
    execute format('grant select on suqa.%I to authenticated', t);
  end loop;
end $$;
select suqa._policy('shop_drivers', 'shop_drivers_read', 'select', 'authenticated', 'suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id) or user_id = auth.uid()');

-- link to an account by number (now, and whenever a profile gets a phone)
create or replace function suqa._driver_link(p_id uuid) returns void language sql security definer set search_path = public as $$
  update suqa.shop_drivers d set user_id = (select u.id from auth.users u where suqa._phone_key(u.phone) = d.phone_key limit 1) where d.id = p_id and d.user_id is null;
$$;
create or replace function suqa.drivers_link_profile() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.phone is not null then update suqa.shop_drivers set user_id = new.id where user_id is null and phone_key = suqa._phone_key(new.phone); end if;
  return new;
end $$;
drop trigger if exists drivers_link_profile on suqa.profiles;
create trigger drivers_link_profile after insert or update of phone on suqa.profiles for each row execute function suqa.drivers_link_profile();

-- ---------- driver.upsert ----------------------------------------------------------------------------------------------
create or replace function suqa._pos_driver_upsert(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_key text := suqa._phone_key(p->>'phone'); v_id uuid := coalesce(nullif(p->>'id', '')::uuid, gen_random_uuid());
begin
  if v_key is null or length(v_key) < 6 then raise exception 'bad_phone'; end if;
  if coalesce(trim(p->>'name'), '') = '' then raise exception 'bad_name'; end if;
  insert into suqa.shop_drivers (id, shop_id, tenant_id, name, phone, phone_key, vehicle, active, available, notes)
  values (v_id, d.shop_id, d.tenant_id, trim(p->>'name'), trim(p->>'phone'), v_key, nullif(trim(coalesce(p->>'vehicle', '')), ''),
          coalesce((p->>'active')::boolean, true), coalesce((p->>'available')::boolean, true), nullif(trim(coalesce(p->>'notes', '')), ''))
  on conflict (shop_id, phone_key) do update set
    name = excluded.name, phone = excluded.phone, vehicle = excluded.vehicle, notes = excluded.notes,
    active = case when p ? 'active' then excluded.active else suqa.shop_drivers.active end,
    available = case when p ? 'available' then excluded.available else suqa.shop_drivers.available end
  returning id into v_id;
  perform suqa._driver_link(v_id);
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- ---------- order.status (24 + driver) ---------------------------------------------------------------------------------
create or replace function suqa._pos_order_status(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_order suqa.orders; v_m record; v_drv suqa.shop_drivers;
begin
  select * into v_order from suqa.orders where id = (p->>'id')::uuid and shop_id = d.shop_id;
  if not found then raise exception 'order_not_found'; end if;
  -- driver assignment travels with the status change ('driver_id' key present: a driver, or null = the shop delivers itself)
  if p ? 'driver_id' then
    if nullif(p->>'driver_id', '') is null then
      update suqa.orders set driver_id = null where id = v_order.id;
    else
      select * into v_drv from suqa.shop_drivers where id = (p->>'driver_id')::uuid and shop_id = d.shop_id;
      if v_drv.id is null then raise exception 'driver_not_found'; end if;
      update suqa.orders set driver_id = v_drv.id, courier_name = v_drv.name where id = v_order.id;
      update suqa.shop_drivers set last_used_at = now() where id = v_drv.id;
    end if;
  end if;
  if v_order.status::text = p->>'status' then return jsonb_build_object('status', v_order.status, 'noop', true); end if;
  update suqa.orders
     set status = (p->>'status')::suqa.order_status,
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

-- ---------- order event payload (32 + driver) --------------------------------------------------------------------------
create or replace function suqa.order_event_payload(p_order suqa.orders, p_event text, p_old_status suqa.order_status)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'event',      p_event,
    'old_status', p_old_status,
    'phone_number_id', suqa.wa_sender_for_order(p_order.id),
    'channel', p_order.channel,
    'order', jsonb_build_object(
      'id', p_order.id, 'number', p_order.number, 'status', p_order.status, 'tenant_id', p_order.tenant_id,
      'basket_id', p_order.basket_id, 'basket_seq', p_order.basket_seq,
      'fulfillment', p_order.fulfillment, 'notify_customer', p_order.notify_customer,
      'customer_name', p_order.customer_name, 'customer_phone', p_order.customer_phone, 'customer_notes', p_order.customer_notes,
      'address', p_order.address, 'subtotal_usd', p_order.subtotal_usd, 'delivery_fee_usd', p_order.delivery_fee_usd,
      'total_usd', p_order.total_usd, 'fx_lbp_rate', p_order.fx_lbp_rate,
      'reject_reason', p_order.reject_reason, 'eta_minutes', p_order.eta_minutes, 'shop_notes', p_order.shop_notes,
      'courier_id', p_order.courier_id, 'driver_id', p_order.driver_id, 'courier_name', p_order.courier_name, 'courier_fee_cents', p_order.courier_fee_cents,
      'needed_at', p_order.needed_at, 'placed_at', p_order.placed_at),
    'driver', (select jsonb_build_object('id', dr.id, 'name', dr.name, 'phone', dr.phone, 'vehicle', dr.vehicle) from suqa.shop_drivers dr where dr.id = p_order.driver_id),
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.name, 'unit', i.unit, 'quantity', i.quantity, 'line_total_usd', i.line_total_usd, 'notes', i.notes))
                         from suqa.order_items i where i.order_id = p_order.id and not i.voided), '[]'::jsonb),
    'shop', (select jsonb_build_object('id', s.id, 'slug', s.slug, 'name', s.name, 'whatsapp', s.whatsapp, 'phone', s.phone,
                                       'address', s.address_text, 'location', s.location, 'notify_stages', s.notify_stages)
               from suqa.shops s where s.id = p_order.shop_id),
    'tenant', (select jsonb_build_object('id', t.id, 'slug', t.slug, 'brand_name', t.brand_name, 'default_locale', t.default_locale,
                                         'display_currency', t.display_currency,
                                         'courier_enabled', coalesce((t.settings->>'courier_enabled')::boolean, false),
                                         'delivery_mode', coalesce(t.settings->>'delivery_mode', 'per_shop'),
                                         'notify_stages', coalesce(t.settings->'notify_stages', '["accepted","ready","out_for_delivery","rejected"]'::jsonb))
                 from suqa.tenants t where t.id = p_order.tenant_id),
    'courier_phone', (select p.phone from suqa.profiles p where p.id = p_order.courier_id),
    'couriers', coalesce((select jsonb_agg(p.phone) from suqa.couriers c join suqa.profiles p on p.id = c.user_id
                           where c.tenant_id = p_order.tenant_id and c.is_active and p.phone is not null), '[]'::jsonb)
  )
$$;

-- ---------- snapshot (30 + shop_drivers) -------------------------------------------------------------------------------
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
    'suppliers', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from suqa.suppliers x where x.shop_id = v_dev.shop_id),
    'shop_drivers', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from suqa.shop_drivers x where x.shop_id = v_dev.shop_id),
    'purchases', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from suqa.purchases x where x.shop_id = v_dev.shop_id and x.at > now() - interval '180 days'),
    'purchase_lines', (select coalesce(jsonb_agg(to_jsonb(l)), '[]') from suqa.purchase_lines l join suqa.purchases x on x.id = l.purchase_id where x.shop_id = v_dev.shop_id and x.at > now() - interval '180 days'),
    'supplier_payments', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from suqa.supplier_payments x where x.shop_id = v_dev.shop_id and x.at > now() - interval '180 days'),
    'shop_customers', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from suqa.shop_customers x where x.shop_id = v_dev.shop_id),
    'debt_settlements', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from suqa.debt_settlements x where x.shop_id = v_dev.shop_id),
    'debt_allocations', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from suqa.debt_allocations x where x.shop_id = v_dev.shop_id),
    'stock_moves', (select coalesce(jsonb_agg(to_jsonb(m)), '[]') from (select * from suqa.stock_moves where shop_id = v_dev.shop_id order by at desc limit 2000) m)
  );
end $$;

-- ---------- dispatcher (34 + driver.upsert) -----------------------------------------------------------------------------
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
      if v_role = 'cashier' and v_kind in ('rate.set','product.patch','stock.move','return.commit','order.delete','purchase.commit','purchase.void','supplier.pay','customer.merge','customer.delete','supplier.merge','supplier.delete') and coalesce((v_op->'payload'->>'approved_by'), '') = '' then
        raise exception 'owner_approval_required' using errcode = 'insufficient_privilege';
      end if;

      v_res := case v_kind
        when 'sale.commit'   then suqa._pos_sale_commit(v_dev, v_op->'payload', coalesce(nullif(v_op->'payload'->>'staff_user_id','')::uuid, v_user))
        when 'sale.cancel'   then suqa._pos_sale_cancel(v_dev, v_op->'payload', v_user)
        when 'order.status'  then suqa._pos_order_status(v_dev, v_op->'payload', v_user)
        when 'order.edit'    then suqa._pos_order_edit(v_dev, v_op->'payload', v_user)
        when 'order.needed'  then suqa._pos_order_needed(v_dev, v_op->'payload', v_user)
        when 'driver.upsert' then suqa._pos_driver_upsert(v_dev, v_op->'payload', v_user)
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

select 'pos drivers installed' as result;
