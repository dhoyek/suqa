-- 16_quick_checkout.sql — WhatsApp-style quick checkout                         (2026-10-21)
-- Phone is a checkout field (not an address field); the address text is optional — the pin is what matters.
-- place_order / place_basket accept p_phone: it becomes the order's contact number and is saved to the profile.

alter table suqa.addresses alter column line1 drop not null;

-- Resolve the contact phone for an order and remember it on the profile.
create or replace function suqa._checkout_phone(p_phone text, p_addr suqa.addresses) returns text
language plpgsql security definer set search_path = public as $$
declare v text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '');
begin
  if v is not null then
    if length(v) < 8 or length(v) > 16 then raise exception 'bad_phone'; end if;
    update suqa.profiles set phone = v where id = auth.uid() and phone is distinct from v;
    return v;
  end if;
  v := coalesce(p_addr.phone, (select phone from suqa.profiles where id = auth.uid()));
  if v is null then raise exception 'phone_required'; end if;
  return v;
end $$;
revoke all on function suqa._checkout_phone(text, suqa.addresses) from public, anon, authenticated;

drop function if exists suqa.place_order(uuid, uuid, jsonb, text);
create or replace function suqa.place_order(p_shop uuid, p_address_id uuid, p_items jsonb, p_notes text default null, p_phone text default null)
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

  v_addr.phone := suqa._checkout_phone(p_phone, v_addr);     -- local copy: the order snapshot carries the checkout phone
  return suqa._place_shop_order(v_tenant, p_shop, auth.uid(), v_addr, p_items, p_notes,
                                suqa.next_order_number(v_tenant.id), null, null, null);
end $$;
grant execute on function suqa.place_order(uuid, uuid, jsonb, text, text) to authenticated;

drop function if exists suqa.place_basket(uuid, jsonb, text);
create or replace function suqa.place_basket(p_address_id uuid, p_shops jsonb, p_notes text default null, p_phone text default null)
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

  select t.* into v_tenant from suqa.shops s join suqa.tenants t on t.id = s.tenant_id
   where s.id = (p_shops->0->>'shop_id')::uuid and t.status = 'live';
  if not found then raise exception 'tenant_not_live'; end if;
  if not coalesce((v_tenant.settings->>'multi_shop_cart')::boolean, false) and jsonb_array_length(p_shops) > 1 then
    raise exception 'multi_shop_disabled';
  end if;

  select * into v_addr from suqa.addresses where id = p_address_id and user_id = auth.uid() and tenant_id = v_tenant.id;
  if not found then raise exception 'address_not_found'; end if;
  if suqa._open_checkouts(auth.uid(), v_tenant.id) >= c_max_open then raise exception 'too_many_open_orders' using detail = c_max_open::text; end if;
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
grant execute on function suqa.place_basket(uuid, jsonb, text, text) to authenticated;

select 'quick checkout installed' as result;
