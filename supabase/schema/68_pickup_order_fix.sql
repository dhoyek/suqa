-- 68 — Fix: online PICKUP orders from the storefront failed with "record v_zone is not assigned yet" (since 20).
--   suqa._place_shop_order read v_zone.fee_usd / zone_id / eta_minutes for pickup orders too, where no zone was looked up.
--   The record is now assigned empty for pickup. Nothing else in the function changes. Base file 20 carries the same fix.
-- No table changes. Requires 20. Idempotent.

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
  else
    -- pickup has no zone; the record must still be assigned, or reading v_zone.* below fails ("record is not assigned yet")
    select null::uuid as zone_id, null::numeric as fee_usd, null::int as eta_minutes into v_zone;
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

select 'pickup order fix installed' as result;
