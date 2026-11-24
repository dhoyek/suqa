-- 110: a cancelled / rejected order reopened — where it goes back to, stock taken or reserved again exactly once, refusals, no message. Rolls back.
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
insert into ids values ('a', gen_random_uuid()), ('b', gen_random_uuid()), ('m', gen_random_uuid()), ('on1', gen_random_uuid()), ('on2', gen_random_uuid()), ('on3', gen_random_uuid()), ('p', gen_random_uuid()), ('cust', gen_random_uuid());
insert into auth.users (id, email) select v, 'cust110@test.local' from ids where k = 'cust';
update suqa.shops set allow_negative_stock = false, deduct_stock_at = 'ready' where slug = 'abou-elie';
insert into suqa.products (id, tenant_id, shop_id, name, price_usd, price_lbp, is_active, track_stock, on_hand, visible_online, is_available)
select (select v from ids where k = 'p'), tenant_id, id, '{"en":"reopen test item"}', 3, 0, true, true, 20, true, true from suqa.shops where slug = 'abou-elie';
create or replace function pg_temp.hand() returns numeric language sql as $$ select on_hand from suqa.products where id = (select v from ids where k = 'p') $$;
create or replace function pg_temp.resv() returns numeric language sql as $$ select reserved from suqa.products where id = (select v from ids where k = 'p') $$;
create or replace function pg_temp.st(kk text) returns text language sql as $$ select status::text from suqa.orders where id = (select v from ids where k = kk) $$;
grant execute on all functions in schema pg_temp to authenticated;

-- three online orders of 2 pieces each, placed by a customer (rows written directly, as the storefront's function would)
insert into suqa.orders (id, tenant_id, shop_id, customer_id, number, status, channel, customer_name, customer_phone, fulfillment, subtotal_usd, total_usd, fx_lbp_rate, subtotal_cents, total_cents, total_lbp, rate_lbp_per_usd)
select i.v, s.tenant_id, s.id, (select v from ids where k = 'cust'), 'T110-' || i.k, 'pending', 'online', 'Cust', '70123123', 'pickup', 6, 6, 90000, 600, 600, 540000, 90000
  from ids i, suqa.shops s where s.slug = 'abou-elie' and i.k in ('on1', 'on2', 'on3');
insert into suqa.order_items (order_id, tenant_id, product_id, name, unit_price_usd, quantity, line_total_usd)
select i.v, s.tenant_id, (select v from ids where k = 'p'), '{"en":"x"}', 3, 2, 6 from ids i, suqa.shops s where s.slug = 'abou-elie' and i.k in ('on1', 'on2', 'on3');
do $$ begin assert pg_temp.hand() = 20 and pg_temp.resv() = 6, 'three online orders reserve 6: ' || pg_temp.resv(); end $$;

set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';   -- the shop owner
create or replace function pg_temp.push(p_kind text, p_payload jsonb) returns jsonb language sql as $$
  select suqa.pos_push('0193a000-0000-7000-8000-000000000001', jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'kind', p_kind, 'payload', p_payload)))->'results'->0 $$;
create or replace function pg_temp.go(kk text, s text) returns jsonb language sql as $$ select pg_temp.push('order.status', jsonb_build_object('id', (select v from ids where k = kk), 'status', s)) $$;
create or replace function pg_temp.reopen(kk text) returns jsonb language plpgsql as $$
begin return suqa.pos_order_reopen((select id from suqa.shops where slug = 'abou-elie'), (select v from ids where k = kk)); exception when others then return jsonb_build_object('error', sqlerrm); end $$;
do $$ declare r jsonb; kk text; s uuid := (select id from suqa.shops where slug = 'abou-elie'); pid uuid := (select v from ids where k = 'p'); n int;
begin
  -- ---- WhatsApp orders: a, b, m — 2 pieces each
  foreach kk in array array['a','b','m'] loop
    r := pg_temp.push('sale.commit', jsonb_build_object('id', (select v from ids where ids.k = kk), 'local_number', 'R-' || kk, 'channel', 'whatsapp', 'status', 'accepted', 'rate_lbp_per_usd', 90000,
          'customer_name', 'Cust', 'customer_phone', '70123123', 'fulfillment', 'delivery', 'address', '{"line1":"x"}'::jsonb, 'subtotal_cents', 600, 'total_cents', 600, 'total_lbp', 540000, 'placed_at', now(),
          'lines', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'product_id', pid, 'name', '{"en":"x"}'::jsonb, 'qty', 2, 'unit_price_cents', 300, 'line_total_cents', 600)),
          'stock_moves', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'product_id', pid, 'qty', -2, 'kind', 'sale'))));
    assert r->>'status' = 'ok', 'order: ' || r::text;
  end loop;
  assert pg_temp.hand() = 14, 'three WhatsApp orders took 6: ' || pg_temp.hand();

  -- a: accepted → ready → cancelled → reopened = ready again, its 2 pieces taken again, once
  assert pg_temp.go('a', 'ready')->>'status' = 'ok';
  assert pg_temp.go('a', 'cancelled')->>'status' = 'ok' and pg_temp.hand() = 16, 'the cancel gave 2 back: ' || pg_temp.hand();
  r := pg_temp.reopen('a'); assert (r->>'ok')::boolean and r->>'status' = 'ready', 'reopen a: ' || r::text;
  assert pg_temp.st('a') = 'ready' and pg_temp.hand() = 14, 'ready again, 2 taken again: ' || pg_temp.hand();
  assert (select closed_at is null and cancel_reason is null from suqa.orders where id = (select v from ids where k = 'a')), 'open, no cancel reason';
  r := pg_temp.reopen('a'); assert (r->>'noop')::boolean and pg_temp.hand() = 14, 'a second tap changes nothing: ' || r::text;
  assert pg_temp.go('a', 'delivered')->>'status' = 'ok' and pg_temp.hand() = 14, 'and it goes on normally';
  assert (select count(*) from suqa.order_events where order_id = (select v from ids where k = 'a') and note = 'reopened') = 1, 'in the history once';
  assert (select count(*) from suqa.audit_log where action = 'order.reopen' and ref_id = (select v::text from ids where k = 'a')) = 1, 'in the operations log once';

  -- b: cancelled, then the shelf is empty → refused, nothing changes
  assert pg_temp.go('b', 'cancelled')->>'status' = 'ok' and pg_temp.hand() = 16;
end $$;
reset role;
update suqa.products set on_hand = 1 where id = (select v from ids where k = 'p');     -- someone else bought the rest
set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$ declare r jsonb;
begin
  r := pg_temp.reopen('b'); assert r->>'error' = 'out_of_stock', 'not enough on the shelf: ' || r::text;
  assert pg_temp.st('b') = 'cancelled' and pg_temp.hand() = 1, 'left as it was';
end $$;
reset role;
update suqa.products set on_hand = 10, reserved = 6 where id = (select v from ids where k = 'p');
-- m: cancelled because it was merged into another order → refused
insert into suqa.audit_log (shop_id, tenant_id, action, ref_tbl, ref_id, after)
select s.id, s.tenant_id, 'order.merged', 'orders', gen_random_uuid()::text, jsonb_build_object('from', (select v from ids where k = 'm')) from suqa.shops s where s.slug = 'abou-elie';
set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$ declare r jsonb; pid uuid := (select v from ids where k = 'p'); o1 uuid := (select v from ids where k = 'on1'); o2 uuid := (select v from ids where k = 'on2');
begin
  assert pg_temp.go('m', 'cancelled')->>'status' = 'ok';
  r := pg_temp.reopen('m'); assert r->>'error' = 'merged', 'a merged order is not reopened: ' || r::text;

  -- ---- online on1: rejected while pending (reservation released) → reopened = pending, reserved again; then taken once
  assert pg_temp.hand() = 12 and pg_temp.resv() = 6, 'start of the online part: ' || pg_temp.hand() || ' / ' || pg_temp.resv();
  assert pg_temp.go('on1', 'rejected')->>'status' = 'ok' and pg_temp.resv() = 4, 'rejected: its 2 are free again: ' || pg_temp.resv();
  r := pg_temp.reopen('on1'); assert (r->>'ok')::boolean and r->>'status' = 'pending', 'reopen on1: ' || r::text;
  assert pg_temp.resv() = 6 and pg_temp.hand() = 12, 'reserved again, nothing taken: ' || pg_temp.resv();
  assert pg_temp.go('on1', 'accepted')->>'status' = 'ok' and pg_temp.go('on1', 'ready')->>'status' = 'ok';
  assert pg_temp.hand() = 10 and pg_temp.resv() = 4, 'at ready: taken once, its reservation gone: ' || pg_temp.hand() || ' / ' || pg_temp.resv();
  assert (select count(*) from suqa.stock_moves where ref_order_id = o1 and kind = 'sale') = 1, 'one sale move';

  -- ---- online on2: cancelled AFTER its stock was taken → reopened = ready, nothing taken or reserved again
  assert pg_temp.go('on2', 'accepted')->>'status' = 'ok' and pg_temp.go('on2', 'ready')->>'status' = 'ok';
  assert pg_temp.hand() = 8 and pg_temp.resv() = 2;
  assert pg_temp.go('on2', 'cancelled')->>'status' = 'ok';
  r := pg_temp.reopen('on2'); assert (r->>'ok')::boolean and r->>'status' = 'ready', 'reopen on2: ' || r::text;
  assert pg_temp.hand() = 8 and pg_temp.resv() = 2, 'stock untouched: ' || pg_temp.hand() || ' / ' || pg_temp.resv();
  assert (select count(*) from suqa.stock_moves where ref_order_id = o2 and kind = 'sale') = 1, 'still one sale move';
end $$;
-- ---- online on3: the CUSTOMER cancels his pending order → the shop cannot reopen it
reset role;
do $$ begin perform set_config('request.jwt.claim.sub', (select v::text from ids where k = 'cust'), true); end $$;
update suqa.orders set status = 'cancelled' where id = (select v from ids where k = 'on3');
do $$ begin assert (select actor_kind = 'customer' from suqa.order_events where order_id = (select v from ids where k = 'on3') and to_status = 'cancelled'), 'recorded as the customer''s own cancel'; end $$;
set local role authenticated;
do $$ declare r jsonb; c uuid := gen_random_uuid(); s uuid := (select id from suqa.shops where slug = 'abou-elie');
begin
  assert pg_temp.st('on3') = 'cancelled', 'the customer cancelled';
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  r := pg_temp.reopen('on3'); assert r->>'error' = 'cancelled_by_customer', 'his own cancel stands: ' || r::text;
end $$;
reset role;
-- nobody was messaged about a reopen; a cashier needs the owner's approval
do $$ declare c uuid := gen_random_uuid(); s uuid := (select id from suqa.shops where slug = 'abou-elie'); r jsonb; ok boolean; n int;
begin
  select count(*) into n from suqa.wa_outbox w where w.order_id = (select v from ids where k = 'a') and w.event = 'order.status';
  assert n = 3, 'order a posted ready, cancelled, delivered — and nothing for the reopen: ' || n;
  insert into auth.users (id, email) values (c, 'cash110@test.local');
  insert into suqa.shop_members (shop_id, user_id, role, active) values (s, c, 'staff', true);
  perform set_config('request.jwt.claim.sub', c::text, true);
  begin perform suqa.pos_order_reopen(s, (select v from ids where k = 'b')); ok := true; exception when insufficient_privilege then ok := false; end;
  assert not ok, 'a cashier alone is refused';
  r := suqa.pos_order_reopen(s, (select v from ids where k = 'b'), '22222222-2222-2222-2222-222222222222');
  assert (r->>'ok')::boolean and r->>'status' = 'accepted', 'with approval, back to accepted: ' || r::text;
  raise notice 'order_reopen: ok';
end $$;
rollback;
