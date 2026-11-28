-- 129: the till takes the money of an order saved as debt — the debt is paid, not doubled.
-- One transaction on a database built from all.sql + pos_smoke fixtures; pg_net is a stub.
\set ON_ERROR_STOP on
begin;
create schema if not exists net;
create sequence if not exists net.req_seq;
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 1000)
returns bigint language sql as $$ select nextval('net.req_seq') $$;
grant usage on schema net to authenticated; grant all on all sequences in schema net to authenticated;
\i supabase/schema/129_order_pay_debt.sql
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
declare r jsonb; v uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()]; v_p uuid; v_op uuid;
        v_shop uuid := (select id from suqa.shops where slug = 'abou-elie');
        v_prod uuid := (select id from suqa.products where shop_id = (select id from suqa.shops where slug = 'abou-elie') limit 1);
        v_base bigint;
begin
  v_base := t_dc.debt(v_shop, '70444001');
  for i in 1..5 loop     -- five pickup orders of $8.00; 1–4 saved as debt at the till, 5 with no payment
    r := pg_temp.push('sale.commit', jsonb_build_object('id', v[i], 'local_number', 'D-00000' || i, 'channel', 'whatsapp', 'status', 'accepted', 'rate_lbp_per_usd', 90000,
          'customer_name', 'Debtor', 'customer_phone', '7044400' || i, 'fulfillment', 'pickup', 'subtotal_cents', 800, 'total_cents', 800, 'total_lbp', 720000, 'placed_at', now(),
          'lines', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'product_id', v_prod, 'name', '{"en":"x"}'::jsonb, 'qty', 2, 'unit_price_cents', 400, 'line_total_cents', 800)),
          'payments', case when i < 5 then jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'tender', 'unpaid', 'amount', 800, 'currency', 'usd', 'unpaid_name', 'Debtor', 'unpaid_phone', '7044400' || i)) else '[]'::jsonb end));
    assert r->>'status' = 'ok', 'order: ' || r;
  end loop;
  assert t_dc.debt(v_shop, '70444001') = 800, 'saved as debt: ' || t_dc.debt(v_shop, '70444001');

  -- 1: paid in full in cash at handover → the debt is gone; the same operation sent twice changes nothing more
  v_p := gen_random_uuid(); v_op := gen_random_uuid();
  r := pg_temp.push('order.pay', jsonb_build_object('id', v[1], 'status', 'delivered', 'paid_usd_cents', 800, 'payments', jsonb_build_array(jsonb_build_object('id', v_p, 'tender', 'cash_usd', 'amount', 800, 'currency', 'usd'))), v_op);
  assert r->>'status' = 'ok', '1 pay: ' || r;
  assert t_dc.debt(v_shop, '70444001') = 0, '1 debt gone, got ' || t_dc.debt(v_shop, '70444001');
  assert (select status from suqa.orders where id = v[1]) = 'delivered';
  r := pg_temp.push('order.pay', jsonb_build_object('id', v[1], 'status', 'delivered', 'paid_usd_cents', 800, 'payments', jsonb_build_array(jsonb_build_object('id', v_p, 'tender', 'cash_usd', 'amount', 800, 'currency', 'usd'))));
  assert (select count(*) from suqa.payments where order_id = v[1]) = 2 and t_dc.debt(v_shop, '70444001') = 0, '1 sent twice';

  -- 2: $10 given, $2 change, in lira notes → the debt is gone (not more than the order)
  r := pg_temp.push('order.pay', jsonb_build_object('id', v[2], 'status', 'delivered', 'paid_lbp', 900000, 'change_lbp', 180000, 'payments', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'tender', 'cash_lbp', 'amount', 900000, 'currency', 'lbp'))));
  assert r->>'status' = 'ok' and t_dc.debt(v_shop, '70444002') = 0, '2: ' || r || ' debt ' || t_dc.debt(v_shop, '70444002');

  -- 3: $5 by card, the rest still not paid → debt $3, one debt only
  r := pg_temp.push('order.pay', jsonb_build_object('id', v[3], 'status', 'delivered', 'paid_usd_cents', 500, 'payments', jsonb_build_array(
        jsonb_build_object('id', gen_random_uuid(), 'tender', 'card', 'amount', 500, 'currency', 'usd'),
        jsonb_build_object('id', gen_random_uuid(), 'tender', 'unpaid', 'amount', 300, 'currency', 'usd', 'unpaid_name', 'Debtor', 'unpaid_phone', '70444003'))));
  assert r->>'status' = 'ok' and t_dc.debt(v_shop, '70444003') = 300, '3 debt: ' || t_dc.debt(v_shop, '70444003');

  -- 4: handed over still not paid (debt again) → the debt stays $8, not $16
  r := pg_temp.push('order.pay', jsonb_build_object('id', v[4], 'status', 'delivered', 'payments', jsonb_build_array(
        jsonb_build_object('id', gen_random_uuid(), 'tender', 'unpaid', 'amount', 800, 'currency', 'usd', 'unpaid_name', 'Debtor', 'unpaid_phone', '70444004'))));
  assert r->>'status' = 'ok' and t_dc.debt(v_shop, '70444004') = 800, '4 debt: ' || t_dc.debt(v_shop, '70444004');

  -- 5: no debt on the order → exactly as before: cash is cash, debt is debt
  r := pg_temp.push('order.pay', jsonb_build_object('id', v[5], 'status', 'delivered', 'paid_usd_cents', 300, 'payments', jsonb_build_array(
        jsonb_build_object('id', gen_random_uuid(), 'tender', 'cash_usd', 'amount', 300, 'currency', 'usd'),
        jsonb_build_object('id', gen_random_uuid(), 'tender', 'unpaid', 'amount', 500, 'currency', 'usd', 'unpaid_name', 'Debtor', 'unpaid_phone', '70444005'))));
  assert r->>'status' = 'ok' and t_dc.debt(v_shop, '70444005') = 500, '5 debt: ' || t_dc.debt(v_shop, '70444005');
  assert (select count(*) from suqa.payments where order_id = v[5]) = 2, '5 rows';
  raise notice 'order pay debt ok';
end $$;
rollback;
