-- 103 — a shop's own exchange rate on the customer side (Dan, 24 Nov 2026).
--   Until now the storefront, the cart, the checkout and the online order used the ASSOCIATION's rate (tenants.fx_lbp_rate),
--   while each shop sets its own rate in its POS (suqa.exchange_rates, newest row = today's rate). A shop at 89,000 showed
--   its customers lira worked out at 90,000 — and its lira-priced items were charged at 90,000 too.
--   Now an online order of a shop is priced and stored at THAT SHOP's rate:
--     * suqa.shop_rate(shop)     the shop's current rate; the association's when the shop has none.
--     * suqa.shop_rates(tenant)  { shop id: rate } for the association's shops that have their own rate — what the site reads
--                                (one call) to show lira on the shop page, the cart, the checkout, Yorgo's baskets.
--       Only the CURRENT rate of a shop is given, to anyone: it is on the shop's page for every visitor anyway. The history
--       (suqa.exchange_rates) stays readable by the shop's staff only.
--     * suqa._place_shop_order   uses shop_rate(shop) where it used the association's rate: a lira-priced line is
--       round(quantity × price_lbp ÷ shop rate, 2) dollars, and the order keeps that rate (orders.fx_lbp_rate), so its lira
--       total, the till, the receipt and the WhatsApp messages all show the shop's lira.
--     * suqa.place_basket        a one-shop basket keeps that shop's rate; a basket of several shops keeps the association's
--       (each of its orders carries its own shop's rate, and the site adds their lira up).
--   A cart with two shops at different rates: each shop's part is converted at its own rate; the lira total is the sum.
--   Orders already placed are not touched: each keeps the rate it was placed at.
-- No table is changed. Requires 82 (_line_usd / _unit_usd) and 21 (exchange_rates). Idempotent.

create or replace function suqa.shop_rate(p_shop uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select r.lbp_per_usd::numeric from suqa.exchange_rates r where r.shop_id = p_shop and r.effective_at <= now() order by r.effective_at desc limit 1),
    (select t.fx_lbp_rate from suqa.shops s join suqa.tenants t on t.id = s.tenant_id where s.id = p_shop))
$$;

create or replace function suqa.shop_rates(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(x.shop_id, x.rate), '{}'::jsonb)
    from (select distinct on (r.shop_id) r.shop_id, r.lbp_per_usd as rate
            from suqa.exchange_rates r join suqa.shops s on s.id = r.shop_id
           where s.tenant_id = p_tenant and r.effective_at <= now()
           order by r.shop_id, r.effective_at desc) x
$$;

create or replace function suqa._place_shop_order(p_tenant suqa.tenants, p_shop_id uuid, p_customer uuid, p_addr suqa.addresses, p_items jsonb, p_notes text, p_number text, p_basket uuid, p_seq text, p_fee_override numeric, p_fulfillment text default 'delivery', p_needed_at timestamptz default null)
returns suqa.orders
language plpgsql security definer set search_path = public as $$
declare
  v_shop suqa.shops; v_order suqa.orders; v_zone record; v_item jsonb; v_prod suqa.products;
  v_qty numeric; v_sub numeric := 0; v_rate numeric; v_fee numeric; v_pickup boolean := (p_fulfillment = 'pickup');
  v_fx numeric;   -- 103: the SHOP's lira rate (the association's when the shop has none)
  c_max_lines constant int := 50; c_max_qty constant numeric := 999;
  v_day int;   -- weekday the order is wanted on, in the tenant's time zone (0 = Sunday … 6 = Saturday)
begin
  select * into v_shop from suqa.shops where id = p_shop_id and tenant_id = p_tenant.id and status = 'active';
  if not found then raise exception 'shop_unavailable' using detail = p_shop_id::text; end if;
  if v_pickup and not v_shop.pickup_enabled then raise exception 'pickup_unavailable' using detail = p_shop_id::text; end if;
  v_fx := coalesce(nullif(suqa.shop_rate(v_shop.id), 0), p_tenant.fx_lbp_rate);

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
    v_sub := v_sub + suqa._line_usd(v_prod, v_qty, v_fx);   -- 82: a lira-priced item at its own lira price; 103: at the shop's rate
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
    p_notes, p_fulfillment, v_sub, v_fee, v_sub + v_fee, v_fx,
    v_rate, round(v_sub * v_rate, 2), case when v_pickup then v_shop.prep_minutes else coalesce(v_zone.eta_minutes, 0) + v_shop.prep_minutes end, p_needed_at)
  returning * into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from suqa.products where id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    insert into suqa.order_items (order_id, tenant_id, product_id, name, unit, unit_price_usd, quantity, line_total_usd, notes)
    values (v_order.id, p_tenant.id, v_prod.id, v_prod.name, v_prod.unit, suqa._unit_usd(v_prod, v_fx), v_qty, suqa._line_usd(v_prod, v_qty, v_fx), v_item->>'notes');
  end loop;
  return v_order;
end $$;

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
         total_usd = v_sub + case when v_mode = 'courier' then v_courier_fee else v_fees end,
         fx_lbp_rate = case when v_i = 1 then v_order.fx_lbp_rate else fx_lbp_rate end      -- 103: a one-shop basket keeps that shop's rate
   where id = v_basket.id
   returning * into v_basket;
  return v_basket;
end $$;

revoke all on function suqa.shop_rate(uuid) from public;
revoke all on function suqa.shop_rates(uuid) from public;
grant execute on function suqa.shop_rate(uuid) to anon, authenticated, service_role;
grant execute on function suqa.shop_rates(uuid) to anon, authenticated, service_role;

select 'shop rate online installed' as result;
