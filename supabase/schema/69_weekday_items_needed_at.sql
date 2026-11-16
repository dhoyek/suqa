-- 69 — Items sold on some weekdays only, orders wanted for a later day, and a shop's "known as" name.
--   products.available_days  smallint[]   null = every day; else the weekdays it is sold (0 = Sunday … 6 = Saturday)
--   shops.known_as           text         what people call the shop (often the owner: "أبو إيلي"); shown under the name, searchable
--   place_order / place_basket (+ _place_shop_order) take p_needed_at: when the customer wants the order.
--     · stored in orders.needed_at (the POS already uses it for phone orders and sorts the board by it)
--     · a weekday-limited item is accepted only when the wanted day (or today, when no time is given) is one of its days
--       → raise 'product_not_that_day' (detail = product id); 'bad_needed_at' when the time is past or > 14 days ahead
--   suqa._pos_product_patch (39) accepts 'available_days' from the POS item editor.
--   The three functions get one more argument, so the old signatures are dropped first. Callers that do not send
--   p_needed_at (the app version before this change) keep working: it defaults to null.
-- Base files 04 (products, shops) list the new columns. Requires 20, 34, 68. Idempotent.

alter table suqa.products add column if not exists available_days smallint[];
alter table suqa.products drop constraint if exists products_available_days_chk;
alter table suqa.products add constraint products_available_days_chk
  check (available_days is null or (cardinality(available_days) between 1 and 7 and available_days <@ array[0,1,2,3,4,5,6]::smallint[]));
alter table suqa.shops add column if not exists known_as text;
alter table suqa.shops drop constraint if exists shops_known_as_len;
alter table suqa.shops add constraint shops_known_as_len check (known_as is null or length(known_as) <= 60);

drop function if exists suqa._place_shop_order(suqa.tenants, uuid, uuid, suqa.addresses, jsonb, text, text, uuid, text, numeric, text);
drop function if exists suqa.place_order(uuid, uuid, jsonb, text, text, text);
drop function if exists suqa.place_basket(uuid, jsonb, text, text, text);

-- ---------- one shop's order (68 + wanted time + weekday items) --------------------------------------------------------
create or replace function suqa._place_shop_order(
  p_tenant suqa.tenants, p_shop_id uuid, p_customer uuid, p_addr suqa.addresses, p_items jsonb, p_notes text,
  p_number text, p_basket uuid, p_seq text, p_fee_override numeric, p_fulfillment text default 'delivery',
  p_needed_at timestamptz default null)
returns suqa.orders
language plpgsql security definer set search_path = public as $$
declare
  v_shop suqa.shops; v_order suqa.orders; v_zone record; v_item jsonb; v_prod suqa.products;
  v_qty numeric; v_sub numeric := 0; v_rate numeric; v_fee numeric; v_pickup boolean := (p_fulfillment = 'pickup');
  c_max_lines constant int := 50; c_max_qty constant numeric := 999;
  v_day int;   -- weekday the order is wanted on, in the tenant's time zone (0 = Sunday … 6 = Saturday)
begin
  select * into v_shop from suqa.shops where id = p_shop_id and tenant_id = p_tenant.id and status = 'active';
  if not found then raise exception 'shop_unavailable' using detail = p_shop_id::text; end if;
  if v_pickup and not v_shop.pickup_enabled then raise exception 'pickup_unavailable' using detail = p_shop_id::text; end if;

  if not v_pickup then
    if p_addr.id is null then raise exception 'address_required'; end if;
    select * into v_zone from suqa.find_zone(p_tenant.id, v_shop.id, p_addr.location);
    if v_zone.zone_id is null then raise exception 'outside_delivery_area' using detail = p_shop_id::text; end if;
  else
    -- pickup has no zone; the record must still be assigned, or reading v_zone.* below fails ("record is not assigned yet")
    select null::uuid as zone_id, null::numeric as fee_usd, null::int as eta_minutes into v_zone;
  end if;

  -- wanted later: not in the past, at most two weeks ahead
  if p_needed_at is not null and (p_needed_at < now() - interval '10 minutes' or p_needed_at > now() + interval '14 days') then
    raise exception 'bad_needed_at';
  end if;
  v_day := extract(dow from (coalesce(p_needed_at, now()) at time zone coalesce(p_tenant.timezone, 'Asia/Beirut')))::int;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'empty_order' using detail = p_shop_id::text; end if;
  if jsonb_array_length(p_items) > c_max_lines then raise exception 'too_many_lines' using detail = c_max_lines::text; end if;
  if length(coalesce(p_notes, '')) > 500 then raise exception 'notes_too_long' using detail = '500'; end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from suqa.products
     where id = (v_item->>'product_id')::uuid and shop_id = v_shop.id and is_active and is_available;
    if not found then raise exception 'product_unavailable' using detail = v_item->>'product_id'; end if;
    -- sold on some weekdays only: the day the order is wanted on decides (so it can be ordered ahead)
    if v_prod.available_days is not null and not (v_day = any(v_prod.available_days)) then
      raise exception 'product_not_that_day' using detail = v_item->>'product_id';
    end if;
    v_qty := (v_item->>'quantity')::numeric;
    if v_qty is null or v_qty <= 0 or v_qty > c_max_qty then raise exception 'bad_quantity' using detail = v_item->>'product_id'; end if;
    if length(coalesce(v_item->>'notes', '')) > 200 then raise exception 'notes_too_long' using detail = '200'; end if;
    v_sub := v_sub + round(v_prod.price_usd * v_qty, 2);
  end loop;

  if v_sub < v_shop.min_order_usd then raise exception 'min_order' using detail = v_shop.min_order_usd::text, hint = p_shop_id::text; end if;

  v_rate := coalesce(v_shop.commission_rate, p_tenant.commission_rate);
  v_fee  := case when v_pickup then 0 else coalesce(p_fee_override, v_zone.fee_usd) end;

  insert into suqa.orders (
    tenant_id, shop_id, customer_id, number, basket_id, basket_seq, zone_id, address, customer_name, customer_phone,
    customer_notes, fulfillment, subtotal_usd, delivery_fee_usd, total_usd, fx_lbp_rate, commission_rate, commission_usd, eta_minutes, needed_at)
  values (
    p_tenant.id, v_shop.id, p_customer, p_number, p_basket, p_seq, case when v_pickup then null else v_zone.zone_id end,
    case when v_pickup then '{}'::jsonb else to_jsonb(p_addr) - 'user_id' end,
    coalesce((select full_name from suqa.profiles where id = p_customer), ''),
    coalesce(p_addr.phone, (select phone from suqa.profiles where id = p_customer), ''),
    p_notes, p_fulfillment, v_sub, v_fee, v_sub + v_fee, p_tenant.fx_lbp_rate,
    v_rate, round(v_sub * v_rate, 2), case when v_pickup then v_shop.prep_minutes else coalesce(v_zone.eta_minutes, 0) + v_shop.prep_minutes end, p_needed_at)
  returning * into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from suqa.products where id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    insert into suqa.order_items (order_id, tenant_id, product_id, name, unit, unit_price_usd, quantity, line_total_usd, notes)
    values (v_order.id, p_tenant.id, v_prod.id, v_prod.name, v_prod.unit, v_prod.price_usd, v_qty, round(v_prod.price_usd * v_qty, 2), v_item->>'notes');
  end loop;
  return v_order;
end $$;

revoke all on function suqa._place_shop_order(suqa.tenants, uuid, uuid, suqa.addresses, jsonb, text, text, uuid, text, numeric, text, timestamptz) from public, anon, authenticated;

-- ---------- single-shop checkout ---------------------------------------------------------------------------------------
create or replace function suqa.place_order(p_shop uuid, p_address_id uuid, p_items jsonb, p_notes text default null, p_phone text default null, p_fulfillment text default 'delivery', p_needed_at timestamptz default null)
returns suqa.orders
language plpgsql security definer set search_path = public as $$
declare v_shop suqa.shops; v_tenant suqa.tenants; v_addr suqa.addresses;
begin
  if auth.uid() is null then raise exception 'not_signed_in' using errcode='insufficient_privilege'; end if;
  if p_fulfillment not in ('delivery','pickup') then raise exception 'bad_fulfillment'; end if;
  select * into v_shop from suqa.shops where id = p_shop and status = 'active';
  if not found then raise exception 'shop_unavailable'; end if;
  select * into v_tenant from suqa.tenants where id = v_shop.tenant_id and status = 'live';
  if not found then raise exception 'tenant_not_live'; end if;
  if p_address_id is not null then
    select * into v_addr from suqa.addresses where id = p_address_id and user_id = auth.uid() and tenant_id = v_tenant.id;
    if not found then raise exception 'address_not_found'; end if;
  elsif p_fulfillment = 'delivery' then
    raise exception 'address_required';
  end if;
  perform suqa._check_open_limit(auth.uid(), v_tenant);

  v_addr.phone := suqa._checkout_phone(p_phone, v_addr);
  return suqa._place_shop_order(v_tenant, p_shop, auth.uid(), v_addr, p_items, p_notes,
                                suqa.next_order_number(v_tenant.id), null, null, null, p_fulfillment, p_needed_at);
end $$;
revoke all on function suqa.place_order(uuid, uuid, jsonb, text, text, text, timestamptz) from public, anon;
grant execute on function suqa.place_order(uuid, uuid, jsonb, text, text, text, timestamptz) to authenticated;

-- ---------- several shops in one checkout ------------------------------------------------------------------------------
create or replace function suqa.place_basket(p_address_id uuid, p_shops jsonb, p_notes text default null, p_phone text default null, p_fulfillment text default 'delivery', p_needed_at timestamptz default null)
returns suqa.baskets
language plpgsql security definer set search_path = public as $$
declare
  v_tenant suqa.tenants; v_addr suqa.addresses; v_basket suqa.baskets; v_order suqa.orders;
  v_shop jsonb; v_shop_id uuid; v_number text; v_mode text; v_courier_fee numeric; v_fee_override numeric;
  v_i int := 0; v_sub numeric := 0; v_fees numeric := 0; v_max_zone_fee numeric := 0; v_zone record;
  v_pickup boolean := (p_fulfillment = 'pickup');
  c_max_shops constant int := 8;
begin
  if auth.uid() is null then raise exception 'not_signed_in' using errcode='insufficient_privilege'; end if;
  if p_fulfillment not in ('delivery','pickup') then raise exception 'bad_fulfillment'; end if;
  if jsonb_typeof(p_shops) <> 'array' or jsonb_array_length(p_shops) = 0 then raise exception 'empty_order'; end if;
  if jsonb_array_length(p_shops) > c_max_shops then raise exception 'too_many_shops' using detail = c_max_shops::text; end if;

  select t.* into v_tenant from suqa.shops s join suqa.tenants t on t.id = s.tenant_id
   where s.id = (p_shops->0->>'shop_id')::uuid and t.status = 'live';
  if not found then raise exception 'tenant_not_live'; end if;
  if not coalesce((v_tenant.settings->>'multi_shop_cart')::boolean, false) and jsonb_array_length(p_shops) > 1 then
    raise exception 'multi_shop_disabled';
  end if;

  if p_address_id is not null then
    select * into v_addr from suqa.addresses where id = p_address_id and user_id = auth.uid() and tenant_id = v_tenant.id;
    if not found then raise exception 'address_not_found'; end if;
  elsif not v_pickup then
    raise exception 'address_required';
  end if;
  perform suqa._check_open_limit(auth.uid(), v_tenant);
  v_addr.phone := suqa._checkout_phone(p_phone, v_addr);

  v_mode := case when v_pickup then 'per_shop' else coalesce(v_tenant.settings->>'delivery_mode', 'per_shop') end;
  if v_mode = 'courier' then
    for v_shop in select * from jsonb_array_elements(p_shops) loop
      select * into v_zone from suqa.find_zone(v_tenant.id, (v_shop->>'shop_id')::uuid, v_addr.location);
      if v_zone.zone_id is null then raise exception 'outside_delivery_area' using detail = v_shop->>'shop_id'; end if;
      v_max_zone_fee := greatest(v_max_zone_fee, coalesce(v_zone.fee_usd, 0));
    end loop;
    v_courier_fee := coalesce((v_tenant.settings->>'courier_fee_usd')::numeric, v_max_zone_fee);
    v_fee_override := 0;
  end if;

  v_number := suqa.next_order_number(v_tenant.id);
  insert into suqa.baskets (tenant_id, customer_id, number, delivery_mode, address, customer_name, customer_phone, customer_notes, fulfillment,
                            subtotal_usd, delivery_fee_usd, total_usd, fx_lbp_rate, shop_count)
  values (v_tenant.id, auth.uid(), v_number, v_mode, case when v_pickup then '{}'::jsonb else to_jsonb(v_addr) - 'user_id' end,
          coalesce((select full_name from suqa.profiles where id = auth.uid()), ''),
          v_addr.phone, p_notes, p_fulfillment, 0, 0, 0, v_tenant.fx_lbp_rate, jsonb_array_length(p_shops))
  returning * into v_basket;

  for v_shop in select * from jsonb_array_elements(p_shops) loop
    v_i := v_i + 1;
    v_shop_id := (v_shop->>'shop_id')::uuid;
    if exists (select 1 from suqa.orders where basket_id = v_basket.id and shop_id = v_shop_id) then
      raise exception 'duplicate_shop' using detail = v_shop_id::text;
    end if;
    v_order := suqa._place_shop_order(v_tenant, v_shop_id, auth.uid(), v_addr, v_shop->'items', v_shop->>'notes',
                                      v_number || '-' || chr(64 + v_i), v_basket.id, chr(64 + v_i), v_fee_override, p_fulfillment, p_needed_at);
    v_sub  := v_sub  + v_order.subtotal_usd;
    v_fees := v_fees + v_order.delivery_fee_usd;
  end loop;

  update suqa.baskets
     set subtotal_usd = v_sub,
         delivery_fee_usd = case when v_mode = 'courier' then v_courier_fee else v_fees end,
         total_usd = v_sub + case when v_mode = 'courier' then v_courier_fee else v_fees end
   where id = v_basket.id
   returning * into v_basket;
  return v_basket;
end $$;
revoke all on function suqa.place_basket(uuid, jsonb, text, text, text, timestamptz) from public, anon;
grant execute on function suqa.place_basket(uuid, jsonb, text, text, text, timestamptz) to authenticated;

-- ---------- POS item editor may set the weekdays (39 + 'available_days' in the allow-list) ------------------------------
create or replace function suqa._pos_product_patch(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_prod suqa.products; v_fields jsonb; v_k text; v_v jsonb; v_base timestamptz; v_conf int := 0; v_allowed text[] :=
  array['name','description','price_usd','price_currency','price_lbp','cost_cents','sku','unit','unit_kind','decimal_qty','vat','track_stock','min_stock','supplier_id','margin_pct','next_expiry',
        'visible_online','is_available','is_active','category_id','section','sort_order','image_url','available_days'];   -- available_days arrives as an array literal: "{0,6}"
begin
  v_fields := p->'fields'; v_base := (p->>'base_updated_at')::timestamptz;
  if (p->>'id') is null then
    -- new product created offline
    insert into suqa.products (id, tenant_id, shop_id, name, price_usd) values ((p->>'new_id')::uuid, d.tenant_id, d.shop_id, '{}'::jsonb, 0) on conflict (id) do nothing;
    select * into v_prod from suqa.products where id = (p->>'new_id')::uuid;
  else
    select * into v_prod from suqa.products where id = (p->>'id')::uuid and shop_id = d.shop_id;
    if not found then raise exception 'product_not_found'; end if;
  end if;

  for v_k, v_v in select * from jsonb_each(v_fields) loop
    if v_k <> all (v_allowed) then raise exception 'field_not_allowed' using detail = v_k; end if;
    if v_base is not null and v_prod.updated_at > v_base and to_jsonb(v_prod)->v_k is distinct from v_v then
      insert into suqa.conflict_log (shop_id, tenant_id, tbl, row_id, field, old_value, new_value, by_device, by_user)
      values (d.shop_id, d.tenant_id, 'products', v_prod.id::text, v_k, to_jsonb(v_prod)->v_k, v_v, d.id, p_user);
      v_conf := v_conf + 1;
    end if;
    execute format('update suqa.products set %I = ($1->>%L)::%s where id = $2', v_k, v_k,
                   (select format_type(a.atttypid, a.atttypmod) from pg_attribute a where a.attrelid = 'suqa.products'::regclass and a.attname = v_k))
      using v_fields, v_prod.id;
  end loop;

  -- barcodes_add: "123" or { barcode, pack_qty, pack_price_usd, pack_price_lbp }  (31_pos_m11)
  for v_v in select * from jsonb_array_elements(coalesce(p->'barcodes_add', '[]'::jsonb)) loop
    if jsonb_typeof(v_v) = 'object' then
      insert into suqa.product_barcodes (product_id, shop_id, tenant_id, barcode, pack_qty, pack_price_usd, pack_price_lbp)
      values (v_prod.id, d.shop_id, d.tenant_id, v_v->>'barcode', coalesce((v_v->>'pack_qty')::numeric, 1), (v_v->>'pack_price_usd')::numeric, (v_v->>'pack_price_lbp')::bigint)
      on conflict (product_id, barcode) do update set pack_qty = excluded.pack_qty, pack_price_usd = excluded.pack_price_usd, pack_price_lbp = excluded.pack_price_lbp;
    else
      insert into suqa.product_barcodes (product_id, shop_id, tenant_id, barcode) values (v_prod.id, d.shop_id, d.tenant_id, v_v#>>'{}') on conflict do nothing;
    end if;
  end loop;
  for v_v in select * from jsonb_array_elements(coalesce(p->'barcodes_remove', '[]'::jsonb)) loop
    delete from suqa.product_barcodes where product_id = v_prod.id and barcode = v_v#>>'{}';
  end loop;
  return jsonb_build_object('conflicts', v_conf);
end $$;

revoke all on function suqa._pos_product_patch(suqa.devices, jsonb, uuid) from public, anon, authenticated;

select 'weekday items + wanted time + known-as installed' as result;
