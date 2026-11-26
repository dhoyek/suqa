-- 121: a location the customer shares on WhatsApp is kept for 30 minutes, so it is not lost when it arrives BEFORE the
--   shop has saved the customer or the order (Najem Market, 25 Nov 2026: asked at 12:53:32, pin at 12:53:58, order saved at
--   12:55 → the pin found no customer and no order and was dropped).
--
--   table suqa.wa_pins          every shared WhatsApp location: market, phone key, lat / lng, label, when. Kept 7 days, then
--                               removed by wa_attach_location itself. No policy: only the functions below read it.
--
--     create table suqa.wa_pins (
--       id          bigint generated always as identity primary key,
--       tenant_id   uuid references suqa.tenants(id) on delete cascade,      -- the market whose WhatsApp number received it
--       phone_key   text not null,                                           -- suqa._phone_key(sender)
--       lat         double precision not null,
--       lng         double precision not null,
--       label       text,                                                    -- the place name / address WhatsApp sent, if any
--       received_at timestamptz not null default now()
--     );
--
--   wa_attach_location        (changed) also writes the pin into wa_pins; everything it did before is unchanged.
--   _wa_pin(tenant, phone, minutes)   the newest pin of that phone in that market within the last N minutes, or null.
--   pos_wa_pin(shop, phone)   for the POS customer box: the pin of the last 30 minutes. Shop members only (pos_role).
--   orders  BEFORE INSERT     a DELIVERY order saved without a pin takes the customer's pin of the last 30 minutes.
--   shop_customers BEFORE INSERT  a new customer saved without a pin takes it too.
--   A pin the shop set itself is never replaced. Money, fees and zones are not touched (the fee stays what the shop chose).
--   (Planned as 119 in another session; 119 and 120 were taken meanwhile.)
-- Safe to run twice.

create table if not exists suqa.wa_pins (
  id          bigint generated always as identity primary key,
  tenant_id   uuid references suqa.tenants(id) on delete cascade,
  phone_key   text not null,
  lat         double precision not null,
  lng         double precision not null,
  label       text,
  received_at timestamptz not null default now()
);
create index if not exists wa_pins_phone_idx on suqa.wa_pins (phone_key, received_at desc);
alter table suqa.wa_pins enable row level security;
revoke all on suqa.wa_pins from public, anon, authenticated;

create or replace function suqa.wa_attach_location(p_phone text, p_phone_number_id text, p_lat double precision, p_lng double precision, p_label text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_key text := suqa._phone_key(p_phone); v_tenant uuid; v_map text := 'https://maps.google.com/?q=' || round(p_lat::numeric, 6) || ',' || round(p_lng::numeric, 6);
        v_customers int := 0; v_orders int := 0; v_shop_name jsonb;
begin
  select tenant_id into v_tenant from suqa.wa_numbers where phone_number_id = p_phone_number_id;
  if v_key is not null then                                     -- 121: kept 30 min for a customer / order saved after it
    insert into suqa.wa_pins (tenant_id, phone_key, lat, lng, label) values (v_tenant, v_key, p_lat, p_lng, nullif(p_label, ''));
    delete from suqa.wa_pins where received_at < now() - interval '7 days';
  end if;
  with upd as (
    update suqa.shop_customers set address = address || jsonb_strip_nulls(jsonb_build_object('lat', p_lat, 'lng', p_lng, 'map_url', v_map, 'line1', case when coalesce(address->>'line1', '') = '' then p_label end))
     where phone_key = v_key and (v_tenant is null or tenant_id = v_tenant) returning 1)
  select count(*) into v_customers from upd;
  with upd as (
    update suqa.orders set address = coalesce(address, '{}'::jsonb) || jsonb_build_object('lat', p_lat, 'lng', p_lng, 'map_url', v_map)
     where suqa._phone_key(customer_phone) = v_key and fulfillment = 'delivery' and status not in ('delivered','cancelled','rejected') and not parked
       and (v_tenant is null or tenant_id = v_tenant) returning shop_id)
  select count(*), (select name from suqa.shops where id = (select shop_id from upd limit 1)) into v_orders, v_shop_name from upd;
  return jsonb_build_object('customers', v_customers, 'orders', v_orders, 'map_url', v_map, 'shop_name', v_shop_name);
end $function$;

create or replace function suqa._wa_pin(p_tenant uuid, p_phone text, p_minutes int default 30)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select jsonb_build_object('lat', p.lat, 'lng', p.lng, 'label', p.label, 'received_at', p.received_at,
                            'map_url', 'https://maps.google.com/?q=' || round(p.lat::numeric, 6) || ',' || round(p.lng::numeric, 6))
    from suqa.wa_pins p
   where p.phone_key = suqa._phone_key(p_phone) and (p.tenant_id is null or p.tenant_id = p_tenant)
     and p.received_at > now() - make_interval(mins => greatest(1, least(coalesce(p_minutes, 30), 120)))
   order by p.received_at desc limit 1
$function$;
revoke all on function suqa._wa_pin(uuid, text, int) from public, anon, authenticated;

create or replace function suqa.pos_wa_pin(p_shop uuid, p_phone text)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare v_tenant uuid;
begin
  if auth.uid() is null or suqa.pos_role(p_shop) is null then raise exception 'not_allowed' using errcode = 'insufficient_privilege'; end if;
  select tenant_id into v_tenant from suqa.shops where id = p_shop;
  return suqa._wa_pin(v_tenant, p_phone, 30);
end $function$;
revoke all on function suqa.pos_wa_pin(uuid, text) from public, anon;
grant execute on function suqa.pos_wa_pin(uuid, text) to authenticated;

create or replace function suqa.orders_fill_wa_pin()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_pin jsonb;
begin
  if new.fulfillment = 'delivery' and coalesce(new.address->>'lat', '') = '' and coalesce(new.customer_phone, '') <> '' then
    v_pin := suqa._wa_pin(new.tenant_id, new.customer_phone, 30);
    if v_pin is not null then
      new.address := coalesce(new.address, '{}'::jsonb) || jsonb_build_object('lat', (v_pin->>'lat')::double precision, 'lng', (v_pin->>'lng')::double precision, 'map_url', v_pin->>'map_url');
    end if;
  end if;
  return new;
end $function$;
drop trigger if exists orders_2_wa_pin on suqa.orders;
create trigger orders_2_wa_pin before insert on suqa.orders for each row execute function suqa.orders_fill_wa_pin();

create or replace function suqa.shop_customers_fill_wa_pin()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_pin jsonb;
begin
  if coalesce(new.address->>'lat', '') = '' and coalesce(new.phone, '') <> '' then
    v_pin := suqa._wa_pin(new.tenant_id, new.phone, 30);
    if v_pin is not null then
      new.address := coalesce(new.address, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('lat', (v_pin->>'lat')::double precision, 'lng', (v_pin->>'lng')::double precision, 'map_url', v_pin->>'map_url',
                       'line1', case when coalesce(new.address->>'line1', '') = '' then v_pin->>'label' end));
    end if;
  end if;
  return new;
end $function$;
drop trigger if exists shop_customers_wa_pin on suqa.shop_customers;
create trigger shop_customers_wa_pin before insert on suqa.shop_customers for each row execute function suqa.shop_customers_fill_wa_pin();
