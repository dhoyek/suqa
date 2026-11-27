-- 127: a card payment on the driver's screen; who holds the money for each way of paying; the settlement that follows.
-- One transaction on a database built from all.sql + pos_smoke fixtures; pg_net is a stub.
\set ON_ERROR_STOP on
begin;
create schema if not exists net;
create sequence if not exists net.req_seq;
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 1000)
returns bigint language sql as $$ select nextval('net.req_seq') $$;
grant usage on schema net to authenticated; grant all on all sequences in schema net to authenticated;
\i supabase/schema/127_driver_pay_card.sql
create schema if not exists t_dc; grant usage on schema t_dc to authenticated;
-- the driver's pages call these with the service key: here, as the table owner
create or replace function t_dc.step(p uuid, s text, pay jsonb default null) returns jsonb language plpgsql security definer as $$
begin return suqa.driver_step(p, s, pay); exception when others then return jsonb_build_object('ok', false, 'error', sqlerrm); end $$;
create or replace function t_dc.balance(p uuid) returns jsonb language sql security definer as $$ select suqa.driver_balance(p) $$;
create or replace function t_dc.info(p uuid) returns jsonb language sql security definer as $$ select suqa.driver_pay_info(p) $$;
create or replace function t_dc.limit_of(p_shop uuid, p_phone text, p_cents int) returns void language sql security definer as $$
  update suqa.shop_customers set credit_limit_cents = p_cents where shop_id = p_shop and phone_key = suqa._phone_key(p_phone) $$;
create or replace function t_dc.debt(p_shop uuid, p_phone text) returns bigint language sql security definer as $$ select suqa._customer_debt_cents(p_shop, p_phone) $$;
grant execute on all functions in schema t_dc to authenticated;

set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';   -- shop owner
create or replace function pg_temp.push(p_kind text, p_payload jsonb, p_op uuid default gen_random_uuid()) returns jsonb language sql as $$
  select suqa.pos_push('0193a000-0000-7000-8000-000000000001', jsonb_build_array(jsonb_build_object('op_id', p_op, 'kind', p_kind, 'payload', p_payload)))->'results'->0 $$;

do $$
declare r jsonb; b jsonb; o suqa.orders; v uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
        v_drv uuid := gen_random_uuid(); v_pay uuid := gen_random_uuid();
        v_shop uuid := (select id from suqa.shops where slug = 'abou-elie');
        v_prod uuid := (select id from suqa.products where shop_id = (select id from suqa.shops where slug = 'abou-elie') limit 1);
begin
  r := pg_temp.push('driver.upsert', jsonb_build_object('id', v_drv, 'name', 'Tony', 'phone', '70999777'));
  perform suqa.pos_set_driver_pay(v_shop, null, 'per_delivery', 100);     -- $1.00 per delivery
  for i in 1..5 loop     -- five delivery orders of $8.00
    r := pg_temp.push('sale.commit', jsonb_build_object('id', v[i], 'local_number', 'K-00000' || i, 'channel', 'whatsapp', 'status', 'accepted', 'rate_lbp_per_usd', 90000,
          'customer_name', 'K' || i, 'customer_phone', '7033344' || i, 'fulfillment', 'delivery', 'address', '{"line1":"x"}'::jsonb, 'delivery_fee_cents', 200,
          'subtotal_cents', 600, 'total_cents', 800, 'total_lbp', 720000, 'placed_at', now(),
          'lines', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'product_id', v_prod, 'name', '{"en":"x"}'::jsonb, 'qty', 2, 'unit_price_cents', 300, 'line_total_cents', 600))));
    assert r->>'status' = 'ok', 'order: ' || r;
    r := pg_temp.push('order.status', jsonb_build_object('id', v[i], 'status', 'accepted', 'driver_id', v_drv));
    r := t_dc.step(v[i], 'picked'); assert r->>'ok' = 'true', 'picked: ' || r;
  end loop;
  b := t_dc.info(v[1]); assert b->>'card_ok' = 'true' and (b->>'due_cents')::int = 800, 'info: ' || b;

  -- 1: all by card → delivered, paid, NOTHING with the driver
  r := t_dc.step(v[1], 'delivered', '{"card":500}');  assert r->>'error' = 'not_covered', 'card too little: ' || r;
  r := t_dc.step(v[1], 'delivered', '{"card":-800}'); assert r->>'error' = 'bad_amount', 'negative card: ' || r;
  r := t_dc.step(v[1], 'delivered', '{"card":800}');
  assert r->>'ok' = 'true' and (r->>'card_cents')::int = 800 and (r->>'cash_usd_cents')::int = 0, '1 card: ' || r;
  select * into o from suqa.orders where id = v[1];
  assert o.status = 'delivered' and o.paid_usd_cents = 800 and o.courier_fee_cents = 100, '1 row';
  assert (select count(*) from suqa.payments where order_id = v[1]) = 1 and (select count(*) from suqa.payments where order_id = v[1] and tender = 'card' and amount = 800 and currency = 'usd') = 1, '1 one card payment, no driver cash';
  r := t_dc.step(v[1], 'delivered', '{"card":800}'); assert r->>'already' = 'true' and (select count(*) from suqa.payments where order_id = v[1]) = 1, 'a second tap adds nothing: ' || r;
  -- 2: all by Whish · 3: not paid at all, debt · 4: $3 cash + $5 card · 5: all cash
  r := t_dc.step(v[2], 'delivered', '{"wallet":800}');           assert r->>'ok' = 'true', '2: ' || r;
  r := t_dc.step(v[3], 'delivered', '{"unpaid":800}');           assert r->>'ok' = 'true', '3: ' || r;
  r := t_dc.step(v[4], 'delivered', '{"usd":300,"card":500}');   assert r->>'ok' = 'true' and (r->>'cash_usd_cents')::int = 300, '4: ' || r;
  r := t_dc.step(v[5], 'delivered', '{"usd":800}');              assert r->>'ok' = 'true', '5: ' || r;
  assert (select paid_usd_cents from suqa.orders where id = v[4]) = 800, '4 paid in full';
  assert (select count(*) from suqa.payments where order_id = any(v[1:3]) and tender = 'driver') = 0, 'card, Whish, debt: the driver holds nothing';

  -- the driver's own page and the shop's report agree: he holds only the cash ($3 + $8); the shop owes him his pay for ALL five
  b := t_dc.balance(v_drv);
  assert (b->>'cash_cents')::int = 1100 and (b->>'owed_cents')::int = 500 and (b->>'net_cents')::int = 600, 'balance: ' || b;
  b := suqa.pos_driver_report(v_shop, current_date - 1, current_date + 1);
  assert (select (d->>'cash_cents')::int = 1100 and (d->>'owed_cents')::int = 500 and (d->>'cash_count')::int = 2 from jsonb_array_elements(b->'drivers') d where d->>'id' = v_drv::text), 'report';

  -- settle only the three deliveries where he holds nothing: the shop PAYS him $3.00, no cash changes hands
  r := pg_temp.push('driver.payout', jsonb_build_object('id', v_pay, 'driver_id', v_drv, 'order_ids', to_jsonb(v[1:3]), 'cash_order_ids', '[]'::jsonb, 'currency', 'usd', 'amount', 300, 'rate', 90000, 'from_drawer', false));
  assert r->>'status' = 'ok', 'payout: ' || r;
  assert (select amount_cents = 300 and cash_cents = 0 and cash_lbp = 0 and orders_count = 3 from suqa.driver_payouts where id = v_pay), 'the shop pays his three fees, takes no cash';
  b := t_dc.balance(v_drv); assert (b->>'cash_cents')::int = 1100 and (b->>'owed_cents')::int = 200, 'after: ' || b;
  -- the same deliveries cannot be paid twice
  r := pg_temp.push('driver.payout', jsonb_build_object('id', gen_random_uuid(), 'driver_id', v_drv, 'order_ids', to_jsonb(v[1:3]), 'currency', 'usd', 'amount', 300, 'rate', 90000));
  assert r->>'status' <> 'ok' or (r->'result'->>'orders')::int = 0, 'paid once: ' || r;
  assert (select count(*) from suqa.orders where id = any(v[1:3]) and driver_payout_id = v_pay) = 3, 'still the first settlement';
  -- an order that already carries a debt line (saved "unpaid" at the till before it went out)
  declare w uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid()]; v_before bigint;
  begin
    for i in 1..3 loop
      r := pg_temp.push('sale.commit', jsonb_build_object('id', w[i], 'local_number', 'K-10000' || i, 'channel', 'whatsapp', 'status', 'accepted', 'rate_lbp_per_usd', 90000,
            'customer_name', 'Debtor', 'customer_phone', '70555666', 'fulfillment', 'delivery', 'address', '{"line1":"x"}'::jsonb, 'delivery_fee_cents', 200,
            'subtotal_cents', 600, 'total_cents', 800, 'total_lbp', 720000, 'placed_at', now(),
            'payments', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'tender', 'unpaid', 'amount', 800, 'currency', 'usd', 'unpaid_name', 'Debtor', 'unpaid_phone', '70555666')),
            'lines', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'product_id', v_prod, 'name', '{"en":"x"}'::jsonb, 'qty', 2, 'unit_price_cents', 300, 'line_total_cents', 600))));
      assert r->>'status' = 'ok', 'debt order: ' || r;
      assert (select count(*) from suqa.payments where order_id = w[i] and tender = 'unpaid' and amount = 800) = 1, 'the till saved it as debt';
      r := pg_temp.push('order.status', jsonb_build_object('id', w[i], 'status', 'accepted', 'driver_id', v_drv));
      r := t_dc.step(w[i], 'picked'); assert r->>'ok' = 'true', 'picked: ' || r;
    end loop;
    v_before := (select d from t_dc.debt(v_shop, '70555666') d); assert v_before = 2400, 'three debts of $8: ' || v_before;
    assert (t_dc.info(w[1])->>'due_cents')::int = 800, 'a debt is still to collect';
    -- a: he pays it all by Whish → the debt of that order is gone, one payment, nothing owed twice
    r := t_dc.step(w[1], 'delivered', '{"wallet":800}'); assert r->>'ok' = 'true', 'a: ' || r;
    assert (select coalesce(sum(amount), 0) from suqa.payments where order_id = w[1] and tender = 'unpaid') = 0 and (select sum(amount) from suqa.payments where order_id = w[1] and tender = 'wallet') = 800, 'a: debt closed by the payment';
    assert (select d from t_dc.debt(v_shop, '70555666') d) = 1600, 'a: customer owes two orders now';
    -- b: still not paid → the same debt stays, no second one
    r := t_dc.step(w[2], 'delivered', '{"unpaid":800}'); assert r->>'ok' = 'true', 'b: ' || r;
    assert (select count(*) from suqa.payments where order_id = w[2]) = 1 and (select sum(amount) from suqa.payments where order_id = w[2] and tender = 'unpaid') = 800, 'b: one debt, not two';
    -- c: $3 cash, the rest stays debt → debt 5, cash 3 with the driver
    r := t_dc.step(w[3], 'delivered', '{"usd":300,"unpaid":500}'); assert r->>'ok' = 'true', 'c: ' || r;
    assert (select sum(amount) from suqa.payments where order_id = w[3] and tender = 'unpaid') = 500 and (select sum(amount) from suqa.payments where order_id = w[3] and tender = 'driver') = 300, 'c: debt reduced by the cash';
    assert (select d from t_dc.debt(v_shop, '70555666') d) = 1300, 'customer owes 8 + 5';
  end;
  raise notice 'driver pay card ok';
end $$;
rollback;
