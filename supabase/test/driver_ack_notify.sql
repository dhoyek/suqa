-- 120: a driver's confirmation queues one message for the shop. Rolls back.
\set ON_ERROR_STOP on
begin;
do $$
declare o uuid; s uuid; t uuid; d uuid := gen_random_uuid(); r jsonb; n int; b jsonb;
begin
  select id, shop_id, tenant_id into o, s, t from suqa.orders where channel <> 'walkin' and not parked limit 1;
  insert into suqa.shop_drivers (id, shop_id, tenant_id, name, phone, phone_key, active, scope) values (d, s, t, 'driver 120', '+96170120001', suqa._phone_key('+96170120001'), true, 'shop');
  insert into suqa.integration_config (key, value) values ('wa_events_url', 'http://127.0.0.1:9/none'), ('wa_events_secret', 'x') on conflict (key) do update set value = excluded.value;
  alter table suqa.orders disable trigger user;
  update suqa.orders set driver_id = d, status = 'out_for_delivery', driver_ack_at = null where id = o;
  alter table suqa.orders enable trigger user;
  delete from suqa.wa_outbox where order_id = o;
  r := suqa.driver_ack(o, 'sheet');
  assert (r->>'ok')::boolean and r->>'driver' = 'driver 120', r::text;
  assert (select driver_ack_at is not null and status = 'out_for_delivery' from suqa.orders where id = o), 'time written, status unchanged';
  select count(*), max(body::text)::jsonb into n, b from suqa.wa_outbox where order_id = o and event = 'order.driver_ack';
  assert n = 1, 'one message queued for the shop, got ' || n;
  assert b->>'event' = 'order.driver_ack' and b->'order'->>'id' = o::text and b->'driver'->>'name' = 'driver 120', 'payload: ' || left(b::text, 300);
  r := suqa.driver_ack(o, 'whatsapp');
  assert (r->>'already')::boolean and (select count(*) = 1 from suqa.wa_outbox where order_id = o and event = 'order.driver_ack'), 'a second confirmation tells nobody again';
  alter table suqa.orders disable trigger user;
  update suqa.orders set status = 'delivered', driver_ack_at = null where id = o;
  alter table suqa.orders enable trigger user;
  r := suqa.driver_ack(o, 'sheet');
  assert not (r->>'ok')::boolean and (select count(*) = 1 from suqa.wa_outbox where order_id = o and event = 'order.driver_ack'), 'a closed order: nothing';
end $$;
rollback;
\echo driver_ack_notify ok
