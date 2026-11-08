-- 29_pos_m9.sql — POS M9: delivery-zone fee from a map pin, WhatsApp location replies attached to customers/orders   (2026-11-08)
-- Requires 28. Idempotent.

-- Fee for a pin, from the shop's delivery zones (null zone = outside the delivery area → the POS keeps its default fee).
create or replace function suqa.pos_delivery_fee(p_shop uuid, p_lat double precision, p_lng double precision)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_tenant uuid; z record;
begin
  if suqa.pos_role(p_shop) is null then raise exception 'not_member' using errcode = 'insufficient_privilege'; end if;
  select tenant_id into v_tenant from suqa.shops where id = p_shop;
  select f.zone_id, f.fee_usd, f.eta_minutes, dz.name into z
    from suqa.find_zone(v_tenant, p_shop, st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography) f
    join suqa.delivery_zones dz on dz.id = f.zone_id;
  if z.zone_id is null then return jsonb_build_object('zone_id', null); end if;
  return jsonb_build_object('zone_id', z.zone_id, 'name', z.name, 'fee_usd', z.fee_usd, 'eta_minutes', z.eta_minutes);
end $$;
grant execute on function suqa.pos_delivery_fee(uuid, double precision, double precision) to authenticated;

-- A customer sent a WhatsApp location (webhook, service role): pin it on the customer record(s) of that tenant and on
-- any open delivery order of that phone. Returns the ids touched so the webhook can confirm to the customer.
create or replace function suqa.wa_attach_location(p_phone text, p_phone_number_id text, p_lat double precision, p_lng double precision, p_label text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_key text := suqa._phone_key(p_phone); v_tenant uuid; v_map text := 'https://maps.google.com/?q=' || round(p_lat::numeric, 6) || ',' || round(p_lng::numeric, 6);
        v_customers int := 0; v_orders int := 0; v_shop_name jsonb;
begin
  select tenant_id into v_tenant from suqa.wa_numbers where phone_number_id = p_phone_number_id;
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
end $$;
revoke all on function suqa.wa_attach_location(text, text, double precision, double precision, text) from public, anon, authenticated;

select 'pos m9 installed' as result;
