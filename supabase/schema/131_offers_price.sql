-- 131 — offers, step 2: a PRICE OFFER on one item (kind 'discount').
--
-- "Labneh $3.50 → $2.90 until Sunday": one item, one lower price in the item's own currency, optional dates. It lives in the
-- tables of 130 (kind = 'discount', exactly one row in offer_items, quantity 1).
--
--   · suqa._sale_offer(product)  the price offer running on an item right now (the cheapest when there are several): active,
--     inside its dates, same shop, same currency as the item, and really below the item's price. Null row when none.
--   · offer_save   = 130 + the kind: a price offer takes exactly one item, needs no "two units", may carry the item's own name,
--     has no "per order" limit. The kind is set when the offer is made and never changes.
--   · _place_shop_order = 130 + an ordinary line of an item with a running price offer is charged the offer price, and the
--     line says so ("🏷 name"). Nothing is sent by the customer for it: the server decides, so a finished offer cannot be used.
--     Items inside a bundle keep their bundle price.
--
-- The till applies the same price from its own copy of the offers (pos-core `saleView`). Requires 130. No table change. Idempotent.

create or replace function suqa._sale_offer(p_product uuid) returns suqa.offers
language sql stable security definer set search_path = public as $$
  select o.* from suqa.offers o
    join suqa.offer_items oi on oi.offer_id = o.id
    join suqa.products p on p.id = oi.product_id
   where oi.product_id = p_product and o.kind = 'discount' and o.is_active and o.shop_id = p.shop_id
     and (o.starts_at is null or o.starts_at <= now()) and (o.ends_at is null or o.ends_at > now())
     and o.price_currency = p.price_currency
     and case when o.price_currency = 'lbp' then o.price_lbp > 0 and o.price_lbp < p.price_lbp else o.price_usd > 0 and o.price_usd < p.price_usd end
   order by case when o.price_currency = 'lbp' then o.price_lbp::numeric else o.price_usd end, o.created_at
   limit 1
$$;
revoke all on function suqa._sale_offer(uuid) from public, anon, authenticated;

-- p = { id?, kind 'bundle' | 'discount' (new offers; default 'bundle'), name {ar,en}, description {ar,en}?, image_url?,
--       price_currency 'usd'|'lbp', price (dollars, or lira), is_active?, is_hot?, starts_at?, ends_at?, max_per_order?, sort_order?,
--       items [{ product_id, quantity }] }
create or replace function suqa.offer_save(p_shop uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_shop suqa.shops; v_id uuid := nullif(p->>'id', '')::uuid; v_cur text := coalesce(p->>'price_currency', 'usd'); v_price numeric := (p->>'price')::numeric;
        v_name jsonb := jsonb_strip_nulls(jsonb_build_object('ar', nullif(btrim(p->'name'->>'ar'), ''), 'en', nullif(btrim(p->'name'->>'en'), '')));
        v_it jsonb; v_prod suqa.products; v_q numeric; v_normal numeric := 0; v_units numeric := 0; v_n int := 0; v_fx numeric;
        v_kind text;   -- 131: 'bundle' or 'discount' (a price offer on one item)
begin
  if not suqa.is_shop_owner(p_shop) then raise exception 'not_owner' using errcode = 'insufficient_privilege'; end if;
  select * into v_shop from suqa.shops where id = p_shop;
  -- 131: the kind is chosen when the offer is made and never changes afterwards
  v_kind := coalesce((select kind from suqa.offers where id = v_id and shop_id = p_shop), nullif(p->>'kind', ''), 'bundle');
  if v_kind not in ('bundle', 'discount') then raise exception 'offer_bad_kind'; end if;
  if v_kind = 'discount' and jsonb_typeof(p->'items') = 'array' and jsonb_array_length(p->'items') <> 1 then raise exception 'offer_one_item'; end if;
  if v_name = '{}'::jsonb and v_kind = 'discount' and jsonb_typeof(p->'items') = 'array' then      -- a price offer may simply carry its item's name
    select jsonb_strip_nulls(jsonb_build_object('ar', nullif(name->>'ar', ''), 'en', nullif(name->>'en', ''))) into v_name from suqa.products where id = (p->'items'->0->>'product_id')::uuid and shop_id = p_shop;
    v_name := coalesce(v_name, '{}'::jsonb);
  end if;
  if v_name = '{}'::jsonb then raise exception 'offer_name_required'; end if;
  if length(coalesce(v_name->>'ar', '')) > 80 or length(coalesce(v_name->>'en', '')) > 80 then raise exception 'offer_name_too_long'; end if;
  if v_cur not in ('usd', 'lbp') then raise exception 'offer_bad_currency'; end if;
  if v_price is null or v_price <= 0 then raise exception 'offer_price_required'; end if;
  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 then raise exception 'offer_items_required'; end if;
  if jsonb_array_length(p->'items') > 20 then raise exception 'offer_too_many_items'; end if;
  if v_id is not null and not exists (select 1 from suqa.offers where id = v_id and shop_id = p_shop) then raise exception 'offer_not_found'; end if;

  for v_it in select * from jsonb_array_elements(p->'items') loop
    select * into v_prod from suqa.products where id = (v_it->>'product_id')::uuid and shop_id = p_shop and is_active;
    if not found then raise exception 'offer_item_unknown' using detail = v_it->>'product_id'; end if;
    if v_prod.price_currency <> v_cur then raise exception 'offer_mixed_currency' using detail = v_prod.id::text; end if;
    v_q := case when v_kind = 'discount' then 1 else (v_it->>'quantity')::numeric end;
    if v_q is null or v_q < 1 or v_q > 99 or v_q <> trunc(v_q) then raise exception 'offer_bad_quantity' using detail = v_prod.id::text; end if;
    v_normal := v_normal + v_q * case when v_cur = 'lbp' then v_prod.price_lbp else v_prod.price_usd end;
    v_units := v_units + v_q; v_n := v_n + 1;
  end loop;
  if v_kind = 'bundle' and v_units < 2 then raise exception 'offer_needs_two'; end if;    -- one unit of one item is not a bundle (it is a price offer)
  if v_price >= v_normal then raise exception 'offer_no_saving' using detail = v_normal::text; end if;

  if v_id is null then
    insert into suqa.offers (tenant_id, shop_id, kind, name, description, image_url, price_currency, price_usd, price_lbp, is_active, is_hot, starts_at, ends_at, max_per_order, sort_order, created_by)
    values (v_shop.tenant_id, p_shop, v_kind, v_name, coalesce(p->'description', '{}'::jsonb), nullif(p->>'image_url', ''), v_cur,
            case when v_cur = 'usd' then round(v_price, 2) else 0 end, case when v_cur = 'lbp' then round(v_price)::bigint else 0 end,
            coalesce((p->>'is_active')::boolean, true), coalesce((p->>'is_hot')::boolean, false), nullif(p->>'starts_at', '')::timestamptz, nullif(p->>'ends_at', '')::timestamptz,
            case when v_kind = 'discount' then null else nullif(p->>'max_per_order', '')::int end, coalesce((p->>'sort_order')::int, (select coalesce(max(sort_order), 0) + 1 from suqa.offers where shop_id = p_shop)), auth.uid())
    returning id into v_id;
  else
    update suqa.offers set name = v_name, description = coalesce(p->'description', description), image_url = nullif(p->>'image_url', ''), price_currency = v_cur,
           price_usd = case when v_cur = 'usd' then round(v_price, 2) else 0 end, price_lbp = case when v_cur = 'lbp' then round(v_price)::bigint else 0 end,
           is_active = coalesce((p->>'is_active')::boolean, is_active), is_hot = coalesce((p->>'is_hot')::boolean, is_hot),
           starts_at = nullif(p->>'starts_at', '')::timestamptz, ends_at = nullif(p->>'ends_at', '')::timestamptz,
           max_per_order = case when v_kind = 'discount' then null else nullif(p->>'max_per_order', '')::int end, sort_order = coalesce((p->>'sort_order')::int, sort_order)
     where id = v_id;
    delete from suqa.offer_items where offer_id = v_id;
  end if;
  insert into suqa.offer_items (offer_id, product_id, tenant_id, shop_id, quantity, sort_order)
  select v_id, (x.it->>'product_id')::uuid, v_shop.tenant_id, p_shop, case when v_kind = 'discount' then 1 else sum((x.it->>'quantity')::numeric) end, min(x.ord)::int
    from jsonb_array_elements(p->'items') with ordinality as x(it, ord) group by 2;
  if exists (select 1 from suqa.offer_items where offer_id = v_id and quantity > 99) then raise exception 'offer_bad_quantity'; end if;
  return v_id;
end $$;
revoke all on function suqa.offer_save(uuid, jsonb) from public, anon;
grant execute on function suqa.offer_save(uuid, jsonb) to authenticated;

-- ── an online order: bundles (130) and price offers (131) ────────────────────────────────────────────────────────────
create or replace function suqa._place_shop_order(p_tenant suqa.tenants, p_shop_id uuid, p_customer uuid, p_addr suqa.addresses, p_items jsonb, p_notes text, p_number text, p_basket uuid, p_seq text, p_fee_override numeric, p_fulfillment text default 'delivery', p_needed_at timestamptz default null)
returns suqa.orders
language plpgsql security definer set search_path = public as $$
declare
  v_shop suqa.shops; v_order suqa.orders; v_zone record; v_item jsonb; v_prod suqa.products;
  v_qty numeric; v_sub numeric := 0; v_rate numeric; v_fee numeric; v_pickup boolean := (p_fulfillment = 'pickup');
  v_fx numeric;   -- 103: the SHOP's lira rate (the association's when the shop has none)
  c_max_lines constant int := 50; c_max_qty constant numeric := 999;
  v_day int;   -- weekday the order is wanted on, in the tenant's time zone (0 = Sunday … 6 = Saturday)
  v_lines jsonb;   -- 130: the order's lines, with each bundle replaced by its items at their price inside the bundle
  v_line numeric;
  v_sale suqa.offers;   -- 131: the price offer on this item, if one is running
  v_unit numeric;
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

  v_lines := suqa._order_expand_offers(v_shop.id, p_items, v_fx);   -- 130

  for v_item in select * from jsonb_array_elements(v_lines) loop
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
    if v_item ? 'unit_usd' then v_line := round((v_item->>'unit_usd')::numeric * v_qty, 2);      -- 130: inside a bundle
    else
      v_sale := suqa._sale_offer(v_prod.id);                                                       -- 131: a running price offer
      v_line := case when v_sale.id is null then suqa._line_usd(v_prod, v_qty, v_fx)               -- 82: a lira-priced item at its own lira price; 103: at the shop's rate
                     when v_sale.price_currency = 'lbp' then round(v_sale.price_lbp * v_qty / v_fx, 2)
                     else round(v_sale.price_usd * v_qty, 2) end;
    end if;
    v_sub := v_sub + v_line;
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

  for v_item in select * from jsonb_array_elements(v_lines) loop
    select * into v_prod from suqa.products where id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    v_sale := null;
    if v_item ? 'unit_usd' then v_unit := (v_item->>'unit_usd')::numeric; v_line := round(v_unit * v_qty, 2);
    else
      v_sale := suqa._sale_offer(v_prod.id);
      if v_sale.id is null then v_unit := suqa._unit_usd(v_prod, v_fx); v_line := suqa._line_usd(v_prod, v_qty, v_fx);
      elsif v_sale.price_currency = 'lbp' then v_unit := round(v_sale.price_lbp / v_fx, 2); v_line := round(v_sale.price_lbp * v_qty / v_fx, 2);
      else v_unit := v_sale.price_usd; v_line := round(v_sale.price_usd * v_qty, 2); end if;
    end if;
    insert into suqa.order_items (order_id, tenant_id, product_id, name, unit, unit_price_usd, quantity, line_total_usd, notes)
    values (v_order.id, p_tenant.id, v_prod.id, v_prod.name, v_prod.unit, v_unit, v_qty, v_line,
            case when v_sale.id is null then v_item->>'notes'                                     -- 131: an offer price is said on the line
                 else left(concat_ws(' · ', '🏷 ' || coalesce(nullif(v_sale.name->>'ar', ''), v_sale.name->>'en', ''), nullif(v_item->>'notes', '')), 200) end);
  end loop;
  return v_order;
end $$;
revoke all on function suqa._place_shop_order(suqa.tenants, uuid, uuid, suqa.addresses, jsonb, text, text, uuid, text, numeric, text, timestamptz) from public, anon, authenticated;
grant execute on function suqa._place_shop_order(suqa.tenants, uuid, uuid, suqa.addresses, jsonb, text, text, uuid, text, numeric, text, timestamptz) to service_role;
