-- 81: the driver's final "delivered", the cash he holds, the settlement. One transaction on a database built from all.sql + pos_smoke fixtures; pg_net is a stub.
\set ON_ERROR_STOP on
begin;
create schema if not exists net;
create sequence if not exists net.req_seq;
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 1000)
returns bigint language sql as $$ select nextval('net.req_seq') $$;
grant usage on schema net to authenticated; grant all on all sequences in schema net to authenticated;
\i supabase/schema/81_driver_confirm_cash.sql
create schema if not exists t_dc; grant usage on schema t_dc to authenticated;
-- the driver's page calls these with the service key: here, as the table owner
create or replace function t_dc.step(p uuid, s text, c boolean default true) returns jsonb language sql security definer as $$ select suqa.driver_step(p, s, c) $$;
create or replace function t_dc.balance(p uuid) returns jsonb language sql security definer as $$ select suqa.driver_balance(p) $$;
grant execute on all functions in schema t_dc to authenticated;

set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';   -- shop owner
create or replace function pg_temp.push(p_kind text, p_payload jsonb, p_op uuid default gen_random_uuid()) returns jsonb language sql as $$
  select suqa.pos_push('0193a000-0000-7000-8000-000000000001', jsonb_build_array(jsonb_build_object('op_id', p_op, 'kind', p_kind, 'payload', p_payload)))->'results'->0 $$;

do $$
declare r jsonb; b jsonb; o suqa.orders; v_a uuid := gen_random_uuid(); v_b uuid := gen_random_uuid(); v_c uuid := gen_random_uuid(); v_drv uuid := gen_random_uuid(); v_pay uuid := gen_random_uuid(); n int;
        v_shop uuid := (select id from suqa.shops where slug = 'abou-elie');
        v_prod uuid := (select id from suqa.products where shop_id = (select id from suqa.shops where slug = 'abou-elie') limit 1);
begin
  r := pg_temp.push('driver.upsert', jsonb_build_object('id', v_drv, 'name', 'Tony', 'phone', '70999888'));
  perform suqa.pos_set_driver_pay(v_shop, null, 'per_delivery', 100);     -- $1.00 per delivery
  -- three delivery orders of $8.00 (6 + 2 fee), driver lined up
  for i in 1..3 loop
    r := pg_temp.push('sale.commit', jsonb_build_object('id', (array[v_a, v_b, v_c])[i], 'local_number', 'D-00000' || i, 'channel', 'whatsapp', 'status', 'accepted', 'rate_lbp_per_usd', 90000,
          'customer_name', 'C' || i, 'customer_phone', '7011122' || i, 'fulfillment', 'delivery', 'address', '{"line1":"x"}'::jsonb, 'delivery_fee_cents', 200,
          'subtotal_cents', 600, 'total_cents', 800, 'total_lbp', 720000, 'placed_at', now(),
          'lines', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'product_id', v_prod, 'name', '{"en":"x"}'::jsonb, 'qty', 2, 'unit_price_cents', 300, 'line_total_cents', 600))));
    assert r->>'status' = 'ok', 'order: ' || r;
    r := pg_temp.push('order.status', jsonb_build_object('id', (array[v_a, v_b, v_c])[i], 'status', 'accepted', 'driver_id', v_drv));
  end loop;

  -- on the road: he holds nothing yet, $8 to collect on each
  r := t_dc.step(v_a, 'picked'); assert r->>'ok' = 'true', 'picked: ' || r;
  select * into o from suqa.orders where id = v_a; assert o.status = 'out_for_delivery', 'on the road';
  b := t_dc.balance(v_drv);
  assert (b->>'cash_cents')::int = 0 and jsonb_array_length(b->'on_road') = 3 and (b->'on_road'->0->>'due_cents')::int = 800, 'before: ' || b;

  -- A: delivered + collected → delivered on the POS, paid, cash with the driver (not in a shift)
  r := t_dc.step(v_a, 'delivered', true);
  assert r->>'ok' = 'true' and (r->>'collected_cents')::int = 800, 'A delivered: ' || r;
  select * into o from suqa.orders where id = v_a;
  assert o.status = 'delivered' and o.delivered_at is not null and o.paid_usd_cents = 800 and o.courier_fee_cents = 100 and o.shift_id is null, 'A row: ' || o.status || ' ' || o.paid_usd_cents || ' ' || o.courier_fee_cents;
  assert (select count(*) from suqa.payments where order_id = v_a and tender = 'driver' and amount = 800 and settled_at is null) = 1, 'A payment with the driver';
  -- a second tap (double click / back button) adds nothing
  r := t_dc.step(v_a, 'delivered', true); assert r->>'already' = 'true', 'second tap: ' || r;
  assert (select count(*) from suqa.payments where order_id = v_a) = 1, 'no second payment';

  -- B: delivered, the customer did not pay → delivered and unpaid
  r := t_dc.step(v_b, 'delivered', false);
  select * into o from suqa.orders where id = v_b;
  assert o.status = 'delivered' and coalesce(o.paid_usd_cents, 0) = 0 and (select count(*) from suqa.payments where order_id = v_b) = 0, 'B unpaid';

  -- C: straight from the shop to delivered + collected (he skipped "picked")
  r := t_dc.step(v_c, 'delivered');
  select * into o from suqa.orders where id = v_c; assert o.status = 'delivered' and o.driver_picked_at is not null, 'C delivered';

  b := t_dc.balance(v_drv);
  assert (b->>'cash_cents')::int = 1600 and (b->>'owed_cents')::int = 300 and (b->>'net_cents')::int = 1300 and jsonb_array_length(b->'on_road') = 0 and jsonb_array_length(b->'open') = 3, 'balance: ' || b;
  r := suqa.pos_driver_report(v_shop, current_date - 1, current_date + 1);
  assert (r->'drivers'->0->>'cash_cents')::int = 1600 and (r->'drivers'->0->>'owed_cents')::int = 300 and (r->'drivers'->0->>'holding_cents')::int = 0, 'report: ' || (r->'drivers'->0);

  -- the owner corrects C: he really collected $5.00 — not more than the order
  r := pg_temp.push('order.driver_cash', jsonb_build_object('id', v_c, 'cents', 900)); assert r->>'error' = 'more_than_due', 'too much: ' || r;
  r := pg_temp.push('order.driver_cash', jsonb_build_object('id', v_c, 'cents', 500)); assert r->>'status' = 'ok', 'correct: ' || r;
  select * into o from suqa.orders where id = v_c; assert o.paid_usd_cents = 500, 'C paid 5';
  -- … and on B he did collect after all
  r := pg_temp.push('order.driver_cash', jsonb_build_object('id', v_b, 'cents', 800)); assert r->>'status' = 'ok', 'B corrected: ' || r;
  b := t_dc.balance(v_drv); assert (b->>'cash_cents')::int = 2100, 'after corrections: ' || (b->>'cash_cents');

  -- settlement: cash of A and C + pay of all three, once
  r := pg_temp.push('driver.payout', jsonb_build_object('id', v_pay, 'driver_id', v_drv, 'order_ids', jsonb_build_array(v_a, v_b, v_c), 'cash_order_ids', jsonb_build_array(v_a, v_c), 'currency', 'usd', 'amount', 300, 'rate', 90000, 'from_drawer', false));
  assert r->>'status' = 'ok' and (r->>'cash_cents')::int = 1300 and (r->>'amount_cents')::int = 300 and (r->>'cash_orders')::int = 2, 'settle: ' || r;
  assert (select cash_cents from suqa.driver_payouts where id = v_pay) = 1300, 'settlement row';
  -- the same orders again in a new settlement: nothing left of A and C; B's cash is still open
  r := pg_temp.push('driver.payout', jsonb_build_object('id', gen_random_uuid(), 'driver_id', v_drv, 'order_ids', jsonb_build_array(v_a), 'cash_order_ids', jsonb_build_array(v_a, v_c), 'currency', 'usd', 'amount', 0, 'rate', 90000));
  assert r->>'error' = 'nothing_to_pay', 'not twice: ' || r;
  -- a settled amount can no longer be corrected
  r := pg_temp.push('order.driver_cash', jsonb_build_object('id', v_a, 'cents', 100)); assert r->>'error' = 'already_settled', 'locked: ' || r;
  b := t_dc.balance(v_drv);
  assert (b->>'cash_cents')::int = 800 and (b->>'owed_cents')::int = 0 and jsonb_array_length(b->'open') = 1 and jsonb_array_length(b->'settlements') = 1 and (b->'settlements'->0->>'net_cents')::int = 1000 and jsonb_array_length(b->'settled') = 2, 'after settlement: ' || b;
  r := pg_temp.push('driver.payout', jsonb_build_object('id', gen_random_uuid(), 'driver_id', v_drv, 'cash_order_ids', jsonb_build_array(v_b), 'currency', 'usd', 'amount', 0, 'rate', 90000));
  assert r->>'status' = 'ok' and (r->>'cash_cents')::int = 800 and (r->>'orders')::int = 0, 'cash only: ' || r;
  b := t_dc.balance(v_drv); assert (b->>'cash_cents')::int = 0 and (b->>'net_cents')::int = 0, 'all square: ' || b;
  -- every customer's money exists once
  assert (select sum(amount) from suqa.payments where order_id in (v_a, v_b, v_c)) = 2100, 'payments total';
  -- a till that was offline takes the cash itself on an order the driver already closed: counted once, in the drawer
  declare v_d uuid := gen_random_uuid();
  begin
    r := pg_temp.push('sale.commit', jsonb_build_object('id', v_d, 'local_number', 'D-000009', 'channel', 'whatsapp', 'status', 'accepted', 'rate_lbp_per_usd', 90000, 'customer_name', 'C9', 'customer_phone', '70111229', 'fulfillment', 'delivery',
          'delivery_fee_cents', 200, 'subtotal_cents', 600, 'total_cents', 800, 'total_lbp', 720000, 'placed_at', now(),
          'lines', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'product_id', v_prod, 'name', '{"en":"x"}'::jsonb, 'qty', 2, 'unit_price_cents', 300, 'line_total_cents', 600))));
    r := pg_temp.push('order.status', jsonb_build_object('id', v_d, 'status', 'accepted', 'driver_id', v_drv));
    r := t_dc.step(v_d, 'delivered', true);
    r := pg_temp.push('order.pay', jsonb_build_object('id', v_d, 'status', 'delivered', 'paid_usd_cents', 800, 'payments', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'tender', 'cash_usd', 'amount', 800, 'currency', 'usd'))));
    assert r->>'status' = 'ok', 'late till payment: ' || r;
    assert (select amount from suqa.payments where order_id = v_d and tender = 'driver') = 0 and (select sum(amount) from suqa.payments where order_id = v_d) = 800, 'counted once';
    b := t_dc.balance(v_drv); assert (b->>'cash_cents')::int = 0, 'driver holds nothing for it: ' || (b->>'cash_cents');
  end;
  raise notice 'driver cash: all checks passed';
end $$;

-- a cashier cannot correct the driver's cash
set local request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
do $$ declare r jsonb; begin
  r := pg_temp.push('order.driver_cash', jsonb_build_object('id', gen_random_uuid(), 'cents', 0));
  assert r->>'error' = 'owner_only', 'cashier: ' || r; raise notice 'cashier blocked';
end $$;
rollback;
