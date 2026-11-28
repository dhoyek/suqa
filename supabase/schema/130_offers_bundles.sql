-- 130 — offers, step 1: bundles.
--
-- A shop's OFFERS list. This script carries the tables for every kind (bundle, discount, buy-x-get-y) and the rules for the
-- first kind, the BUNDLE: a named set of the shop's items (with quantities) sold together for one price.
--
--   offers        one row per offer: kind, names, picture, price (in dollars OR lira — the currency its items are priced in),
--                 active / hot, optional start and end, optional "at most N per order", order on the page
--   offer_items   the items inside it, with quantities (whole numbers)
--
-- Who does what
--   · everyone (public key included) READS the active offers of active shops — they are on the shop page;
--   · the shop's OWNER creates / changes / removes them, through offer_save / offer_delete (nobody writes the tables directly);
--   · an order placed online may carry {"offer_id": …, "quantity": n} next to its ordinary items: the server replaces it by the
--     bundle's items, each at its price INSIDE the bundle, marked "🎁 <bundle name>" on the line. Stock, returns and reports
--     then see ordinary lines.
--
-- The price inside a bundle (suqa._bundle_lines; the till and the shop page compute the same in pos-core `bundleAlloc`):
--   T = the bundle price, S = Σ normal unit price × quantity (both in dollar cents online)
--   unit_i = floor(normal_i × T / S); what is left of T is added to the unit price of the lines it divides into
--   (smallest quantity first — a line of quantity 1 takes it all). The bundle is charged Σ unit_i × quantity_i: T, or a few
--   cents under T when no line can take the remainder. Never above T, never above the normal prices.
--
-- A bundle is on sale only while: it is active and inside its dates, every item in it is active, available and priced in the
-- bundle's currency, and its price is below the items' normal total.
--
-- _place_shop_order is 103's version + the four places marked "130". Requires 103. Idempotent.

-- ── tables (full) ────────────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists suqa.offers (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references suqa.tenants(id) on delete cascade,
  shop_id        uuid not null references suqa.shops(id) on delete cascade,
  kind           text not null default 'bundle' check (kind in ('bundle','discount','bxgy')),
  name           jsonb not null,                                   -- {"ar": …, "en": …}
  description    jsonb not null default '{}'::jsonb,
  image_url      text,
  price_currency text not null default 'usd' check (price_currency in ('usd','lbp')),   -- the currency the offer price is set in
  price_usd      numeric(12,2) not null default 0 check (price_usd >= 0),              -- used when price_currency = 'usd'
  price_lbp      bigint not null default 0 check (price_lbp >= 0),                     -- used when price_currency = 'lbp'
  is_active      boolean not null default true,                    -- the owner's switch
  is_hot         boolean not null default false,                   -- shown first, with 🔥
  starts_at      timestamptz,                                      -- null = from now
  ends_at        timestamptz,                                      -- null = until switched off
  max_per_order  int check (max_per_order is null or max_per_order between 1 and 99),
  sort_order     int not null default 0,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);
create index if not exists offers_shop on suqa.offers(shop_id, is_active);

create table if not exists suqa.offer_items (
  offer_id    uuid not null references suqa.offers(id) on delete cascade,
  product_id  uuid not null references suqa.products(id) on delete cascade,
  tenant_id   uuid not null references suqa.tenants(id) on delete cascade,
  shop_id     uuid not null references suqa.shops(id) on delete cascade,
  quantity    numeric(10,3) not null check (quantity >= 1 and quantity <= 99 and quantity = trunc(quantity)),
  sort_order  int not null default 0,
  primary key (offer_id, product_id)
);
create index if not exists offer_items_product on suqa.offer_items(product_id);

drop trigger if exists set_updated_at on suqa.offers;
create trigger set_updated_at before update on suqa.offers for each row execute function suqa.set_updated_at();

alter table suqa.offers enable row level security;
alter table suqa.offer_items enable row level security;
select suqa._policy('offers', 'offers_read', 'select', 'anon, authenticated',
  '(is_active and exists (select 1 from suqa.shops s where s.id = shop_id and s.status = ''active''))
   or suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)');
select suqa._policy('offer_items', 'offer_items_read', 'select', 'anon, authenticated',
  '(exists (select 1 from suqa.offers o join suqa.shops s on s.id = o.shop_id where o.id = offer_id and o.is_active and s.status = ''active''))
   or suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)');
revoke all on suqa.offers, suqa.offer_items from public, anon, authenticated;
grant select on suqa.offers, suqa.offer_items to anon, authenticated;      -- writes only through offer_save / offer_delete
grant all on suqa.offers, suqa.offer_items to service_role;

-- ── the price of each item inside a bundle, in dollar cents ──────────────────────────────────────────────────────────
create or replace function suqa._bundle_lines(p_offer uuid, p_fx numeric)
returns table (product_id uuid, quantity numeric, unit_cents int, normal_cents int)
language plpgsql stable security definer set search_path = public as $$
declare v_o suqa.offers; v_t bigint; v_s bigint; v_rem bigint; v_k bigint; r record;
        v_ids uuid[] := '{}'; v_q numeric[] := '{}'; v_u bigint[] := '{}'; v_n bigint[] := '{}'; i int;
begin
  select * into v_o from suqa.offers where id = p_offer;
  if not found then return; end if;
  v_t := case when v_o.price_currency = 'lbp' then case when coalesce(p_fx, 0) > 0 then round(v_o.price_lbp * 100.0 / p_fx) else 0 end else round(v_o.price_usd * 100) end;
  for r in select oi.product_id, oi.quantity, round(suqa._unit_usd(p, p_fx) * 100)::bigint as u
             from suqa.offer_items oi join suqa.products p on p.id = oi.product_id
            where oi.offer_id = p_offer order by oi.sort_order, oi.product_id loop
    v_ids := v_ids || r.product_id; v_q := v_q || r.quantity; v_n := v_n || r.u; v_u := v_u || r.u;
  end loop;
  if coalesce(array_length(v_ids, 1), 0) = 0 then return; end if;
  select sum(v_n[x] * v_q[x]) into v_s from generate_subscripts(v_ids, 1) x;
  if v_t > 0 and v_s > 0 and v_t < v_s then
    for i in 1 .. array_length(v_ids, 1) loop v_u[i] := floor(v_n[i] * v_t::numeric / v_s); end loop;
    select v_t - sum(v_u[x] * v_q[x]) into v_rem from generate_subscripts(v_ids, 1) x;
    for r in select x from generate_subscripts(v_ids, 1) x order by v_q[x], x loop      -- smallest quantity first
      exit when v_rem <= 0;
      v_k := least(floor(v_rem / v_q[r.x]), v_n[r.x] - v_u[r.x]);                       -- never above the item's normal price
      if v_k > 0 then v_u[r.x] := v_u[r.x] + v_k; v_rem := v_rem - v_k * v_q[r.x]::bigint; end if;
    end loop;
  end if;
  for i in 1 .. array_length(v_ids, 1) loop
    product_id := v_ids[i]; quantity := v_q[i]; unit_cents := v_u[i]::int; normal_cents := v_n[i]::int; return next;
  end loop;
end $$;
revoke all on function suqa._bundle_lines(uuid, numeric) from public, anon, authenticated;

-- is this bundle on sale right now? (active, inside its dates, every item sellable and in the bundle's currency, a real saving)
create or replace function suqa._bundle_ok(p_offer uuid, p_fx numeric) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from suqa.offers o
                  where o.id = p_offer and o.kind = 'bundle' and o.is_active
                    and (o.starts_at is null or o.starts_at <= now()) and (o.ends_at is null or o.ends_at > now())
                    and exists (select 1 from suqa.offer_items oi where oi.offer_id = o.id)
                    and not exists (select 1 from suqa.offer_items oi join suqa.products p on p.id = oi.product_id
                                     where oi.offer_id = o.id and not (p.is_active and p.is_available and p.shop_id = o.shop_id and p.price_currency = o.price_currency)))
     and (select sum(b.unit_cents * b.quantity) < sum(b.normal_cents * b.quantity) from suqa._bundle_lines(p_offer, p_fx) b)
$$;
revoke all on function suqa._bundle_ok(uuid, numeric) from public, anon, authenticated;

-- an order's items with every {"offer_id", "quantity"} entry replaced by the bundle's items
create or replace function suqa._order_expand_offers(p_shop uuid, p_items jsonb, p_fx numeric) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_item jsonb; v_out jsonb := '[]'::jsonb; v_o suqa.offers; v_n numeric; r record;
begin
  if jsonb_typeof(p_items) <> 'array' then return p_items; end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    if not (v_item ? 'offer_id') then v_out := v_out || jsonb_build_array(v_item); continue; end if;
    select * into v_o from suqa.offers where id = (v_item->>'offer_id')::uuid and shop_id = p_shop;
    if not found or not suqa._bundle_ok(v_o.id, p_fx) then raise exception 'offer_unavailable' using detail = v_item->>'offer_id'; end if;
    v_n := (v_item->>'quantity')::numeric;
    if v_n is null or v_n < 1 or v_n > 99 or v_n <> trunc(v_n) or v_n > coalesce(v_o.max_per_order, 99) then
      raise exception 'offer_quantity' using detail = v_item->>'offer_id', hint = coalesce(v_o.max_per_order, 99)::text;
    end if;
    for r in select * from suqa._bundle_lines(v_o.id, p_fx) loop
      v_out := v_out || jsonb_build_array(jsonb_build_object('product_id', r.product_id, 'quantity', r.quantity * v_n, 'unit_usd', r.unit_cents / 100.0,
                 'notes', left('🎁 ' || coalesce(nullif(v_o.name->>'ar', ''), v_o.name->>'en', ''), 200)));
    end loop;
  end loop;
  if jsonb_array_length(v_out) > 200 then raise exception 'too_many_lines' using detail = '200'; end if;
  return v_out;
end $$;
revoke all on function suqa._order_expand_offers(uuid, jsonb, numeric) from public, anon, authenticated;

-- ── the owner's two actions ──────────────────────────────────────────────────────────────────────────────────────────
-- p = { id?, name {ar,en}, description {ar,en}?, image_url?, price_currency 'usd'|'lbp', price (dollars, or lira),
--       is_active?, is_hot?, starts_at?, ends_at?, max_per_order?, sort_order?, items [{ product_id, quantity }] }
create or replace function suqa.offer_save(p_shop uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_shop suqa.shops; v_id uuid := nullif(p->>'id', '')::uuid; v_cur text := coalesce(p->>'price_currency', 'usd'); v_price numeric := (p->>'price')::numeric;
        v_name jsonb := jsonb_strip_nulls(jsonb_build_object('ar', nullif(btrim(p->'name'->>'ar'), ''), 'en', nullif(btrim(p->'name'->>'en'), '')));
        v_it jsonb; v_prod suqa.products; v_q numeric; v_normal numeric := 0; v_units numeric := 0; v_n int := 0; v_fx numeric;
begin
  if not suqa.is_shop_owner(p_shop) then raise exception 'not_owner' using errcode = 'insufficient_privilege'; end if;
  select * into v_shop from suqa.shops where id = p_shop;
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
    v_q := (v_it->>'quantity')::numeric;
    if v_q is null or v_q < 1 or v_q > 99 or v_q <> trunc(v_q) then raise exception 'offer_bad_quantity' using detail = v_prod.id::text; end if;
    v_normal := v_normal + v_q * case when v_cur = 'lbp' then v_prod.price_lbp else v_prod.price_usd end;
    v_units := v_units + v_q; v_n := v_n + 1;
  end loop;
  if v_units < 2 then raise exception 'offer_needs_two'; end if;                          -- one unit of one item is not a bundle
  if v_price >= v_normal then raise exception 'offer_no_saving' using detail = v_normal::text; end if;

  if v_id is null then
    insert into suqa.offers (tenant_id, shop_id, kind, name, description, image_url, price_currency, price_usd, price_lbp, is_active, is_hot, starts_at, ends_at, max_per_order, sort_order, created_by)
    values (v_shop.tenant_id, p_shop, 'bundle', v_name, coalesce(p->'description', '{}'::jsonb), nullif(p->>'image_url', ''), v_cur,
            case when v_cur = 'usd' then round(v_price, 2) else 0 end, case when v_cur = 'lbp' then round(v_price)::bigint else 0 end,
            coalesce((p->>'is_active')::boolean, true), coalesce((p->>'is_hot')::boolean, false), nullif(p->>'starts_at', '')::timestamptz, nullif(p->>'ends_at', '')::timestamptz,
            nullif(p->>'max_per_order', '')::int, coalesce((p->>'sort_order')::int, (select coalesce(max(sort_order), 0) + 1 from suqa.offers where shop_id = p_shop)), auth.uid())
    returning id into v_id;
  else
    update suqa.offers set name = v_name, description = coalesce(p->'description', description), image_url = nullif(p->>'image_url', ''), price_currency = v_cur,
           price_usd = case when v_cur = 'usd' then round(v_price, 2) else 0 end, price_lbp = case when v_cur = 'lbp' then round(v_price)::bigint else 0 end,
           is_active = coalesce((p->>'is_active')::boolean, is_active), is_hot = coalesce((p->>'is_hot')::boolean, is_hot),
           starts_at = nullif(p->>'starts_at', '')::timestamptz, ends_at = nullif(p->>'ends_at', '')::timestamptz,
           max_per_order = nullif(p->>'max_per_order', '')::int, sort_order = coalesce((p->>'sort_order')::int, sort_order)
     where id = v_id;
    delete from suqa.offer_items where offer_id = v_id;
  end if;
  insert into suqa.offer_items (offer_id, product_id, tenant_id, shop_id, quantity, sort_order)
  select v_id, (x.it->>'product_id')::uuid, v_shop.tenant_id, p_shop, sum((x.it->>'quantity')::numeric), min(x.ord)::int
    from jsonb_array_elements(p->'items') with ordinality as x(it, ord) group by 2;
  if exists (select 1 from suqa.offer_items where offer_id = v_id and quantity > 99) then raise exception 'offer_bad_quantity'; end if;
  return v_id;
end $$;
revoke all on function suqa.offer_save(uuid, jsonb) from public, anon;
grant execute on function suqa.offer_save(uuid, jsonb) to authenticated;

create or replace function suqa.offer_delete(p_offer uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_shop uuid;
begin
  select shop_id into v_shop from suqa.offers where id = p_offer;
  if v_shop is null then return; end if;
  if not suqa.is_shop_owner(v_shop) then raise exception 'not_owner' using errcode = 'insufficient_privilege'; end if;
  delete from suqa.offers where id = p_offer;
end $$;
revoke all on function suqa.offer_delete(uuid) from public, anon;
grant execute on function suqa.offer_delete(uuid) to authenticated;

-- ── an online order may carry bundles (103 + the lines marked 130) ───────────────────────────────────────────────────
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
    v_sub := v_sub + case when v_item ? 'unit_usd' then round((v_item->>'unit_usd')::numeric * v_qty, 2)      -- 130: inside a bundle
                          else suqa._line_usd(v_prod, v_qty, v_fx) end;   -- 82: a lira-priced item at its own lira price; 103: at the shop's rate
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
    insert into suqa.order_items (order_id, tenant_id, product_id, name, unit, unit_price_usd, quantity, line_total_usd, notes)
    values (v_order.id, p_tenant.id, v_prod.id, v_prod.name, v_prod.unit,
            case when v_item ? 'unit_usd' then (v_item->>'unit_usd')::numeric else suqa._unit_usd(v_prod, v_fx) end, v_qty,
            case when v_item ? 'unit_usd' then round((v_item->>'unit_usd')::numeric * v_qty, 2) else suqa._line_usd(v_prod, v_qty, v_fx) end, v_item->>'notes');
  end loop;
  return v_order;
end $$;
revoke all on function suqa._place_shop_order(suqa.tenants, uuid, uuid, suqa.addresses, jsonb, text, text, uuid, text, numeric, text, timestamptz) from public, anon, authenticated;
grant execute on function suqa._place_shop_order(suqa.tenants, uuid, uuid, suqa.addresses, jsonb, text, text, uuid, text, numeric, text, timestamptz) to service_role;
