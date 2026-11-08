-- 34_pos_m12.sql — scheduled orders & customer address book   (2026-11-08)
-- Requires 33. Idempotent. Base files: 06 (orders.needed_at), 28 (shop_customers.addresses).
--   orders.needed_at timestamptz          when the customer wants it (sale.commit payload needed_at; free text stays in customer_notes)
--   shop_customers.addresses jsonb[]      address book: [{id,label,line1,map_url,lat,lng,last_used_at}] — remembered from every delivery order,
--                                         editable from the POS (customer.upsert with addresses)
--   order.needed { id, needed_at }        move the time of an existing order
--   indexes for volume: orders (shop_id, placed_at), (shop_id, needed_at) ; prune_sync_log(days) for housekeeping

alter table suqa.orders add column if not exists needed_at timestamptz;
alter table suqa.shop_customers add column if not exists addresses jsonb not null default '[]'::jsonb;
create index if not exists orders_shop_placed_idx on suqa.orders (shop_id, placed_at desc);
create index if not exists orders_shop_needed_idx on suqa.orders (shop_id, needed_at) where needed_at is not null;

-- ---------- address book helper: same pin (~10 m) or same text = same address; otherwise appended ------------------
create or replace function suqa._addr_remember(p_book jsonb, p_addr jsonb, p_at timestamptz) returns jsonb
language plpgsql as $$
declare v_book jsonb := coalesce(p_book, '[]'::jsonb); v_out jsonb := '[]'::jsonb; v_a jsonb; v_hit boolean := false;
        v_line text := nullif(lower(trim(coalesce(p_addr->>'line1', ''))), ''); v_lat numeric := (p_addr->>'lat')::numeric; v_lng numeric := (p_addr->>'lng')::numeric;
begin
  if p_addr is null or jsonb_typeof(p_addr) <> 'object' or (v_line is null and v_lat is null) or coalesce((p_addr->>'transient')::boolean, false) then return v_book; end if;
  for v_a in select * from jsonb_array_elements(v_book) loop
    if not v_hit and ((v_lat is not null and (v_a->>'lat')::numeric is not null and abs((v_a->>'lat')::numeric - v_lat) < 0.0001 and abs((v_a->>'lng')::numeric - v_lng) < 0.0001)
                      or (v_line is not null and lower(trim(coalesce(v_a->>'line1', ''))) = v_line)) then
      v_hit := true;
      v_a := v_a || jsonb_strip_nulls(jsonb_build_object('line1', coalesce(nullif(p_addr->>'line1', ''), v_a->>'line1'), 'map_url', coalesce(nullif(p_addr->>'map_url', ''), v_a->>'map_url'),
                                                        'lat', coalesce(v_lat, (v_a->>'lat')::numeric), 'lng', coalesce(v_lng, (v_a->>'lng')::numeric), 'last_used_at', p_at));
    end if;
    v_out := v_out || jsonb_build_array(v_a);
  end loop;
  if not v_hit then
    v_out := v_out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('id', gen_random_uuid(), 'label', coalesce(p_addr->>'label', ''), 'line1', p_addr->>'line1', 'map_url', p_addr->>'map_url', 'lat', v_lat, 'lng', v_lng, 'last_used_at', p_at)));
  end if;
  return v_out;
end $$;

-- ---------- customer touch (28 + address book) ----------------------------------------------------------------------
create or replace function suqa._customer_touch(p_shop uuid, p_tenant uuid, p_phone text, p_name text, p_address jsonb, p_user uuid, p_at timestamptz, p_count boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_key text := suqa._phone_key(p_phone); v_id uuid;
begin
  if v_key is null or length(v_key) < 6 then return null; end if;
  insert into suqa.shop_customers (shop_id, tenant_id, phone, phone_key, name, address, addresses, user_id, orders_count, last_order_at)
  values (p_shop, p_tenant, p_phone, v_key, coalesce(nullif(trim(p_name), ''), ''), coalesce(p_address, '{}'::jsonb), suqa._addr_remember('[]'::jsonb, p_address, p_at), p_user, case when p_count then 1 else 0 end, case when p_count then p_at end)
  on conflict (shop_id, phone_key) do update set
    phone = excluded.phone,
    name = case when nullif(trim(excluded.name), '') is null then suqa.shop_customers.name else excluded.name end,
    address = case when excluded.address is null or excluded.address = '{}'::jsonb then suqa.shop_customers.address else suqa.shop_customers.address || excluded.address end,
    addresses = suqa._addr_remember(suqa.shop_customers.addresses, excluded.address, p_at),
    user_id = coalesce(excluded.user_id, suqa.shop_customers.user_id),
    orders_count = suqa.shop_customers.orders_count + case when p_count then 1 else 0 end,
    last_order_at = case when p_count then greatest(coalesce(suqa.shop_customers.last_order_at, p_at), p_at) else suqa.shop_customers.last_order_at end
  returning id into v_id;
  return v_id;
end $$;

-- ---------- customer.upsert (33 + addresses) ---------------------------------------------------------------------------
create or replace function suqa._pos_customer_upsert(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  v_id := suqa._customer_touch(d.shop_id, d.tenant_id, p->>'phone', p->>'name', null, null, now(), false);
  if v_id is null then raise exception 'bad_phone'; end if;
  update suqa.shop_customers set
    name = coalesce(nullif(trim(p->>'name'), ''), name),
    address = case when p ? 'address' then coalesce(p->'address', '{}'::jsonb) else address end,
    notes = case when p ? 'notes' then p->>'notes' else notes end,
    credit_limit_cents = case when p ? 'credit_limit_cents' then (p->>'credit_limit_cents')::int else credit_limit_cents end,
    discount_pct = case when p ? 'discount_pct' then coalesce((p->>'discount_pct')::numeric, 0) else discount_pct end,
    active = case when p ? 'active' then coalesce((p->>'active')::boolean, true) else active end,
    addresses = case when p ? 'addresses' and jsonb_typeof(p->'addresses') = 'array' then p->'addresses' else addresses end
  where id = v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- ---------- sale.commit (21 + needed_at) -------------------------------------------------------------------------------
create or replace function suqa._pos_sale_commit(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_order suqa.orders; v_l jsonb; v_number text; v_status suqa.order_status; v_channel text; v_rate int;
begin
  v_channel := coalesce(p->>'channel', 'walkin');
  if v_channel not in ('walkin','whatsapp','phone') then raise exception 'bad_channel'; end if;
  v_status := coalesce(p->>'status', case when v_channel = 'walkin' then 'delivered' else 'accepted' end)::suqa.order_status;
  v_rate := coalesce((p->>'rate_lbp_per_usd')::int, (select lbp_per_usd from suqa.exchange_rates where shop_id = d.shop_id order by effective_at desc limit 1),
                     (select fx_lbp_rate::int from suqa.tenants where id = d.tenant_id));

  select * into v_order from suqa.orders where id = (p->>'id')::uuid;
  if not found then
    v_number := suqa.next_order_number(d.tenant_id);
    insert into suqa.orders (
      id, tenant_id, shop_id, customer_id, number, status, channel, device_id, staff_user_id, local_number, shift_id, parked,
      payment_method, address, customer_name, customer_phone, customer_notes, fulfillment, notify_customer,
      subtotal_usd, delivery_fee_usd, total_usd, fx_lbp_rate, commission_rate, commission_usd,
      rate_lbp_per_usd, subtotal_cents, discount_cents, discount_reason, total_cents, total_lbp,
      paid_usd_cents, paid_lbp, change_usd_cents, change_lbp, placed_at, delivered_at, closed_at, needed_at)
    values (
      (p->>'id')::uuid, d.tenant_id, d.shop_id, nullif(p->>'customer_id','')::uuid, v_number, v_status, v_channel, d.id, p_user,
      p->>'local_number', nullif(p->>'shift_id','')::uuid, coalesce((p->>'parked')::boolean, false),
      'cod', coalesce(p->'address', '{}'::jsonb), coalesce(p->>'customer_name', ''), coalesce(p->>'customer_phone', ''), p->>'notes',
      coalesce(p->>'fulfillment', 'pickup'), coalesce((p->>'notify_customer')::boolean, v_channel <> 'walkin'),
      coalesce((p->>'subtotal_cents')::numeric, 0) / 100, coalesce((p->>'delivery_fee_cents')::numeric, 0) / 100, coalesce((p->>'total_cents')::numeric, 0) / 100,
      v_rate, 0, 0,
      v_rate, (p->>'subtotal_cents')::int, coalesce((p->>'discount_cents')::int, 0), p->>'discount_reason', (p->>'total_cents')::int, (p->>'total_lbp')::bigint,
      coalesce((p->>'paid_usd_cents')::int, 0), coalesce((p->>'paid_lbp')::bigint, 0), coalesce((p->>'change_usd_cents')::int, 0), coalesce((p->>'change_lbp')::bigint, 0),
      coalesce((p->>'placed_at')::timestamptz, now()),
      case when v_status = 'delivered' then coalesce((p->>'placed_at')::timestamptz, now()) end,
      case when v_status = 'delivered' then coalesce((p->>'placed_at')::timestamptz, now()) end,
      nullif(p->>'needed_at', '')::timestamptz)
    returning * into v_order;
  end if;

  for v_l in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) loop
    insert into suqa.order_items (id, order_id, tenant_id, shop_id, product_id, name, unit, unit_price_usd, quantity, line_total_usd, notes,
                                  price_currency, unit_price_cents, unit_price_lbp, discount_cents, line_total_cents, cost_cents)
    values ((v_l->>'id')::uuid, v_order.id, d.tenant_id, d.shop_id, nullif(v_l->>'product_id','')::uuid, coalesce(v_l->'name', '{}'::jsonb), v_l->>'unit',
            coalesce((v_l->>'unit_price_cents')::numeric, 0) / 100, (v_l->>'qty')::numeric, coalesce((v_l->>'line_total_cents')::numeric, 0) / 100, v_l->>'notes',
            coalesce(v_l->>'price_currency', 'usd'), (v_l->>'unit_price_cents')::int, (v_l->>'unit_price_lbp')::bigint,
            coalesce((v_l->>'discount_cents')::int, 0), (v_l->>'line_total_cents')::int, (v_l->>'cost_cents')::int)
    on conflict (id) do nothing;
  end loop;

  for v_l in select * from jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) loop
    insert into suqa.payments (id, order_id, shop_id, tenant_id, tender, amount, currency, reference, unpaid_name, unpaid_phone, note, at)
    values ((v_l->>'id')::uuid, v_order.id, d.shop_id, d.tenant_id, v_l->>'tender', (v_l->>'amount')::bigint, v_l->>'currency',
            v_l->>'reference', v_l->>'unpaid_name', v_l->>'unpaid_phone', v_l->>'note', coalesce((v_l->>'at')::timestamptz, now()))
    on conflict (id) do nothing;
  end loop;

  for v_l in select * from jsonb_array_elements(coalesce(p->'stock_moves', '[]'::jsonb)) loop
    insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, ref_order_id, device_id, user_id, at)
    values ((v_l->>'id')::uuid, d.shop_id, d.tenant_id, (v_l->>'product_id')::uuid, (v_l->>'qty')::numeric, coalesce(v_l->>'kind', 'sale'),
            v_order.id, d.id, p_user, coalesce((v_l->>'at')::timestamptz, now()))
    on conflict (id) do nothing;
  end loop;

  return jsonb_build_object('number', v_order.number, 'id', v_order.id);
end $$;

-- ---------- order.needed: move the time of an existing order -----------------------------------------------------------
create or replace function suqa._pos_order_needed(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  update suqa.orders set needed_at = nullif(p->>'needed_at', '')::timestamptz, updated_at = now() where id = (p->>'id')::uuid and shop_id = d.shop_id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- housekeeping: sync_log older than N days is useless (devices that far behind resnapshot anyway) ----------
create or replace function suqa.prune_sync_log(p_days int default 60) returns bigint
language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  delete from suqa.sync_log where at < now() - make_interval(days => p_days); get diagnostics n = row_count; return n;
end $$;

-- backfill the address book from the single address customers already have (safe to re-run)
update suqa.shop_customers c set addresses = suqa._addr_remember(c.addresses, c.address, c.updated_at) where c.addresses = '[]'::jsonb and c.address <> '{}'::jsonb;

-- ---------- dispatcher (33 + order.needed) ------------------------------------------------------------------------------
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

select 'pos m12 installed' as result;
