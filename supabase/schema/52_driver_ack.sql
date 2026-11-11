-- 52_driver_ack.sql — the shop's driver confirms he got the order ("✅ استلمت الطلب — أنا قادم").   (2026-11-11)
-- Two ways: the button on his sheet (/d/<order id>, public by unguessable id — the web route calls driver_ack with the service key),
-- or any WhatsApp reply from his number while he has an unconfirmed order (webhook → driver_ack_by_phone).
-- The POS sees orders.driver_ack_at through the normal feed (orders rows are synced whole) and shows "✓ أكّد 7:42" on the card.
-- driver_picked_at is reserved for the next step (driver taps "📦 استلمت من المحل"); nothing writes it yet.
-- Base file 06 lists both columns. Requires 06, 37. Idempotent.

alter table suqa.orders add column if not exists driver_ack_at    timestamptz;
alter table suqa.orders add column if not exists driver_picked_at timestamptz;

-- one acknowledgement per order; re-tapping is harmless. Only for an order that has a shop driver and is still on its way to the customer.
create or replace function suqa.driver_ack(p_order uuid, p_via text default 'sheet')
returns jsonb language plpgsql security definer set search_path = public as $$
declare o suqa.orders; v_driver text;
begin
  select * into o from suqa.orders where id = p_order for update;
  if not found then raise exception 'order_not_found'; end if;
  if o.driver_id is null then raise exception 'no_driver'; end if;
  if o.status not in ('accepted', 'preparing', 'ready', 'out_for_delivery') then
    return jsonb_build_object('ok', false, 'reason', 'closed', 'status', o.status, 'ack_at', o.driver_ack_at);
  end if;
  if o.driver_ack_at is not null then return jsonb_build_object('ok', true, 'already', true, 'ack_at', o.driver_ack_at); end if;
  update suqa.orders set driver_ack_at = now(), updated_at = now() where id = p_order;
  select name into v_driver from suqa.shop_drivers where id = o.driver_id;
  insert into suqa.order_events (order_id, tenant_id, actor_kind, note)
  values (p_order, o.tenant_id, 'system', '🛵✅ ' || coalesce(v_driver, '') || ' — ' || case when p_via = 'whatsapp' then 'أكّد عبر واتساب' else 'أكّد استلام الطلب' end);
  return jsonb_build_object('ok', true, 'ack_at', now(), 'driver', v_driver);
end $$;

-- WhatsApp reply from a driver: acknowledge his most recent unconfirmed order (sent to him within the last 12 hours)
create or replace function suqa.driver_ack_by_phone(p_phone text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_key text := suqa._phone_key(p_phone); v_order uuid;
begin
  if v_key is null then return null; end if;
  select o.id into v_order
    from suqa.orders o join suqa.shop_drivers d on d.id = o.driver_id
   where d.phone_key = v_key and o.driver_ack_at is null
     and o.status in ('accepted', 'preparing', 'ready', 'out_for_delivery') and o.updated_at > now() - interval '12 hours'
   order by o.updated_at desc limit 1;
  if v_order is null then return null; end if;
  perform suqa.driver_ack(v_order, 'whatsapp');
  return v_order;
end $$;

-- service key only (web route + webhook); never callable from a browser session
revoke all on function suqa.driver_ack(uuid, text) from public, anon, authenticated;
revoke all on function suqa.driver_ack_by_phone(text) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function suqa.driver_ack(uuid, text) to service_role;
    grant execute on function suqa.driver_ack_by_phone(text) to service_role;
  end if;
end $$;

select 'driver ack installed' as result;
