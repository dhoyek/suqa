-- 20_fulfillment.sql — pickup vs delivery, optional steps, per-step customer notification     (2026-11-07)
-- • orders.fulfillment ('delivery' | 'pickup'): pickup needs no address, no zone, no fee.
-- • shops.pickup_enabled: the shop offers collection.
-- • orders.notify_customer: merchant can silence the WhatsApp update for the step they are applying.
-- • Merchants may skip steps: accepted → ready / out_for_delivery / delivered, preparing → out_for_delivery / delivered.
-- • tenants.settings.notify_stages (jsonb array of statuses) decides which steps message the customer by default.

alter table suqa.shops   add column if not exists pickup_enabled boolean not null default true;
alter table suqa.orders  add column if not exists fulfillment text not null default 'delivery' check (fulfillment in ('delivery','pickup'));
alter table suqa.orders  add column if not exists notify_customer boolean not null default true;
alter table suqa.baskets add column if not exists fulfillment text not null default 'delivery' check (fulfillment in ('delivery','pickup'));

-- ---------- looser state machine --------------------------------------------------------
create or replace function suqa.order_transition_allowed(f suqa.order_status, t suqa.order_status)
returns boolean language sql immutable as $$
  select (f, t) in (
    ('pending','accepted'), ('pending','rejected'), ('pending','cancelled'),
    ('accepted','preparing'), ('accepted','ready'), ('accepted','out_for_delivery'), ('accepted','delivered'), ('accepted','cancelled'),
    ('preparing','ready'), ('preparing','out_for_delivery'), ('preparing','delivered'), ('preparing','cancelled'),
    ('ready','out_for_delivery'), ('ready','delivered'), ('ready','cancelled'),
    ('out_for_delivery','delivered'), ('out_for_delivery','cancelled'))
$$;

-- ---------- column guard: merchants may also flip notify_customer and fulfillment stays frozen ----
create or replace function suqa.orders_guard_columns() returns trigger
language plpgsql set search_path = public as $$
declare
  v_changed text[];
  v_allowed text[];
  v_auto    text[] := array['updated_at','accepted_at','delivered_at','closed_at','picked_up_at'];
begin
  if not suqa._guards_apply() then return new; end if;

  v_changed := suqa._changed_cols(to_jsonb(old), to_jsonb(new));
  v_changed := array(select unnest(v_changed) except select unnest(v_auto));

  if suqa.is_tenant_member(new.tenant_id) or suqa.is_shop_member(new.shop_id) then
    v_allowed := array['status','reject_reason','shop_notes','eta_minutes','courier_id','notify_customer'];
  elsif suqa.is_courier(new.tenant_id) then
    v_allowed := array['status','courier_id'];
    if new.courier_id is distinct from old.courier_id and not (old.courier_id is null and new.courier_id = auth.uid()) then
      raise exception 'order_locked' using errcode = 'check_violation', detail = 'courier_id';
    end if;
    if new.status is distinct from old.status and not ((old.status, new.status) in (('ready','out_for_delivery'), ('out_for_delivery','delivered'))) then
      raise exception 'order_locked' using errcode = 'check_violation', detail = 'status';
    end if;
  elsif auth.uid() = new.customer_id then
    v_allowed := array['status'];
  else
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;

  if exists (select 1 from unnest(v_changed) c where c <> all (v_allowed)) then
    raise exception 'order_locked' using errcode = 'check_violation',
      detail = array_to_string(array(select unnest(v_changed) except select unnest(v_allowed)), ',');
  end if;
  return new;
end $$;

-- ---------- shared order writer: pickup skips zone + fee ----------------------------------
drop function if exists suqa._place_shop_order(suqa.tenants, uuid, uuid, suqa.addresses, jsonb, text, text, uuid, text, numeric);
create or replace function suqa._place_shop_order(
  p_tenant suqa.tenants, p_shop_id uuid, p_customer uuid, p_addr suqa.addresses, p_items jsonb, p_notes text,
  p_number text, p_basket uuid, p_seq text, p_fee_override numeric, p_fulfillment text default 'delivery')
returns suqa.orders
language plpgsql security definer set search_path = public as $$
declare
  v_shop suqa.shops; v_order suqa.orders; v_zone record; v_item jsonb; v_prod suqa.products;
  v_qty numeric; v_sub numeric := 0; v_rate numeric; v_fee numeric; v_pickup boolean := (p_fulfillment = 'pickup');
  c_max_lines constant int := 50; c_max_qty constant numeric := 999;
begin
  select * into v_shop from suqa.shops where id = p_shop_id and tenant_id = p_tenant.id and status = 'active';
  if not found then raise exception 'shop_unavailable' using detail = p_shop_id::text; end if;
  if v_pickup and not v_shop.pickup_enabled then raise exception 'pickup_unavailable' using detail = p_shop_id::text; end if;

  if not v_pickup then
    if p_addr.id is null then raise exception 'address_required'; end if;
    select * into v_zone from suqa.find_zone(p_tenant.id, v_shop.id, p_addr.location);
    if v_zone.zone_id is null then raise exception 'outside_delivery_area' using detail = p_shop_id::text; end if;
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'empty_order' using detail = p_shop_id::text; end if;
  if jsonb_array_length(p_items) > c_max_lines then raise exception 'too_many_lines' using detail = c_max_lines::text; end if;
  if length(coalesce(p_notes, '')) > 500 then raise exception 'notes_too_long' using detail = '500'; end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from suqa.products
     where id = (v_item->>'product_id')::uuid and shop_id = v_shop.id and is_active and is_available;
    if not found then raise exception 'product_unavailable' using detail = v_item->>'product_id'; end if;
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
    customer_notes, fulfillment, subtotal_usd, delivery_fee_usd, total_usd, fx_lbp_rate, commission_rate, commission_usd, eta_minutes)
  values (
    p_tenant.id, v_shop.id, p_customer, p_number, p_basket, p_seq, case when v_pickup then null else v_zone.zone_id end,
    case when v_pickup then '{}'::jsonb else to_jsonb(p_addr) - 'user_id' end,
    coalesce((select full_name from suqa.profiles where id = p_customer), ''),
    coalesce(p_addr.phone, (select phone from suqa.profiles where id = p_customer), ''),
    p_notes, p_fulfillment, v_sub, v_fee, v_sub + v_fee, p_tenant.fx_lbp_rate,
    v_rate, round(v_sub * v_rate, 2), case when v_pickup then v_shop.prep_minutes else coalesce(v_zone.eta_minutes, 0) + v_shop.prep_minutes end)
  returning * into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from suqa.products where id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    insert into suqa.order_items (order_id, tenant_id, product_id, name, unit, unit_price_usd, quantity, line_total_usd, notes)
    values (v_order.id, p_tenant.id, v_prod.id, v_prod.name, v_prod.unit, v_prod.price_usd, v_qty, round(v_prod.price_usd * v_qty, 2), v_item->>'notes');
  end loop;
  return v_order;
end $$;

-- ---------- place_order / place_basket with p_fulfillment --------------------------------
drop function if exists suqa.place_order(uuid, uuid, jsonb, text, text);
create or replace function suqa.place_order(p_shop uuid, p_address_id uuid, p_items jsonb, p_notes text default null, p_phone text default null, p_fulfillment text default 'delivery')
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
                                suqa.next_order_number(v_tenant.id), null, null, null, p_fulfillment);
end $$;
grant execute on function suqa.place_order(uuid, uuid, jsonb, text, text, text) to authenticated;

drop function if exists suqa.place_basket(uuid, jsonb, text, text);
create or replace function suqa.place_basket(p_address_id uuid, p_shops jsonb, p_notes text default null, p_phone text default null, p_fulfillment text default 'delivery')
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
                                      v_number || '-' || chr(64 + v_i), v_basket.id, chr(64 + v_i), v_fee_override, p_fulfillment);
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
grant execute on function suqa.place_basket(uuid, jsonb, text, text, text) to authenticated;

-- ---------- notification payload: fulfillment + notify flag + pickup info -------------------
create or replace function suqa.order_event_payload(p_order suqa.orders, p_event text, p_old_status suqa.order_status)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'event',      p_event,
    'old_status', p_old_status,
    'phone_number_id', suqa.wa_sender_for_order(p_order.id),
    'order', jsonb_build_object(
      'id', p_order.id, 'number', p_order.number, 'status', p_order.status, 'tenant_id', p_order.tenant_id,
      'basket_id', p_order.basket_id, 'basket_seq', p_order.basket_seq,
      'fulfillment', p_order.fulfillment, 'notify_customer', p_order.notify_customer,
      'customer_name', p_order.customer_name, 'customer_phone', p_order.customer_phone, 'customer_notes', p_order.customer_notes,
      'address', p_order.address, 'subtotal_usd', p_order.subtotal_usd, 'delivery_fee_usd', p_order.delivery_fee_usd,
      'total_usd', p_order.total_usd, 'fx_lbp_rate', p_order.fx_lbp_rate,
      'reject_reason', p_order.reject_reason, 'eta_minutes', p_order.eta_minutes, 'shop_notes', p_order.shop_notes,
      'courier_id', p_order.courier_id, 'placed_at', p_order.placed_at),
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.name, 'unit', i.unit, 'quantity', i.quantity, 'line_total_usd', i.line_total_usd, 'notes', i.notes))
                         from suqa.order_items i where i.order_id = p_order.id), '[]'::jsonb),
    'shop', (select jsonb_build_object('id', s.id, 'slug', s.slug, 'name', s.name, 'whatsapp', s.whatsapp, 'phone', s.phone,
                                       'address', s.address_text, 'location', s.location)
               from suqa.shops s where s.id = p_order.shop_id),
    'tenant', (select jsonb_build_object('id', t.id, 'slug', t.slug, 'brand_name', t.brand_name, 'default_locale', t.default_locale,
                                         'display_currency', t.display_currency,
                                         'courier_enabled', coalesce((t.settings->>'courier_enabled')::boolean, false),
                                         'delivery_mode', coalesce(t.settings->>'delivery_mode', 'per_shop'),
                                         'notify_stages', coalesce(t.settings->'notify_stages', '["accepted","ready","out_for_delivery","delivered","rejected"]'::jsonb))
                 from suqa.tenants t where t.id = p_order.tenant_id),
    'courier_phone', (select p.phone from suqa.profiles p where p.id = p_order.courier_id),
    'couriers', coalesce((select jsonb_agg(p.phone) from suqa.couriers c join suqa.profiles p on p.id = c.user_id
                           where c.tenant_id = p_order.tenant_id and c.is_active and p.phone is not null), '[]'::jsonb)
  )
$$;

-- ---------- favourites --------------------------------------------------------------------
create table if not exists suqa.favorites (
  user_id    uuid not null references auth.users(id) on delete cascade,
  shop_id    uuid not null references suqa.shops(id) on delete cascade,
  tenant_id  uuid not null references suqa.tenants(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, shop_id)
);
alter table suqa.favorites enable row level security;
select suqa._policy('favorites','favorites_own','all','authenticated','user_id = auth.uid()','user_id = auth.uid()');
grant select, insert, delete on suqa.favorites to authenticated;

select 'fulfillment + favorites installed' as result;
