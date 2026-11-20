-- 86: the customer closes his order ("I received it") and asks to cancel after acceptance; the shop answers.
\set ON_ERROR_STOP on
begin;
create schema if not exists net;
create sequence if not exists net.req_seq;
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 1000)
returns bigint language sql as $$ select nextval('net.req_seq') $$;
grant usage on schema net to authenticated; grant all on all sequences in schema net to authenticated;
\i supabase/schema/86_customer_close_cancel.sql
create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated;
insert into ids values ('a', gen_random_uuid()), ('b', gen_random_uuid()), ('c', gen_random_uuid()), ('d', gen_random_uuid()), ('cust', '55555555-5555-5555-5555-555555555555');

-- four accepted orders made by the shop owner, then handed to one customer (as the table owner)
set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
create or replace function pg_temp.push(p_kind text, p_payload jsonb) returns jsonb language sql as $$
  select suqa.pos_push('0193a000-0000-7000-8000-000000000001', jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'kind', p_kind, 'payload', p_payload)))->'results'->0 $$;
do $$ declare r jsonb; kk text; v_prod uuid := (select id from suqa.products where shop_id = (select id from suqa.shops where slug = 'abou-elie') limit 1);
begin
  foreach kk in array array['a','b','c','d'] loop
    r := pg_temp.push('sale.commit', jsonb_build_object('id', (select v from ids where ids.k = kk), 'local_number', 'X-' || kk, 'channel', 'whatsapp', 'status', 'accepted', 'rate_lbp_per_usd', 90000,
          'customer_name', 'Cust', 'customer_phone', '70123123', 'fulfillment', 'delivery', 'address', '{"line1":"x"}'::jsonb, 'subtotal_cents', 600, 'total_cents', 600, 'total_lbp', 540000, 'placed_at', now(),
          'lines', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'product_id', v_prod, 'name', '{"en":"x"}'::jsonb, 'qty', 2, 'unit_price_cents', 300, 'line_total_cents', 600))));
    assert r->>'status' = 'ok', 'order: ' || r;
  end loop;
end $$;
reset role;
insert into auth.users (id) values ('55555555-5555-5555-5555-555555555555') on conflict do nothing;
update suqa.orders set customer_id = (select v from ids where k = 'cust') where id in (select v from ids where k in ('a','b','c','d'));
-- order d: a payment is already recorded on it
insert into suqa.payments (id, order_id, tenant_id, shop_id, tender, currency, amount, at)
select gen_random_uuid(), o.id, o.tenant_id, o.shop_id, 'cash_usd', 'usd', 600, now() from suqa.orders o where o.id = (select v from ids where k = 'd');

-- ---- as the customer ----
set local role authenticated; set local request.jwt.claim.sub = '55555555-5555-5555-5555-555555555555';
do $$ declare r jsonb; ok boolean;
begin
  -- he cannot write "delivered" himself
  begin update suqa.orders set status = 'delivered' where id = (select v from ids where k = 'a'); exception when others then null; end;
  assert (select status from suqa.orders where id = (select v from ids where k = 'a')) = 'accepted', 'customer wrote delivered directly: ' || coalesce((select status::text from suqa.orders where id = (select v from ids where k = 'a')), 'not visible');
  -- "I received it": delivered, by the customer; twice is harmless
  r := suqa.customer_confirm_received((select v from ids where k = 'a')); assert r->>'status' = 'delivered', 'received: ' || r;
  r := suqa.customer_confirm_received((select v from ids where k = 'a')); assert r->>'status' = 'delivered', 'received twice: ' || r;
  -- ask to cancel b, c and d
  r := suqa.customer_request_cancel((select v from ids where k = 'b'), 'changed my mind'); assert r->>'status' = 'open', 'req b: ' || r;
  r := suqa.customer_request_cancel((select v from ids where k = 'c'), null); assert r->>'status' = 'open';
  r := suqa.customer_request_cancel((select v from ids where k = 'd'), 'x'); assert r->>'status' = 'open';
  assert (select count(*) from suqa.order_cancel_requests) = 3, 'customer sees his 3 requests';
  -- he cannot answer his own request
  begin perform suqa.shop_answer_cancel((select v from ids where k = 'b'), true); ok := false; exception when others then ok := true; end;
  assert ok, 'customer answered his own request';
end $$;
reset role;
do $$ begin assert (select status from suqa.orders where id = (select v from ids where k = 'a')) = 'delivered'; end $$;
do $$ begin assert (select note from suqa.order_events where order_id = (select v from ids where k = 'a') order by id desc limit 1) = 'confirmed by the customer'; end $$;
do $$ begin assert (select actor_kind::text from suqa.order_events where order_id = (select v from ids where k = 'a') order by id desc limit 1) = 'customer'; end $$;

-- ---- the shop answers ----
set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$ declare r jsonb; ok boolean;
begin
  assert (select count(*) from suqa.order_cancel_requests where status = 'open') = 3, 'shop sees 3 open requests';
  r := suqa.shop_answer_cancel((select v from ids where k = 'b'), true, null); assert r->>'status' = 'accepted', 'accept b: ' || r;
  r := suqa.shop_answer_cancel((select v from ids where k = 'b'), false, null); assert r->>'status' = 'accepted', 'answered twice keeps the first: ' || r;
  r := suqa.shop_answer_cancel((select v from ids where k = 'c'), false, 'already on the way'); assert r->>'status' = 'refused';
  begin perform suqa.shop_answer_cancel((select v from ids where k = 'd'), true); ok := false; exception when others then ok := sqlerrm = 'has_payments'; end;
  assert ok, 'a paid order was cancelled';
end $$;
reset role;
do $$ begin assert (select status from suqa.orders where id = (select v from ids where k = 'b')) = 'cancelled'; end $$;
do $$ begin assert (select cancel_reason from suqa.orders where id = (select v from ids where k = 'b')) = 'الزبون: changed my mind'; end $$;
do $$ begin assert (select status from suqa.orders where id = (select v from ids where k = 'c')) = 'accepted'; end $$;
do $$ begin assert (select status from suqa.orders where id = (select v from ids where k = 'd')) = 'accepted'; end $$;
select 'customer close / cancel: all checks passed' as result;
rollback;
