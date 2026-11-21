-- 91: the owner cancels an order's payment (the old day stays as closed, today's drawer gives the money back), and a refund
-- counts in the shift it is given in. One transaction on a database built from all.sql + pos_smoke fixtures. Rolls back.
\set ON_ERROR_STOP on
begin;
create schema if not exists net;
create sequence if not exists net.req_seq;
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 1000)
returns bigint language sql as $$ select nextval('net.req_seq') $$;
grant usage on schema net to authenticated; grant all on all sequences in schema net to authenticated;
\i supabase/schema/90_op_cancel.sql
\i supabase/schema/91_order_pay_cancel.sql
create schema if not exists t_pc; grant usage on schema t_pc to authenticated;
create or replace function t_pc.audit(p_action text, p_id uuid) returns bigint language sql security definer as $$
  select max(id) from suqa.audit_log where action = p_action and coalesce(after->>'id', ref_id) = p_id::text $$;
create or replace function t_pc.try(p_shop uuid, p_audit bigint, p_shift uuid, p_reason text) returns text language plpgsql as $$
begin perform suqa.pos_op_cancel(p_shop, p_audit, p_shift, p_reason); return 'ok'; exception when others then return sqlerrm; end $$;
-- what a shift's drawer holds of one way of paying: a row counts in its own shift when it names one, else in its order's
create or replace function t_pc.in_shift(p_shift uuid, p_tender text) returns bigint language sql security definer as $$
  select coalesce(sum(p.amount), 0)::bigint from suqa.payments p join suqa.orders o on o.id = p.order_id where coalesce(p.shift_id, o.shift_id) = p_shift and p.tender = p_tender $$;
create or replace function t_pc.raw(p_sql text) returns void language plpgsql security definer as $$ begin execute p_sql; end $$;
grant execute on all functions in schema t_pc to authenticated;

set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';   -- shop owner
create or replace function pg_temp.push(p_kind text, p_payload jsonb, p_op uuid default gen_random_uuid()) returns jsonb language sql as $$
  select suqa.pos_push('0193a000-0000-7000-8000-000000000001', jsonb_build_array(jsonb_build_object('op_id', p_op, 'kind', p_kind, 'payload', p_payload)))->'results'->0 $$;
create or replace function pg_temp.new_order(p_id uuid, p_no text) returns jsonb language sql as $$
  select pg_temp.push('sale.commit', jsonb_build_object('id', p_id, 'local_number', p_no, 'channel', 'whatsapp', 'status', 'accepted', 'rate_lbp_per_usd', 90000,
    'customer_name', 'C', 'customer_phone', '70555111', 'fulfillment', 'pickup', 'subtotal_cents', 800, 'total_cents', 800, 'total_lbp', 720000, 'placed_at', now(),
    'lines', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'product_id', (select id from suqa.products where shop_id = (select id from suqa.shops where slug = 'abou-elie') limit 1), 'name', '{"en":"x"}'::jsonb, 'qty', 2, 'unit_price_cents', 400, 'line_total_cents', 800)))) $$;

do $$
declare r jsonb; x text;
        v_shop uuid := (select id from suqa.shops where slug = 'abou-elie');
        s1 uuid := gen_random_uuid(); s2 uuid := gen_random_uuid();
        a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid(); d uuid := gen_random_uuid(); e uuid := gen_random_uuid();
        pa uuid := gen_random_uuid(); pa2 uuid := gen_random_uuid(); pb uuid := gen_random_uuid(); pc uuid := gen_random_uuid(); pd uuid := gen_random_uuid(); pe uuid := gen_random_uuid();
        ret uuid := gen_random_uuid(); au bigint;
begin
  r := pg_temp.push('shift.open', jsonb_build_object('id', s1)); assert r->>'status' = 'ok', r::text;
  -- A: $8.00, paid with a $10 note, change 180,000 L.L. — in shift 1
  r := pg_temp.new_order(a, 'PC-1'); assert r->>'status' = 'ok', r::text;
  r := pg_temp.push('order.pay', jsonb_build_object('id', a, 'status', 'delivered', 'shift_id', s1, 'paid_usd_cents', 1000, 'paid_lbp', 0, 'change_usd_cents', 0, 'change_lbp', 180000,
        'payments', jsonb_build_array(jsonb_build_object('id', pa, 'tender', 'cash_usd', 'amount', 1000, 'currency', 'usd'))));
  assert r->>'status' = 'ok', r::text;
  -- B: on debt; C: on debt, part of it collected later; D: cash, then the driver's cash is on it; E: a cash sale returned later
  r := pg_temp.new_order(b, 'PC-2'); r := pg_temp.push('order.pay', jsonb_build_object('id', b, 'status', 'delivered', 'shift_id', s1, 'payments', jsonb_build_array(jsonb_build_object('id', pb, 'tender', 'unpaid', 'amount', 800, 'currency', 'usd', 'unpaid_name', 'C', 'unpaid_phone', '70555111'))));
  r := pg_temp.new_order(c, 'PC-3'); r := pg_temp.push('order.pay', jsonb_build_object('id', c, 'status', 'delivered', 'shift_id', s1, 'payments', jsonb_build_array(jsonb_build_object('id', pc, 'tender', 'unpaid', 'amount', 800, 'currency', 'usd', 'unpaid_name', 'C', 'unpaid_phone', '70555111'))));
  r := pg_temp.new_order(d, 'PC-4'); r := pg_temp.push('order.pay', jsonb_build_object('id', d, 'status', 'delivered', 'shift_id', s1, 'paid_usd_cents', 800, 'payments', jsonb_build_array(jsonb_build_object('id', pd, 'tender', 'cash_usd', 'amount', 800, 'currency', 'usd'))));
  r := pg_temp.new_order(e, 'PC-5'); r := pg_temp.push('order.pay', jsonb_build_object('id', e, 'status', 'delivered', 'shift_id', s1, 'paid_usd_cents', 800, 'payments', jsonb_build_array(jsonb_build_object('id', pe, 'tender', 'cash_usd', 'amount', 800, 'currency', 'usd'))));
  assert t_pc.in_shift(s1, 'cash_usd') = 2600 and (select count(*) from suqa.payments where shift_id is not null) = 0, 'before: rows follow their order';

  -- the day is closed and counted; a new one opens
  r := pg_temp.push('shift.close', jsonb_build_object('id', s1, 'counted_usd_cents', 2600, 'counted_lbp', -180000, 'expected_usd_cents', 2600, 'expected_lbp', -180000, 'diff_usd_cents', 0, 'diff_lbp', 0));
  assert t_pc.try(v_shop, t_pc.audit('order.pay', a), null, 'x') = 'no_open_shift', 'no drawer to give the money back from';
  assert t_pc.try(v_shop, t_pc.audit('order.pay', a), s1, 'x') = 'no_open_shift', 'a closed shift is not a drawer';
  r := pg_temp.push('shift.open', jsonb_build_object('id', s2)); assert r->>'status' = 'ok', r::text;

  -- A cancelled: yesterday keeps $10.00 in and 180,000 out; today gives $10.00 back and takes the 180,000 again
  r := suqa.pos_op_cancel(v_shop, t_pc.audit('order.pay', a), s2, 'wrong way of paying'); assert r->>'ok' = 'true' and (r->'result'->>'reversed')::int = 2, r::text;
  assert t_pc.in_shift(s1, 'cash_usd') = 2600 and t_pc.in_shift(s1, 'cash_lbp') = -180000, 'the closed day is untouched: ' || t_pc.in_shift(s1, 'cash_usd') || ' / ' || t_pc.in_shift(s1, 'cash_lbp');
  assert t_pc.in_shift(s2, 'cash_usd') = -1000 and t_pc.in_shift(s2, 'cash_lbp') = 180000, 'today''s drawer: ' || t_pc.in_shift(s2, 'cash_usd') || ' / ' || t_pc.in_shift(s2, 'cash_lbp');
  assert not exists (select 1 from suqa.payments where order_id = a group by tender, currency having sum(amount) <> 0), 'the order''s payments add up to zero';
  assert (select paid_usd_cents = 0 and paid_lbp = 0 and change_usd_cents = 0 and change_lbp = 0 and status = 'delivered' and shift_id = s1 from suqa.orders where id = a), 'not paid, still delivered';
  r := suqa.pos_op_cancel(v_shop, t_pc.audit('order.pay', a), s2, 'again'); assert r->>'replayed' = 'true', r::text;
  assert (select count(*) from suqa.payments where order_id = a) = 4, 'once: the payment, its change, and the two opposite rows';

  -- paid again today, by Whish: the order moves to today's shift, yesterday still keeps what it had
  r := pg_temp.push('order.pay', jsonb_build_object('id', a, 'status', 'delivered', 'shift_id', s2, 'paid_usd_cents', 800, 'paid_lbp', 0, 'change_usd_cents', 0, 'change_lbp', 0,
        'payments', jsonb_build_array(jsonb_build_object('id', pa2, 'tender', 'wallet', 'amount', 800, 'currency', 'usd'))));
  assert r->>'status' = 'ok', r::text;
  assert (select shift_id from suqa.orders where id = a) = s2;
  assert t_pc.in_shift(s1, 'cash_usd') = 2600 and t_pc.in_shift(s1, 'cash_lbp') = -180000, 'paid again: the closed day is still untouched';
  assert t_pc.in_shift(s2, 'cash_usd') = -1000 and t_pc.in_shift(s2, 'cash_lbp') = 180000 and t_pc.in_shift(s2, 'wallet') = 800, 'today: cash back out, Whish in';
  -- and that second payment can be cancelled too (it is another payment, not "the order")
  au := (select max(id) from suqa.audit_log where action = 'order.pay' and after->>'id' = a::text);
  r := suqa.pos_op_cancel(v_shop, au, s2, 'again wrong'); assert r->>'ok' = 'true' and r->>'replayed' is null, r::text;
  assert t_pc.in_shift(s2, 'wallet') = 0 and not exists (select 1 from suqa.payments where order_id = a group by tender, currency having sum(amount) <> 0), 'second payment reversed';

  -- B: a debt written by the payment just goes
  r := suqa.pos_op_cancel(v_shop, t_pc.audit('order.pay', b), s2, 'not on debt'); assert r->>'ok' = 'true' and (r->'result'->>'debts_removed')::int = 1 and (r->'result'->>'reversed')::int = 0, r::text;
  assert not exists (select 1 from suqa.payments where order_id = b), 'no debt left on B';

  -- refused, with nothing written: debt partly collected, driver's cash on the order, a return made, other payments
  perform t_pc.raw(format('insert into suqa.debt_settlements (id, shop_id, tenant_id, phone, tender, currency, amount, amount_cents, rate) select gen_random_uuid(), %L, tenant_id, ''70555111'', ''cash_usd'', ''usd'', 300, 300, 90000 from suqa.shops where id = %L', v_shop, v_shop));
  perform t_pc.raw(format('insert into suqa.debt_allocations (id, settlement_id, shop_id, tenant_id, order_id, amount_cents) select gen_random_uuid(), s.id, s.shop_id, s.tenant_id, %L, 300 from suqa.debt_settlements s where s.shop_id = %L order by s.at desc limit 1', c, v_shop));
  assert t_pc.try(v_shop, t_pc.audit('order.pay', c), s2, 'x') = 'debt_collected';
  perform t_pc.raw(format('insert into suqa.payments (id, order_id, shop_id, tenant_id, tender, amount, currency) select gen_random_uuid(), id, shop_id, tenant_id, ''driver'', 0, ''usd'' from suqa.orders where id = %L', d));
  assert t_pc.try(v_shop, t_pc.audit('order.pay', d), s2, 'x') = 'has_driver_cash';
  assert (select count(*) from suqa.payments where order_id in (c, d) and (note like 'cancel%' or note = 'change')) = 0 and (select count(*) from suqa.payments where order_id = c) = 1, 'a refused cancel writes nothing';

  -- E: a return today on a sale of the closed day — the refund leaves TODAY's drawer
  r := pg_temp.push('return.commit', jsonb_build_object('id', ret, 'order_id', e, 'lines', '[]'::jsonb, 'refund_usd_cents', 300, 'refund_lbp', 0, 'reason', 'test', 'shift_id', s2));
  assert r->>'status' = 'ok', r::text;
  assert (select shift_id from suqa.payments where order_id = e and note = 'refund ' || ret) = s2, 'the refund row names today''s shift';
  assert t_pc.in_shift(s1, 'cash_usd') = 2600, 'the closed day keeps the sale';
  r := pg_temp.push('return.commit', jsonb_build_object('id', gen_random_uuid(), 'order_id', e, 'lines', '[]'::jsonb, 'refund_usd_cents', 100, 'refund_lbp', 0, 'reason', 'test', 'shift_id', s1));
  assert (select count(*) from suqa.payments where order_id = e and amount = -100 and shift_id is null) = 1, 'a closed shift is not named: the row follows its order, as before';
  assert t_pc.try(v_shop, t_pc.audit('order.pay', e), s2, 'x') = 'has_return';

  raise notice 'order_pay_cancel: all checks passed';
end $$;
rollback;
