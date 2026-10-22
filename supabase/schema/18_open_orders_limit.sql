-- 18_open_orders_limit.sql — configurable open-orders limit                        (2026-10-22)
-- tenants.settings.max_open_orders: how many unfinished checkouts (a basket counts as one) a customer may have.
-- null/absent = default 5; 0 = unlimited. Enforced inside place_order / place_basket via suqa._check_open_limit().

create or replace function suqa._check_open_limit(p_customer uuid, p_tenant suqa.tenants) returns void
language plpgsql stable security definer set search_path = public as $$
declare v_max int := coalesce(nullif(p_tenant.settings->>'max_open_orders', '')::int, 5);
begin
  if v_max > 0 and suqa._open_checkouts(p_customer, p_tenant.id) >= v_max then
    raise exception 'too_many_open_orders' using detail = v_max::text;
  end if;
end $$;
revoke all on function suqa._check_open_limit(uuid, suqa.tenants) from public, anon, authenticated;

create or replace function suqa.place_order(p_shop uuid, p_address_id uuid, p_items jsonb, p_notes text default null, p_phone text default null)
returns suqa.orders
language plpgsql security definer set search_path = public as $$
declare v_shop suqa.shops; v_tenant suqa.tenants; v_addr suqa.addresses;
begin
  if auth.uid() is null then raise exception 'not_signed_in' using errcode='insufficient_privilege'; end if;
  select * into v_shop from suqa.shops where id = p_shop and status = 'active';
  if not found then raise exception 'shop_unavailable'; end if;
  select * into v_tenant from suqa.tenants where id = v_shop.tenant_id and status = 'live';
  if not found then raise exception 'tenant_not_live'; end if;
  select * into v_addr from suqa.addresses where id = p_address_id and user_id = auth.uid() and tenant_id = v_tenant.id;
  if not found then raise exception 'address_not_found'; end if;
  perform suqa._check_open_limit(auth.uid(), v_tenant);

  v_addr.phone := suqa._checkout_phone(p_phone, v_addr);
  return suqa._place_shop_order(v_tenant, p_shop, auth.uid(), v_addr, p_items, p_notes,
                                suqa.next_order_number(v_tenant.id), null, null, null);
end $$;

create or replace function suqa.place_basket(p_address_id uuid, p_shops jsonb, p_notes text default null, p_phone text default null)
returns suqa.baskets
language plpgsql security definer set search_path = public as $$
declare
  v_tenant suqa.tenants; v_addr suqa.addresses; v_basket suqa.baskets; v_order suqa.orders;
  v_shop jsonb; v_shop_id uuid; v_number text; v_mode text; v_courier_fee numeric; v_fee_override numeric;
  v_i int := 0; v_sub numeric := 0; v_fees numeric := 0; v_max_zone_fee numeric := 0; v_zone record;
  c_max_shops constant int := 8;
begin
  if auth.uid() is null then raise exception 'not_signed_in' using errcode='insufficient_privilege'; end if;
  if jsonb_typeof(p_shops) <> 'array' or jsonb_array_length(p_shops) = 0 then raise exception 'empty_order'; end if;
  if jsonb_array_length(p_shops) > c_max_shops then raise exception 'too_many_shops' using detail = c_max_shops::text; end if;

  select t.* into v_tenant from suqa.shops s join suqa.tenants t on t.id = s.tenant_id
   where s.id = (p_shops->0->>'shop_id')::uuid and t.status = 'live';
  if not found then raise exception 'tenant_not_live'; end if;
  if not coalesce((v_tenant.settings->>'multi_shop_cart')::boolean, false) and jsonb_array_length(p_shops) > 1 then
    raise exception 'multi_shop_disabled';
  end if;

  select * into v_addr from suqa.addresses where id = p_address_id and user_id = auth.uid() and tenant_id = v_tenant.id;
  if not found then raise exception 'address_not_found'; end if;
  perform suqa._check_open_limit(auth.uid(), v_tenant);
  v_addr.phone := suqa._checkout_phone(p_phone, v_addr);

  v_mode := coalesce(v_tenant.settings->>'delivery_mode', 'per_shop');
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
  insert into suqa.baskets (tenant_id, customer_id, number, delivery_mode, address, customer_name, customer_phone, customer_notes,
                            subtotal_usd, delivery_fee_usd, total_usd, fx_lbp_rate, shop_count)
  values (v_tenant.id, auth.uid(), v_number, v_mode, to_jsonb(v_addr) - 'user_id',
          coalesce((select full_name from suqa.profiles where id = auth.uid()), ''),
          v_addr.phone, p_notes, 0, 0, 0, v_tenant.fx_lbp_rate, jsonb_array_length(p_shops))
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

select 'open orders limit installed' as result;
