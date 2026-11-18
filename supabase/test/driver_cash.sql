-- 81: the driver's final "delivered" with the payment he recorded, the cash he holds, the settlement.
-- One transaction on a database built from all.sql + pos_smoke fixtures; pg_net is a stub.
\set ON_ERROR_STOP on
begin;
create schema if not exists net;
create sequence if not exists net.req_seq;
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 1000)
returns bigint language sql as $$ select nextval('net.req_seq') $$;
grant usage on schema net to authenticated; grant all on all sequences in schema net to authenticated;
\i supabase/schema/81_driver_confirm_cash.sql
create schema if not exists t_dc; grant usage on schema t_dc to authenticated;
-- the driver's pages call these with the service key: here, as the table owner
create or replace function t_dc.step(p uuid, s text, pay jsonb default null) returns jsonb language plpgsql security definer as $$
begin return suqa.driver_step(p, s, pay); exception when others then return jsonb_build_object('ok', false, 'error', sqlerrm); end $$;
create or replace function t_dc.balance(p uuid) returns jsonb language sql security definer as $$ select suqa.driver_balance(p) $$;
create or replace function t_dc.info(p uuid) returns jsonb language sql security definer as $$ select suqa.driver_pay_info(p) $$;
create or replace function t_dc.limit_of(p_shop uuid, p_phone text, p_cents int) returns void language sql security definer as $$
  update suqa.shop_customers set credit_limit_cents = p_cents where shop_id = p_shop and phone_key = suqa._phone_key(p_phone) $$;
grant execute on all functions in schema t_dc to authenticated;

set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';   -- shop owner
create or replace function pg_temp.push(p_kind text, p_payload jsonb, p_op uuid default gen_random_uuid()) returns jsonb language sql as $$
  select suqa.pos_push('0193a000-0000-7000-8000-000000000001', jsonb_build_array(jsonb_build_object('op_id', p_op, 'kind', p_kind, 'payload', p_payload)))->'results'->0 $$;

do $$
declare r jsonb; b jsonb; o suqa.orders; v uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
        v_drv uuid := gen_random_uuid(); v_pay uuid := gen_random_uuid();
        v_shop uuid := (select id from suqa.shops where slug = 'abou-elie');
        v_prod uuid := (select id from suqa.products where shop_id = (select id from suqa.shops where slug = 'abou-elie') limit 1);
begin
  r := pg_temp.push('driver.upsert', jsonb_build_object('id', v_drv, 'name', 'Tony', 'phone', '70999888'));
  perform suqa.pos_set_driver_pay(v_shop, null, 'per_delivery', 100);     -- $1.00 per delivery
  -- six delivery orders of $8.00 (6 + 2 fee) at 90,000, driver lined up. Orders 4-6 are one customer (for the debt checks).
  for i in 1..6 loop
    r := pg_temp.push('sale.commit', jsonb_build_object('id', v[i], 'local_number', 'D-00000' || i, 'channel', 'whatsapp', 'status', 'accepted', 'rate_lbp_per_usd', 90000,
          'customer_name', 'C' || least(i, 4), 'customer_phone', '7011122' || least(i, 4), 'fulfillment', 'delivery', 'address', '{"line1":"x"}'::jsonb, 'delivery_fee_cents', 200,
          'subtotal_cents', 600, 'total_cents', 800, 'total_lbp', 720000, 'placed_at', now(),
          'lines', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'product_id', v_prod, 'name', '{"en":"x"}'::jsonb, 'qty', 2, 'unit_price_cents', 300, 'line_total_cents', 600))));
    assert r->>'status' = 'ok', 'order: ' || r;
    r := pg_temp.push('order.status', jsonb_build_object('id', v[i], 'status', 'accepted', 'driver_id', v_drv));
  end loop;

  -- on the road; the pay screen's numbers
  r := t_dc.step(v[1], 'picked'); assert r->>'ok' = 'true', 'picked: ' || r;
  b := t_dc.info(v[1]); assert (b->>'due_cents')::int = 800 and (b->>'rate')::int = 90000 and b->>'can_debt' = 'true' and b->>'credit_limit_cents' is null, 'info: ' || b;
  b := t_dc.balance(v_drv); assert (b->>'cash_cents')::int = 0 and jsonb_array_length(b->'on_road') = 6, 'before: ' || b;

  -- it must be covered: nothing, too little, far too much
  r := t_dc.step(v[1], 'delivered');                                 assert r->>'error' = 'pay_required', 'no pay: ' || r;
  r := t_dc.step(v[1], 'delivered', '{"usd":500}');                  assert r->>'error' = 'not_covered', 'short: ' || r;
  r := t_dc.step(v[1], 'delivered', '{"usd":2000}');                 assert r->>'error' = 'too_much', 'change missing: ' || r;
  r := t_dc.step(v[1], 'delivered', '{"usd":500,"change_usd":900}'); assert r->>'error' = 'bad_amount', 'gives back more than he took: ' || r;
  select * into o from suqa.orders where id = v[1]; assert o.status = 'out_for_delivery' and (select count(*) from suqa.payments where order_id = v[1]) = 0, 'nothing happened';

  -- 1: a $20 note, $12 change → delivered, $8.00 with the driver
  r := t_dc.step(v[1], 'delivered', '{"usd":2000,"change_usd":1200}');
  assert r->>'ok' = 'true' and (r->>'cash_usd_cents')::int = 800, '1 delivered: ' || r;
  select * into o from suqa.orders where id = v[1];
  assert o.status = 'delivered' and o.delivered_at is not null and o.paid_usd_cents = 800 and o.courier_fee_cents = 100 and o.shift_id is null, '1 row: ' || o.status || ' ' || o.paid_usd_cents;
  assert (select count(*) from suqa.payments where order_id = v[1] and tender = 'driver' and currency = 'usd' and amount = 800 and settled_at is null) = 1, '1 payment with the driver';
  r := t_dc.step(v[1], 'delivered', '{"usd":800}'); assert r->>'already' = 'true', 'second tap: ' || r;      -- double click / back button
  assert (select count(*) from suqa.payments where order_id = v[1]) = 1, 'no second payment';

  -- 2: a $10 note, change in lira (2 × 90,000 = 180,000) → he holds +$10.00 and −180,000 L.L.
  r := t_dc.step(v[2], 'delivered', '{"usd":1000,"change_lbp":180000}'); assert r->>'ok' = 'true', '2: ' || r;
  assert (select amount from suqa.payments where order_id = v[2] and tender = 'driver' and currency = 'lbp') = -180000, '2 lira change';
  -- 3: all in lira, 720,000, straight from the shop (he skipped "picked")
  r := t_dc.step(v[3], 'delivered', '{"lbp":720000}'); assert r->>'ok' = 'true', '3: ' || r;
  select * into o from suqa.orders where id = v[3]; assert o.status = 'delivered' and o.driver_picked_at is not null and o.paid_lbp = 720000, '3 delivered';
  -- 4: $5 cash + $3 Whish → the Whish is the shop's, not his
  r := t_dc.step(v[4], 'delivered', '{"usd":500,"wallet":300}'); assert r->>'ok' = 'true', '4: ' || r;
  assert (select amount from suqa.payments where order_id = v[4] and tender = 'wallet') = 300 and (select amount from suqa.payments where order_id = v[4] and tender = 'driver') = 500, '4 split';
  -- 5: nothing paid → debt on the customer, like at the till
  r := t_dc.step(v[5], 'delivered', '{"unpaid":800}'); assert r->>'ok' = 'true', '5: ' || r;
  assert (select count(*) from suqa.payments where order_id = v[5] and tender = 'unpaid' and amount = 800 and unpaid_phone = '70111224') = 1 and (select count(*) from suqa.payments where order_id = v[5] and tender = 'driver') = 0, '5 debt';
  select * into o from suqa.orders where id = v[5]; assert o.status = 'delivered' and coalesce(o.paid_usd_cents, 0) = 0, '5 delivered unpaid';
  -- 6: same customer, credit limit $10.00, already owes $8.00 → $8.00 more is refused, $2.00 with $6.00 cash passes
  perform t_dc.limit_of(v_shop, '70111224', 1000);
  b := t_dc.info(v[6]); assert (b->>'credit_limit_cents')::int = 1000 and (b->>'debt_cents')::int = 800, 'credit info: ' || b;
  r := t_dc.step(v[6], 'delivered', '{"unpaid":800}'); assert r->>'error' = 'over_credit_limit', '6 over the limit: ' || r;
  r := t_dc.step(v[6], 'delivered', '{"usd":600,"unpaid":200}'); assert r->>'ok' = 'true', '6: ' || r;

  -- what he holds: dollars 8 + 10 + 5 + 6 = 29.00, lira 720,000 − 180,000 = 540,000 (= $6.00) → value $35.00; pay owed 6 × $1
  b := t_dc.balance(v_drv);
  assert (b->>'cash_usd_cents')::int = 2900 and (b->>'cash_lbp')::int = 540000 and (b->>'cash_cents')::int = 3500 and (b->>'owed_cents')::int = 600 and (b->>'net_cents')::int = 2900
     and jsonb_array_length(b->'on_road') = 0 and jsonb_array_length(b->'open') = 6, 'balance: ' || b;
  r := suqa.pos_driver_report(v_shop, current_date - 1, current_date + 1);
  assert (r->'drivers'->0->>'cash_usd_cents')::int = 2900 and (r->'drivers'->0->>'cash_lbp')::int = 540000 and (r->'drivers'->0->>'cash_cents')::int = 3500 and (r->'drivers'->0->>'owed_cents')::int = 600 and (r->'drivers'->0->>'holding_cents')::int = 0, 'report: ' || (r->'drivers'->0);
  -- every order is covered exactly once: cash + Whish + debt = 6 × $8.00
  assert (select sum(case when p.currency = 'lbp' then round(p.amount * 100.0 / 90000) else p.amount end) from suqa.payments p where p.order_id = any(v)) = 4800, 'all covered once';

  -- the owner corrects order 4: he really took $4.00 — and not more than the order leaves room for
  r := pg_temp.push('order.driver_cash', jsonb_build_object('id', v[4], 'usd_cents', 900, 'lbp', 0)); assert r->>'error' = 'more_than_due', 'too much: ' || r;
  r := pg_temp.push('order.driver_cash', jsonb_build_object('id', v[4], 'usd_cents', 400, 'lbp', 0)); assert r->>'status' = 'ok', 'correct: ' || r;
  select * into o from suqa.orders where id = v[4]; assert o.paid_usd_cents = 700, '4 paid 4 + 3: ' || o.paid_usd_cents;
  -- … and on order 3 it was $2.00 and 540,000
  r := pg_temp.push('order.driver_cash', jsonb_build_object('id', v[3], 'usd_cents', 200, 'lbp', 540000)); assert r->>'status' = 'ok', '3 corrected: ' || r;
  b := t_dc.balance(v_drv); assert (b->>'cash_usd_cents')::int = 3000 and (b->>'cash_lbp')::int = 360000, 'after corrections: ' || b;

  -- settlement: the cash of 1-4 and the pay of all six, once
  r := pg_temp.push('driver.payout', jsonb_build_object('id', v_pay, 'driver_id', v_drv, 'order_ids', to_jsonb(v), 'cash_order_ids', to_jsonb(v[1:4]), 'currency', 'usd', 'amount', 600, 'rate', 90000, 'from_drawer', false));
  assert r->>'status' = 'ok' and (r->>'cash_cents')::int = 2400 and (r->>'cash_lbp')::int = 360000 and (r->>'amount_cents')::int = 600 and (r->>'cash_orders')::int = 4, 'settle: ' || r;
  assert (select cash_cents from suqa.driver_payouts where id = v_pay) = 2400 and (select cash_lbp from suqa.driver_payouts where id = v_pay) = 360000, 'settlement row';
  r := pg_temp.push('driver.payout', jsonb_build_object('id', gen_random_uuid(), 'driver_id', v_drv, 'order_ids', jsonb_build_array(v[1]), 'cash_order_ids', to_jsonb(v[1:4]), 'currency', 'usd', 'amount', 0, 'rate', 90000));
  assert r->>'error' = 'nothing_to_pay', 'not twice: ' || r;
  r := pg_temp.push('order.driver_cash', jsonb_build_object('id', v[1], 'usd_cents', 100, 'lbp', 0)); assert r->>'error' = 'already_settled', 'locked: ' || r;
  b := t_dc.balance(v_drv);
  assert (b->>'cash_usd_cents')::int = 600 and (b->>'cash_lbp')::int = 0 and (b->>'owed_cents')::int = 0 and jsonb_array_length(b->'open') = 1 and jsonb_array_length(b->'settlements') = 1 and jsonb_array_length(b->'settled') = 5, 'after settlement: ' || b;
  r := pg_temp.push('driver.payout', jsonb_build_object('id', gen_random_uuid(), 'driver_id', v_drv, 'cash_order_ids', jsonb_build_array(v[6]), 'currency', 'usd', 'amount', 0, 'rate', 90000));
  assert r->>'status' = 'ok' and (r->>'cash_cents')::int = 600 and (r->>'orders')::int = 0, 'cash only: ' || r;
  b := t_dc.balance(v_drv); assert (b->>'cash_cents')::int = 0 and (b->>'net_cents')::int = 0, 'all square: ' || b;

  -- a till that was offline takes the cash itself on an order the driver already closed: counted once, in the drawer
  declare v_d uuid := gen_random_uuid();
  begin
    r := pg_temp.push('sale.commit', jsonb_build_object('id', v_d, 'local_number', 'D-000009', 'channel', 'whatsapp', 'status', 'accepted', 'rate_lbp_per_usd', 90000, 'customer_name', 'C9', 'customer_phone', '70111229', 'fulfillment', 'delivery',
          'delivery_fee_cents', 200, 'subtotal_cents', 600, 'total_cents', 800, 'total_lbp', 720000, 'placed_at', now(),
          'lines', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'product_id', v_prod, 'name', '{"en":"x"}'::jsonb, 'qty', 2, 'unit_price_cents', 300, 'line_total_cents', 600))));
    r := pg_temp.push('order.status', jsonb_build_object('id', v_d, 'status', 'accepted', 'driver_id', v_drv));
    r := t_dc.step(v_d, 'delivered', '{"usd":300,"lbp":450000}');
    assert r->>'ok' = 'true', 'mixed: ' || r;
    r := pg_temp.push('order.pay', jsonb_build_object('id', v_d, 'status', 'delivered', 'paid_usd_cents', 800, 'payments', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'tender', 'cash_usd', 'amount', 800, 'currency', 'usd'))));
    assert r->>'status' = 'ok', 'late till payment: ' || r;
    assert (select sum(amount) from suqa.payments where order_id = v_d and tender = 'driver') = 0 and (select sum(amount) from suqa.payments where order_id = v_d) = 800, 'counted once';
    b := t_dc.balance(v_drv); assert (b->>'cash_cents')::int = 0, 'driver holds nothing for it: ' || (b->>'cash_cents');
  end;
  raise notice 'driver cash: all checks passed';
end $$;

-- a cashier cannot correct the driver's cash
set local request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
do $$ declare r jsonb; begin
  r := pg_temp.push('order.driver_cash', jsonb_build_object('id', gen_random_uuid(), 'usd_cents', 0, 'lbp', 0));
  assert r->>'error' = 'owner_only', 'cashier: ' || r; raise notice 'cashier blocked';
end $$;
rollback;
