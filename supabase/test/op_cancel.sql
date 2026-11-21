-- 90: operations log step 2 — the owner cancels a manual cash move, a stock change, a supplier payment and a driver settlement.
-- One transaction on a database built from all.sql + pos_smoke fixtures; pg_net is a stub. Rolls back.
\set ON_ERROR_STOP on
begin;
create schema if not exists net;
create sequence if not exists net.req_seq;
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 1000)
returns bigint language sql as $$ select nextval('net.req_seq') $$;
grant usage on schema net to authenticated; grant all on all sequences in schema net to authenticated;
\i supabase/schema/90_op_cancel.sql
create schema if not exists t_oc; grant usage on schema t_oc to authenticated;
create or replace function t_oc.step(p uuid, s text, pay jsonb default null) returns jsonb language plpgsql security definer as $$
begin return suqa.driver_step(p, s, pay); exception when others then return jsonb_build_object('ok', false, 'error', sqlerrm); end $$;
create or replace function t_oc.audit(p_action text, p_id uuid) returns bigint language sql security definer as $$
  select max(id) from suqa.audit_log where action = p_action and coalesce(after->>'id', ref_id) = p_id::text $$;
create or replace function t_oc.cancels() returns int language sql security definer as $$ select count(*)::int from suqa.op_cancels $$;
create or replace function t_oc.try(p_shop uuid, p_audit bigint, p_shift uuid, p_reason text) returns text language plpgsql as $$
begin perform suqa.pos_op_cancel(p_shop, p_audit, p_shift, p_reason); return 'ok'; exception when others then return sqlerrm; end $$;
grant execute on all functions in schema t_oc to authenticated;

set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';   -- shop owner
create or replace function pg_temp.push(p_kind text, p_payload jsonb, p_op uuid default gen_random_uuid()) returns jsonb language sql as $$
  select suqa.pos_push('0193a000-0000-7000-8000-000000000001', jsonb_build_array(jsonb_build_object('op_id', p_op, 'kind', p_kind, 'payload', p_payload)))->'results'->0 $$;

do $$
declare r jsonb; x text; n numeric; bal bigint;
        v_shop uuid := (select id from suqa.shops where slug = 'abou-elie');
        v_prod uuid := (select id from suqa.products where shop_id = (select id from suqa.shops where slug = 'abou-elie') and track_stock limit 1);
        s1 uuid := gen_random_uuid(); c1 uuid := gen_random_uuid(); c2 uuid := gen_random_uuid(); c3 uuid := gen_random_uuid(); m1 uuid := gen_random_uuid();
        sup uuid := gen_random_uuid(); p1 uuid := gen_random_uuid(); drv uuid := gen_random_uuid(); pay uuid := gen_random_uuid();
        v uuid[] := array[gen_random_uuid(), gen_random_uuid()];
begin
  r := pg_temp.push('shift.open', jsonb_build_object('id', s1, 'float_usd_cents', 10000)); assert r->>'status' = 'ok', 'shift: ' || r;
  r := pg_temp.push('cash.move', jsonb_build_object('id', c1, 'shift_id', s1, 'kind', 'in', 'amount', 5000, 'currency', 'usd', 'reason', 'change', 'source', 'manual')); assert r->>'status' = 'ok', r::text;
  r := pg_temp.push('cash.move', jsonb_build_object('id', c2, 'shift_id', s1, 'kind', 'out', 'amount', 700, 'currency', 'usd', 'reason', 'old till'));                    -- a till not updated yet: no mark
  r := pg_temp.push('cash.move', jsonb_build_object('id', c3, 'shift_id', s1, 'kind', 'in', 'amount', 900, 'currency', 'usd', 'reason', 'debt · X', 'source', 'debt', 'ref_id', gen_random_uuid()));
  r := pg_temp.push('cash.move', jsonb_build_object('id', gen_random_uuid(), 'shift_id', s1, 'kind', 'in', 'amount', 1, 'currency', 'usd', 'source', 'cancel'));        -- a till cannot claim 'cancel'
  assert (select source from suqa.cash_moves where id = c1) = 'manual' and (select source from suqa.cash_moves where id = c2) is null and not exists (select 1 from suqa.cash_moves where source = 'cancel'), 'marks';

  -- who and how
  assert t_oc.try(v_shop, t_oc.audit('cash.move', c1), s1, '  ') = 'reason_required';
  assert t_oc.try(v_shop, t_oc.audit('shift.open', s1), s1, 'x') = 'not_cancellable';
  assert t_oc.try(v_shop, -1, s1, 'x') = 'op_not_found';
  perform set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true);
  assert t_oc.try(v_shop, t_oc.audit('cash.move', c1), s1, 'x') = 'owner_only', 'someone else';
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

  -- cash: only a hand-made move, only with an open drawer, only once
  assert t_oc.try(v_shop, t_oc.audit('cash.move', c2), s1, 'x') = 'cash_move_unmarked';
  assert t_oc.try(v_shop, t_oc.audit('cash.move', c3), s1, 'x') = 'cash_move_belongs_to_operation';
  assert t_oc.try(v_shop, t_oc.audit('cash.move', c1), null, 'x') = 'no_open_shift';
  assert t_oc.cancels() = 0, 'a refused cancel leaves no trace';
  r := suqa.pos_op_cancel(v_shop, t_oc.audit('cash.move', c1), s1, 'mistake'); assert r->>'ok' = 'true' and r->'result'->>'kind' = 'out', r::text;
  assert (select count(*) from suqa.cash_moves where source = 'cancel' and ref_id = c1 and kind = 'out' and amount = 5000 and currency = 'usd' and shift_id = s1) = 1, 'the opposite move';
  r := suqa.pos_op_cancel(v_shop, t_oc.audit('cash.move', c1), s1, 'again'); assert r->>'replayed' = 'true', r::text;
  assert (select count(*) from suqa.cash_moves where ref_id = c1) = 1 and t_oc.cancels() = 1, 'cancelled once';

  -- stock: the quantity comes back
  select on_hand into n from suqa.products where id = v_prod;
  r := pg_temp.push('stock.move', jsonb_build_object('id', m1, 'product_id', v_prod, 'qty', 5, 'kind', 'receive')); assert r->>'status' = 'ok', r::text;
  assert (select on_hand from suqa.products where id = v_prod) = n + 5, 'received';
  r := suqa.pos_op_cancel(v_shop, t_oc.audit('stock.move', m1), null, 'test'); assert r->>'ok' = 'true', r::text;        -- no drawer involved: no shift needed
  assert (select on_hand from suqa.products where id = v_prod) = n, 'stock back';
  perform suqa.pos_op_cancel(v_shop, t_oc.audit('stock.move', m1), null, 'test');
  assert (select on_hand from suqa.products where id = v_prod) = n, 'not twice';

  -- supplier payment from the drawer: owed again, cash back in
  r := pg_temp.push('supplier.upsert', jsonb_build_object('id', sup, 'name', 'Sup')); assert r->>'status' = 'ok', r::text;
  select balance_cents into bal from suqa.suppliers where id = sup;
  r := pg_temp.push('supplier.pay', jsonb_build_object('id', p1, 'supplier_id', sup, 'tender', 'cash_usd', 'currency', 'usd', 'amount', 2000, 'amount_cents', 2000, 'rate', 90000, 'from_drawer', true, 'shift_id', s1));
  assert r->>'status' = 'ok', r::text; assert (select balance_cents from suqa.suppliers where id = sup) = bal - 2000;
  assert t_oc.try(v_shop, t_oc.audit('supplier.pay', p1), null, 'x') = 'no_open_shift';
  r := suqa.pos_op_cancel(v_shop, t_oc.audit('supplier.pay', p1), s1, 'wrong supplier'); assert r->>'ok' = 'true', r::text;
  assert (select balance_cents from suqa.suppliers where id = sup) = bal, 'owed again';
  assert (select count(*) from suqa.cash_moves where source = 'cancel' and ref_id = p1 and kind = 'in' and amount = 2000) = 1, 'cash back in the drawer';

  -- driver settlement: two deliveries of $8.00 he was paid in cash for, $1.00 pay each → he hands in 16.00, keeps 2.00: +14.00 in the drawer
  r := pg_temp.push('driver.upsert', jsonb_build_object('id', drv, 'name', 'Tony', 'phone', '70999777'));
  perform suqa.pos_set_driver_pay(v_shop, null, 'per_delivery', 100);
  for i in 1..2 loop
    r := pg_temp.push('sale.commit', jsonb_build_object('id', v[i], 'local_number', 'OC-0000' || i, 'channel', 'whatsapp', 'status', 'accepted', 'rate_lbp_per_usd', 90000,
          'customer_name', 'C', 'customer_phone', '7011100' || i, 'fulfillment', 'delivery', 'address', '{"line1":"x"}'::jsonb, 'delivery_fee_cents', 200,
          'subtotal_cents', 600, 'total_cents', 800, 'total_lbp', 720000, 'placed_at', now(),
          'lines', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'product_id', v_prod, 'name', '{"en":"x"}'::jsonb, 'qty', 2, 'unit_price_cents', 300, 'line_total_cents', 600))));
    assert r->>'status' = 'ok', 'order: ' || r;
    r := pg_temp.push('order.status', jsonb_build_object('id', v[i], 'status', 'accepted', 'driver_id', drv));
    r := t_oc.step(v[i], 'delivered', '{"usd":800}'); assert r->>'ok' = 'true', 'delivered: ' || r;
  end loop;
  r := pg_temp.push('driver.payout', jsonb_build_object('id', pay, 'driver_id', drv, 'order_ids', jsonb_build_array(v[1], v[2]), 'cash_order_ids', jsonb_build_array(v[1], v[2]),
        'currency', 'usd', 'amount', 200, 'rate', 90000, 'from_drawer', true, 'shift_id', s1));
  assert r->>'status' = 'ok', 'payout: ' || r;
  assert (select count(*) from suqa.orders where driver_payout_id = pay) = 2 and (select count(*) from suqa.payments where tender = 'driver' and reference = pay::text and settled_at is not null) = 2, 'settled';
  r := suqa.pos_op_cancel(v_shop, t_oc.audit('driver.payout', pay), s1, 'wrong driver'); assert r->>'ok' = 'true' and (r->'result'->>'orders')::int = 2 and (r->'result'->>'cash_payments')::int = 2, r::text;
  assert (select count(*) from suqa.orders where id = any(v) and driver_paid_at is null and driver_payout_id is null and status = 'delivered') = 2, 'his pay is unsettled again';
  assert (select count(*) from suqa.payments where order_id = any(v) and tender = 'driver' and settled_at is null and reference is null) = 2, 'the cash is with the driver again';
  assert not exists (select 1 from suqa.driver_payouts where id = pay), 'the settlement is gone';
  assert (select count(*) from suqa.cash_moves where source = 'cancel' and ref_id = pay and kind = 'out' and amount = 1400 and currency = 'usd') = 1, 'the drawer gives back 14.00';
  r := suqa.pos_op_cancel(v_shop, t_oc.audit('driver.payout', pay), s1, 'again'); assert r->>'replayed' = 'true';
  -- and he can be settled again, once
  r := pg_temp.push('driver.payout', jsonb_build_object('id', gen_random_uuid(), 'driver_id', drv, 'order_ids', jsonb_build_array(v[1], v[2]), 'cash_order_ids', jsonb_build_array(v[1], v[2]), 'currency', 'usd', 'amount', 200, 'rate', 90000, 'from_drawer', false));
  assert r->>'status' = 'ok' and (r->>'orders')::int = 2 and (r->>'cash_cents')::int = 1600, 'settled again: ' || r::text;

  assert t_oc.cancels() = 4, 'four cancels';
  assert (select count(*) from suqa.audit_log where shop_id = v_shop and action = 'op.cancel') = 4, 'each cancel is in the log';
  raise notice 'op_cancel: all checks passed';
end $$;
rollback;
