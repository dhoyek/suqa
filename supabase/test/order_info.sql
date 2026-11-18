-- order.info (80): edit an order's information from the POS. One transaction on a database built from all.sql + pos_smoke fixtures; pg_net is a stub.
\set ON_ERROR_STOP on
begin;
create schema if not exists net;
create sequence if not exists net.req_seq;
create table if not exists net.sent (id bigint, body jsonb);
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 1000)
returns bigint language plpgsql as $$ declare i bigint := nextval('net.req_seq'); begin insert into net.sent values (i, body); return i; end $$;
grant usage on schema net to authenticated; grant all on all tables in schema net to authenticated; grant all on all sequences in schema net to authenticated;
insert into suqa.integration_config (key, value) values ('wa_events_url', 'https://x.test/api/wa/events'), ('wa_events_secret', 's') on conflict (key) do update set value = excluded.value;
\i supabase/schema/80_pos_order_info.sql

create or replace function pg_temp.round_lbp(p uuid, v bigint) returns void language sql security definer as $$ update suqa.orders set total_lbp = v where id = p $$;
set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';   -- shop owner

create or replace function pg_temp.push(p_kind text, p_payload jsonb, p_op uuid default gen_random_uuid()) returns jsonb language sql as $$
  select suqa.pos_push('0193a000-0000-7000-8000-000000000001', jsonb_build_array(jsonb_build_object('op_id', p_op, 'kind', p_kind, 'payload', p_payload)))->'results'->0 $$;

do $$
declare r jsonb; o suqa.orders; v_id uuid := gen_random_uuid(); v_walk uuid := gen_random_uuid(); v_op uuid := gen_random_uuid(); v_drv uuid := gen_random_uuid(); n int; c suqa.shop_customers;
        v_prod uuid := (select id from suqa.products where shop_id = (select id from suqa.shops where slug = 'abou-elie') limit 1);
begin
  -- a WhatsApp delivery order typed at the POS: 2 × $3.00 + $2.00 delivery = $8.00
  r := pg_temp.push('sale.commit', jsonb_build_object('id', v_id, 'local_number', 'T-000001', 'channel', 'whatsapp', 'status', 'accepted', 'rate_lbp_per_usd', 90000,
        'customer_name', 'Rima', 'customer_phone', '70111222', 'fulfillment', 'delivery', 'address', '{"line1":"Old street"}'::jsonb, 'delivery_fee_cents', 200,
        'subtotal_cents', 600, 'total_cents', 800, 'total_lbp', 720000, 'placed_at', now(),
        'lines', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'product_id', v_prod, 'name', '{"en":"x"}'::jsonb, 'qty', 2, 'unit_price_cents', 300, 'line_total_cents', 600))));
  assert r->>'status' = 'ok', 'order created: ' || r;
  select * into o from suqa.orders where id = v_id;
  assert o.status = 'accepted' and o.total_cents = 800 and o.delivery_fee_usd = 2, 'starting point: ' || o.status || ' ' || o.total_cents;
  delete from net.sent;

  -- 1. delivery → pickup: no fee, no address, total follows; the customer is told
  r := pg_temp.push('order.info', jsonb_build_object('id', v_id, 'customer_name', 'Rima K', 'customer_phone', '70111222', 'fulfillment', 'pickup', 'address', '{"line1":"Old street"}'::jsonb, 'delivery_fee_cents', 200, 'notes', 'ring twice'), v_op);
  assert r->>'status' = 'ok' and (r->>'total_cents')::int = 600 and r->>'amount_locked' = 'false', 'to pickup: ' || r;
  select * into o from suqa.orders where id = v_id;
  assert o.fulfillment = 'pickup' and o.delivery_fee_usd = 0 and o.total_cents = 600 and o.total_usd = 6 and o.total_lbp = 540000 and o.address = '{}'::jsonb and o.customer_name = 'Rima K' and o.customer_notes = 'ring twice', 'pickup row';
  assert (select count(*) from net.sent where body->>'event' = 'order.edited') = 1, 'customer told once';

  -- 2. the same op again (retry after a lost answer) changes nothing and sends nothing
  r := pg_temp.push('order.info', jsonb_build_object('id', v_id, 'fulfillment', 'delivery', 'delivery_fee_cents', 900), v_op);
  assert r->>'replayed' = 'true', 'replayed: ' || r;
  select * into o from suqa.orders where id = v_id; assert o.total_cents = 600, 'replay does not apply twice';
  assert (select count(*) from net.sent where body->>'event' = 'order.edited') = 1, 'no second message';

  -- 3. only the name: no message, nothing else moves
  r := pg_temp.push('order.info', jsonb_build_object('id', v_id, 'customer_name', 'Rima Khoury'));
  select * into o from suqa.orders where id = v_id;
  perform pg_temp.round_lbp(v_id, 545000);   -- as rounded at the till
  r := pg_temp.push('order.info', jsonb_build_object('id', v_id, 'customer_name', 'Rima Khoury'));
  assert o.customer_name = 'Rima Khoury' and o.fulfillment = 'pickup' and o.total_cents = 600 and o.customer_notes = 'ring twice', 'name only';
  assert o.total_lbp = 545000, 'a name fix leaves the rounded LBP total alone: ' || o.total_lbp;
  assert (select count(*) from net.sent where body->>'event' = 'order.edited') = 1, 'a name fix is silent';

  -- 4. back to delivery, new address and fee, a driver lined up; then to pickup again: fee and driver go
  r := pg_temp.push('order.info', jsonb_build_object('id', v_id, 'fulfillment', 'delivery', 'address', '{"line1":"New street","lat":34.25,"lng":35.66}'::jsonb, 'delivery_fee_cents', 150, 'notify', false));
  select * into o from suqa.orders where id = v_id;
  assert o.fulfillment = 'delivery' and o.total_cents = 750 and o.address->>'line1' = 'New street', 'to delivery: ' || o.total_cents;
  assert (select count(*) from net.sent where body->>'event' = 'order.edited') = 1, 'notify:false is silent';
  select * into c from suqa.shop_customers where shop_id = o.shop_id and phone_key = suqa._phone_key('70111222');
  assert c.name = 'Rima Khoury' and c.addresses::text like '%New street%' and c.orders_count = 1, 'customer record learned it, not counted twice: ' || c.orders_count;
  r := pg_temp.push('driver.upsert', jsonb_build_object('id', v_drv, 'name', 'Tony', 'phone', '70999888'));
  assert r->>'status' = 'ok', 'driver: ' || r;
  r := pg_temp.push('order.status', jsonb_build_object('id', v_id, 'status', 'accepted', 'driver_id', v_drv));
  select * into o from suqa.orders where id = v_id; assert o.driver_id = v_drv, 'driver lined up';
  r := pg_temp.push('order.info', jsonb_build_object('id', v_id, 'fulfillment', 'pickup', 'notify', false));
  select * into o from suqa.orders where id = v_id;
  assert o.driver_id is null and o.courier_name is null and o.total_cents = 600 and o.delivery_fee_usd = 0, 'pickup drops the driver';

  -- 5. delivered and paid ($6.00): information can still be corrected, the amount cannot
  r := pg_temp.push('order.info', jsonb_build_object('id', v_id, 'fulfillment', 'delivery', 'address', '{"line1":"New street"}'::jsonb, 'delivery_fee_cents', 100, 'notify', false));
  r := pg_temp.push('order.pay', jsonb_build_object('id', v_id, 'status', 'delivered', 'paid_usd_cents', 700, 'payments', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'tender', 'cash_usd', 'amount', 700, 'currency', 'usd'))));
  select * into o from suqa.orders where id = v_id; assert o.status = 'delivered' and o.total_cents = 700, 'delivered at $7.00: ' || o.status || o.total_cents;
  delete from net.sent;
  r := pg_temp.push('order.info', jsonb_build_object('id', v_id, 'customer_name', 'Rima K.', 'customer_phone', '70111333', 'fulfillment', 'pickup', 'delivery_fee_cents', 0, 'notes', 'was a pickup'));
  assert r->>'status' = 'ok' and r->>'amount_locked' = 'true' and (r->>'total_cents')::int = 700, 'delivered edit: ' || r;
  select * into o from suqa.orders where id = v_id;
  assert o.fulfillment = 'pickup' and o.delivery_fee_usd = 1 and o.total_cents = 700 and o.paid_usd_cents = 700 and o.customer_phone = '70111333' and o.customer_name = 'Rima K.' and o.status = 'delivered', 'delivered: info yes, money no';
  assert (select count(*) from net.sent) = 0, 'a delivered order sends nothing';
  assert (select coalesce(sum(amount), 0) from suqa.payments where order_id = v_id) = 700, 'payments untouched';

  -- 6. not for walk-in sales, cancelled orders or another shop's order
  r := pg_temp.push('sale.commit', jsonb_build_object('id', v_walk, 'local_number', 'T-000002', 'channel', 'walkin', 'rate_lbp_per_usd', 90000, 'subtotal_cents', 300, 'total_cents', 300, 'total_lbp', 270000, 'placed_at', now(),
        'lines', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'product_id', v_prod, 'name', '{"en":"x"}'::jsonb, 'qty', 1, 'unit_price_cents', 300, 'line_total_cents', 300))));
  r := pg_temp.push('order.info', jsonb_build_object('id', v_walk, 'fulfillment', 'delivery', 'delivery_fee_cents', 500));
  assert r->>'status' = 'rejected' and r->>'error' = 'not_an_order', 'walk-in: ' || r;
  r := pg_temp.push('order.info', jsonb_build_object('id', gen_random_uuid(), 'fulfillment', 'pickup'));
  assert r->>'status' = 'rejected' and r->>'error' = 'order_not_found', 'unknown: ' || r;

  -- 7. audited like every op
  select count(*) into n from suqa.audit_log where action = 'order.info' and ref_id = v_id::text;
  assert n >= 5, 'audit rows: ' || n;
  raise notice 'order.info: all checks passed';
end $$;

-- cashier may fix an open order; the stock role may not
set local request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
select suqa.pos_role((select id from suqa.shops where slug = 'abou-elie')) as staff_role;
rollback;
