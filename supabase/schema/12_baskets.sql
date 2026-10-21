-- 12_baskets.sql — multi-shop baskets                                   (2026-10-17)
-- A basket is ONE checkout by a customer that spans several shops. It is split into one
-- suqa.orders row per shop (the shop never sees the other parts). Each part keeps its own
-- status/state machine; the basket's status is derived from its parts.
--
-- Tenant settings (suqa.tenants.settings JSONB):
--   multi_shop_cart   boolean   customers may add items from several shops to one cart (default false)
--   delivery_mode     'per_shop' | 'courier'   per_shop: each shop delivers its part, one fee per shop
--                                              courier: the association delivers everything once, one fee
--   courier_fee_usd   numeric   the single fee in courier mode (falls back to the highest zone fee among the parts)

create table if not exists suqa.baskets (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references suqa.tenants(id) on delete restrict,
  customer_id       uuid not null references auth.users(id) on delete restrict,
  number            text not null,                               -- 'BAT-000123'; parts are 'BAT-000123-A', '-B', …
  delivery_mode     text not null check (delivery_mode in ('per_shop','courier')),
  address           jsonb not null,                              -- snapshot of suqa.addresses row
  customer_name     text not null,
  customer_phone    text not null,
  customer_notes    text,
  subtotal_usd      numeric(12,2) not null check (subtotal_usd >= 0),
  delivery_fee_usd  numeric(12,2) not null default 0,            -- courier mode: the single fee; per_shop: sum of the parts' fees
  total_usd         numeric(12,2) not null,
  fx_lbp_rate       numeric(14,2) not null,
  shop_count        int not null check (shop_count >= 1),
  placed_at         timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  unique (tenant_id, number)
);
create index if not exists baskets_customer_idx on suqa.baskets(customer_id, placed_at desc);
create index if not exists baskets_tenant_idx   on suqa.baskets(tenant_id, placed_at desc);

-- orders ↔ baskets (columns are declared in 06_orders.sql; this adds them to an existing database)
alter table suqa.orders add column if not exists basket_id  uuid;
alter table suqa.orders add column if not exists basket_seq text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'orders_basket_id_fkey') then
    alter table suqa.orders add constraint orders_basket_id_fkey foreign key (basket_id) references suqa.baskets(id) on delete restrict;
  end if;
end $$;
create index if not exists orders_basket_idx on suqa.orders(basket_id);

-- ---------- RLS --------------------------------------------------------------
alter table suqa.baskets enable row level security;
select suqa._policy('baskets','baskets_read','select','authenticated',
  'customer_id = auth.uid() or suqa.is_tenant_member(tenant_id)
   or exists (select 1 from suqa.orders o where o.basket_id = baskets.id and suqa.is_shop_member(o.shop_id))');
-- no insert/update/delete policies: baskets are created only by suqa.place_basket()
revoke insert, update, delete on suqa.baskets from anon, authenticated;

-- ---------- internal: create one shop's part ---------------------------------
-- Shared by place_order (single shop) and place_basket (several shops). Not callable by clients.
create or replace function suqa._place_shop_order(
  p_tenant suqa.tenants, p_shop_id uuid, p_customer uuid, p_addr suqa.addresses, p_items jsonb, p_notes text,
  p_number text, p_basket uuid, p_seq text, p_fee_override numeric)   -- p_fee_override: courier mode → 0
returns suqa.orders
language plpgsql security definer set search_path = public as $$
declare
  v_shop suqa.shops; v_order suqa.orders; v_zone record; v_item jsonb; v_prod suqa.products;
  v_qty numeric; v_sub numeric := 0; v_rate numeric; v_fee numeric;
  c_max_lines constant int := 50; c_max_qty constant numeric := 999;
begin
  select * into v_shop from suqa.shops where id = p_shop_id and tenant_id = p_tenant.id and status = 'active';
  if not found then raise exception 'shop_unavailable' using detail = p_shop_id::text; end if;

  select * into v_zone from suqa.find_zone(p_tenant.id, v_shop.id, p_addr.location);
  if v_zone.zone_id is null then raise exception 'outside_delivery_area' using detail = p_shop_id::text; end if;

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
  v_fee  := coalesce(p_fee_override, v_zone.fee_usd);

  insert into suqa.orders (
    tenant_id, shop_id, customer_id, number, basket_id, basket_seq, zone_id, address, customer_name, customer_phone,
    customer_notes, subtotal_usd, delivery_fee_usd, total_usd, fx_lbp_rate, commission_rate, commission_usd, eta_minutes)
  values (
    p_tenant.id, v_shop.id, p_customer, p_number, p_basket, p_seq, v_zone.zone_id,
    to_jsonb(p_addr) - 'user_id',
    coalesce((select full_name from suqa.profiles where id = p_customer), ''),
    coalesce(p_addr.phone, (select phone from suqa.profiles where id = p_customer), ''),
    p_notes, v_sub, v_fee, v_sub + v_fee, p_tenant.fx_lbp_rate,
    v_rate, round(v_sub * v_rate, 2), coalesce(v_zone.eta_minutes, 0) + v_shop.prep_minutes)
  returning * into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from suqa.products where id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    insert into suqa.order_items (order_id, tenant_id, product_id, name, unit, unit_price_usd, quantity, line_total_usd, notes)
    values (v_order.id, p_tenant.id, v_prod.id, v_prod.name, v_prod.unit, v_prod.price_usd, v_qty, round(v_prod.price_usd * v_qty, 2), v_item->>'notes');
  end loop;
  return v_order;
end $$;
revoke all on function suqa._place_shop_order(suqa.tenants, uuid, uuid, suqa.addresses, jsonb, text, text, uuid, text, numeric) from public, anon, authenticated;

-- ---------- open-orders limit, counting a basket as one ------------------------
create or replace function suqa._open_checkouts(p_customer uuid, p_tenant uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(distinct coalesce(basket_id, id))::int from suqa.orders
   where customer_id = p_customer and tenant_id = p_tenant and closed_at is null
$$;

-- ---------- place_order: single shop -------------------------
-- NB: superseded by 16_quick_checkout.sql (adds p_phone); kept for readability.
create or replace function suqa.place_order(p_shop uuid, p_address_id uuid, p_items jsonb, p_notes text default null)
returns suqa.orders
language plpgsql security definer set search_path = public as $$
declare v_shop suqa.shops; v_tenant suqa.tenants; v_addr suqa.addresses; c_max_open constant int := 5;
begin
  if auth.uid() is null then raise exception 'not_signed_in' using errcode='insufficient_privilege'; end if;
  select * into v_shop from suqa.shops where id = p_shop and status = 'active';
  if not found then raise exception 'shop_unavailable'; end if;
  select * into v_tenant from suqa.tenants where id = v_shop.tenant_id and status = 'live';
  if not found then raise exception 'tenant_not_live'; end if;
  select * into v_addr from suqa.addresses where id = p_address_id and user_id = auth.uid() and tenant_id = v_tenant.id;
  if not found then raise exception 'address_not_found'; end if;
  if suqa._open_checkouts(auth.uid(), v_tenant.id) >= c_max_open then raise exception 'too_many_open_orders' using detail = c_max_open::text; end if;

  return suqa._place_shop_order(v_tenant, p_shop, auth.uid(), v_addr, p_items, p_notes,
                                suqa.next_order_number(v_tenant.id), null, null, null);
end $$;
grant execute on function suqa.place_order(uuid, uuid, jsonb, text) to authenticated;

-- ---------- place_basket: several shops in one checkout ---------------------------
-- NB: superseded by 16_quick_checkout.sql (adds p_phone); kept for readability.
-- p_shops: [{ "shop_id": "...", "items": [{ "product_id": "...", "quantity": 2 }], "notes": "..." }, ...]
-- Returns the basket row; the parts are in suqa.orders where basket_id = basket.id.
create or replace function suqa.place_basket(p_address_id uuid, p_shops jsonb, p_notes text default null)
returns suqa.baskets
language plpgsql security definer set search_path = public as $$
declare
  v_tenant suqa.tenants; v_addr suqa.addresses; v_basket suqa.baskets; v_order suqa.orders;
  v_shop jsonb; v_shop_id uuid; v_number text; v_mode text; v_courier_fee numeric; v_fee_override numeric;
  v_i int := 0; v_sub numeric := 0; v_fees numeric := 0; v_max_zone_fee numeric := 0; v_zone record;
  c_max_open constant int := 5; c_max_shops constant int := 8;
begin
  if auth.uid() is null then raise exception 'not_signed_in' using errcode='insufficient_privilege'; end if;
  if jsonb_typeof(p_shops) <> 'array' or jsonb_array_length(p_shops) = 0 then raise exception 'empty_order'; end if;
  if jsonb_array_length(p_shops) > c_max_shops then raise exception 'too_many_shops' using detail = c_max_shops::text; end if;

  -- tenant comes from the first shop; every shop must belong to it
  select t.* into v_tenant from suqa.shops s join suqa.tenants t on t.id = s.tenant_id
   where s.id = (p_shops->0->>'shop_id')::uuid and t.status = 'live';
  if not found then raise exception 'tenant_not_live'; end if;
  if not coalesce((v_tenant.settings->>'multi_shop_cart')::boolean, false) and jsonb_array_length(p_shops) > 1 then
    raise exception 'multi_shop_disabled';
  end if;

  select * into v_addr from suqa.addresses where id = p_address_id and user_id = auth.uid() and tenant_id = v_tenant.id;
  if not found then raise exception 'address_not_found'; end if;
  if suqa._open_checkouts(auth.uid(), v_tenant.id) >= c_max_open then raise exception 'too_many_open_orders' using detail = c_max_open::text; end if;

  v_mode := coalesce(v_tenant.settings->>'delivery_mode', 'per_shop');
  if v_mode = 'courier' then
    -- one fee for the whole basket: the configured courier fee, else the highest zone fee among the parts
    for v_shop in select * from jsonb_array_elements(p_shops) loop
      select * into v_zone from suqa.find_zone(v_tenant.id, (v_shop->>'shop_id')::uuid, v_addr.location);
      if v_zone.zone_id is null then raise exception 'outside_delivery_area' using detail = v_shop->>'shop_id'; end if;
      v_max_zone_fee := greatest(v_max_zone_fee, coalesce(v_zone.fee_usd, 0));
    end loop;
    v_courier_fee := coalesce((v_tenant.settings->>'courier_fee_usd')::numeric, v_max_zone_fee);
    v_fee_override := 0;
  end if;

  v_number := suqa.next_order_number(v_tenant.id);
  insert into suqa.baskets (tenant_id, customer_id, number, delivery_mode, address, customer_name, customer_phone, customer_notes,
                            subtotal_usd, delivery_fee_usd, total_usd, fx_lbp_rate, shop_count)
  values (v_tenant.id, auth.uid(), v_number, v_mode, to_jsonb(v_addr) - 'user_id',
          coalesce((select full_name from suqa.profiles where id = auth.uid()), ''),
          coalesce(v_addr.phone, (select phone from suqa.profiles where id = auth.uid()), ''),
          p_notes, 0, 0, 0, v_tenant.fx_lbp_rate, jsonb_array_length(p_shops))
  returning * into v_basket;

  for v_shop in select * from jsonb_array_elements(p_shops) loop
    v_i := v_i + 1;
    v_shop_id := (v_shop->>'shop_id')::uuid;
    if exists (select 1 from suqa.orders where basket_id = v_basket.id and shop_id = v_shop_id) then
      raise exception 'duplicate_shop' using detail = v_shop_id::text;
    end if;
    v_order := suqa._place_shop_order(v_tenant, v_shop_id, auth.uid(), v_addr, v_shop->'items', v_shop->>'notes',
                                      v_number || '-' || chr(64 + v_i), v_basket.id, chr(64 + v_i), v_fee_override);
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
grant execute on function suqa.place_basket(uuid, jsonb, text) to authenticated;

select 'baskets installed' as result;
