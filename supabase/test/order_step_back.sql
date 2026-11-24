-- 109: an order moved back to an earlier stage — what is allowed, what is refused, no message, no double stock, cashier approval. Rolls back.
\set ON_ERROR_STOP on
begin;
create schema if not exists net;
create sequence if not exists net.req_seq;
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 1000)
returns bigint language sql as $$ select nextval('net.req_seq') $$;
grant usage on schema net to authenticated; grant all on all sequences in schema net to authenticated;
insert into suqa.integration_config (key, value) values ('wa_events_url', 'http://test.local/e'), ('wa_events_secret', 'x') on conflict (key) do update set value = excluded.value;
create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated;
insert into ids values ('a', gen_random_uuid()), ('b', gen_random_uuid()), ('c', gen_random_uuid()), ('w', gen_random_uuid());
create temp table posts (n int); insert into posts values (0); grant all on posts to authenticated;

set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';   -- the shop owner
create or replace function pg_temp.push(p_kind text, p_payload jsonb) returns jsonb language sql as $$
  select suqa.pos_push('0193a000-0000-7000-8000-000000000001', jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'kind', p_kind, 'payload', p_payload)))->'results'->0 $$;
create or replace function pg_temp.st(kk text) returns text language sql as $$ select status::text from suqa.orders where id = (select v from ids where k = kk) $$;
create or replace function pg_temp.go(kk text, s text) returns jsonb language sql as $$ select pg_temp.push('order.status', jsonb_build_object('id', (select v from ids where k = kk), 'status', s)) $$;
create or replace function pg_temp.back(kk text, s text) returns jsonb language sql as $$ select pg_temp.push('order.back', jsonb_build_object('id', (select v from ids where k = kk), 'status', s)) $$;
do $$ declare r jsonb; kk text; v_prod uuid := (select id from suqa.products where shop_id = (select id from suqa.shops where slug = 'abou-elie') limit 1); n0 bigint; n1 bigint; ev int;
begin
  foreach kk in array array['a','b','c'] loop
    r := pg_temp.push('sale.commit', jsonb_build_object('id', (select v from ids where ids.k = kk), 'local_number', 'B-' || kk, 'channel', 'whatsapp', 'status', 'accepted', 'rate_lbp_per_usd', 90000,
          'customer_name', 'Cust', 'customer_phone', '70123123', 'fulfillment', case when kk = 'c' then 'pickup' else 'delivery' end, 'address', '{"line1":"x"}'::jsonb, 'subtotal_cents', 600, 'total_cents', 600, 'total_lbp', 540000, 'placed_at', now(),
          'lines', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'product_id', v_prod, 'name', '{"en":"x"}'::jsonb, 'qty', 2, 'unit_price_cents', 300, 'line_total_cents', 600))));
    assert r->>'status' = 'ok', 'order: ' || r;
  end loop;

  -- forward, then back one or several stages
  assert pg_temp.go('a', 'ready')->>'status' = 'ok' and pg_temp.st('a') = 'ready';
  assert pg_temp.go('a', 'preparing')->>'status' = 'rejected', 'the plain status change still refuses to go back';
  select count(*) into n0 from suqa.stock_moves where ref_order_id = (select v from ids where k = 'a');
  r := pg_temp.back('a', 'preparing'); assert r->>'status' = 'ok' and pg_temp.st('a') = 'preparing', 'ready → preparing: ' || r;
  r := pg_temp.back('a', 'preparing'); assert r->>'status' = 'ok' and (r->>'noop')::boolean, 'the same step twice is harmless: ' || r;
  assert pg_temp.go('a', 'out_for_delivery')->>'status' = 'ok';
  assert (select picked_up_at is not null from suqa.orders where id = (select v from ids where k = 'a'));
  r := pg_temp.back('a', 'accepted'); assert r->>'status' = 'ok' and pg_temp.st('a') = 'accepted', 'on the way → accepted: ' || r;
  assert (select picked_up_at is null from suqa.orders where id = (select v from ids where k = 'a')), 'the later stage''s time is cleared';
  select count(*) into n1 from suqa.stock_moves where ref_order_id = (select v from ids where k = 'a');
  assert n0 = n1, 'stock is not touched by a step back';
  select count(*) into ev from suqa.order_events where order_id = (select v from ids where k = 'a') and note = 'step back';
  assert ev = 2, 'both steps are in the order''s history: ' || ev;

  -- refused
  assert pg_temp.back('a', 'ready')->>'error' = 'not_a_step_back', 'forward is not a step back';
  assert pg_temp.back('a', 'pending')->>'error' = 'not_a_step_back', 'pending only for an online order';
  assert pg_temp.go('c', 'ready')->>'status' = 'ok';
  assert pg_temp.go('c', 'delivered')->>'status' = 'ok';
  assert pg_temp.back('c', 'out_for_delivery')->>'error' = 'not_a_step_back', 'a pickup is never on the way';
  assert pg_temp.go('b', 'cancelled')->>'status' = 'ok';
  assert pg_temp.back('b', 'accepted')->>'error' = 'order_closed', 'a cancelled order is not reopened';

  -- from delivered: fine with nothing paid; refused while a payment is on it
  r := pg_temp.back('c', 'ready'); assert r->>'status' = 'ok' and pg_temp.st('c') = 'ready', 'delivered → ready: ' || r;
  assert (select delivered_at is null and closed_at is null from suqa.orders where id = (select v from ids where k = 'c')), 'open again';
  r := pg_temp.push('order.pay', jsonb_build_object('id', (select v from ids where k = 'c'), 'status', 'delivered', 'payments', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'tender', 'cash_usd', 'amount', 600, 'currency', 'usd'))));
  assert r->>'status' = 'ok' and pg_temp.st('c') = 'delivered', 'paid and delivered again: ' || r;
  assert (select delivered_at is not null from suqa.orders where id = (select v from ids where k = 'c'));
  assert pg_temp.back('c', 'ready')->>'error' = 'has_payments', 'a paid order is not reopened';
  assert pg_temp.st('c') = 'delivered';
end $$;
reset role;
-- nobody was messaged about a step back: every post of this test came from a forward move
do $$ declare back_posts int;
begin
  select count(*) into back_posts from suqa.wa_outbox w where w.order_id = (select v from ids where k = 'a') and w.event = 'order.status' and w.body->'order'->>'status' not in ('ready', 'out_for_delivery');
  assert back_posts = 0, 'a step back posted a message: ' || back_posts;
  assert (select count(*) from suqa.wa_outbox w where w.order_id = (select v from ids where k = 'a') and w.event = 'order.status') = 2, 'the two forward moves did post';
end $$;
-- a cashier needs the owner's approval
do $$ declare c uuid := gen_random_uuid(); s uuid := (select id from suqa.shops where slug = 'abou-elie'); r jsonb;
begin
  insert into auth.users (id, email) values (c, 'cash109@test.local');
  insert into suqa.shop_members (shop_id, user_id, role, active) values (s, c, 'staff', true);
  perform set_config('request.jwt.claim.sub', c::text, true);
  r := suqa.pos_push('0193a000-0000-7000-8000-000000000001', jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'order.back', 'payload', jsonb_build_object('id', (select v from ids where k = 'a'), 'status', 'pending'))))->'results'->0;
  assert r->>'error' = 'owner_approval_required', 'cashier alone: ' || r;
  r := suqa.pos_push('0193a000-0000-7000-8000-000000000001', jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'order.back', 'payload', jsonb_build_object('id', (select v from ids where k = 'c'), 'status', 'ready', 'approved_by', '22222222-2222-2222-2222-222222222222'))))->'results'->0;
  assert r->>'error' = 'has_payments', 'approved, then the normal rules: ' || r;
  raise notice 'order_step_back: ok';
end $$;
rollback;
