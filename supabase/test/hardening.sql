-- hardening.sql — negative tests for the column guards & limits (dev project, after seed/dev.sql).
-- Paste in the Supabase SQL editor. Every row should say PASS. Cleans up the test order it creates.
create temp table _r (test text, result text);
grant all on _r to authenticated;

create or replace function pg_temp.as_user(u uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', u::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
end $$;

-- expect_fail(test, sql, expected substring of the error)
create or replace function pg_temp.expect_fail(t text, sql text, want text) returns void language plpgsql as $$
begin
  execute sql;
  insert into _r values (t, 'FAIL — statement succeeded');
exception when others then
  insert into _r values (t, case when sqlerrm like '%' || want || '%' then 'PASS' else 'FAIL — ' || sqlerrm end);
end $$;

create or replace function pg_temp.expect_ok(t text, sql text) returns void language plpgsql as $$
begin
  execute sql; insert into _r values (t, 'PASS');
exception when others then insert into _r values (t, 'FAIL — ' || sqlerrm);
end $$;

do $$
declare
  -- NB: dev-admin is also a PLATFORM admin (bypasses guards by design), so the "association admin"
  -- cases run as dev-ops, temporarily promoted to tenant admin for the duration of the test.
  u_admin uuid := 'a0000000-0000-4000-8000-000000000002';
  u_elie  uuid := 'b0000000-0000-4000-8000-000000000001';
  u_c1    uuid := 'c0000000-0000-4000-8000-000000000001';
  t uuid; s uuid; o uuid; a uuid := 'd0000000-0000-4000-8000-000000000001';
begin
  select id into t from suqa.tenants where slug = 'batroun';
  select id into s from suqa.shops where tenant_id = t and slug = 'abou-elie';
  update suqa.tenant_members set role = 'admin' where tenant_id = t and user_id = u_admin;
  set local role authenticated;

  -- customer places a fresh order to work on
  perform pg_temp.as_user(u_c1);
  select id into o from suqa.place_order(s, a,
    (select jsonb_agg(jsonb_build_object('product_id', id, 'quantity', 2)) from (select id from suqa.products where shop_id = s and is_available limit 3) p), '__hardening_test__');

  perform pg_temp.expect_fail('customer cannot edit total',   format('update suqa.orders set total_usd = 0.01 where id = %L', o), 'order_locked');
  perform pg_temp.expect_fail('customer cannot edit address', format('update suqa.orders set address = ''{}'' where id = %L', o), 'order_locked');
  perform pg_temp.expect_fail('customer cannot accept',       format('update suqa.orders set status = ''accepted'' where id = %L', o), 'customers can only cancel');
  perform pg_temp.expect_fail('customer cannot set reject reason', format('update suqa.orders set reject_reason = ''x'' where id = %L', o), 'order_locked');
  perform pg_temp.expect_fail('qty > 999 rejected', format('select suqa.place_order(%L, %L, %L)', s, a,
    (select jsonb_build_array(jsonb_build_object('product_id', id, 'quantity', 1000)) from suqa.products where shop_id = s and is_available limit 1)), 'bad_quantity');
  perform pg_temp.expect_fail('long notes rejected', format('select suqa.place_order(%L, %L, %L, %L)', s, a,
    (select jsonb_build_array(jsonb_build_object('product_id', id, 'quantity', 1)) from suqa.products where shop_id = s and is_available limit 1), repeat('x', 501)), 'notes_too_long');

  -- merchant
  perform pg_temp.as_user(u_elie);
  perform pg_temp.expect_ok  ('merchant accepts',             format('update suqa.orders set status = ''accepted'' where id = %L', o));
  perform pg_temp.expect_fail('merchant cannot edit total',   format('update suqa.orders set total_usd = 999 where id = %L', o), 'order_locked');
  perform pg_temp.expect_fail('merchant cannot change commission', format('update suqa.shops set commission_rate = 0 where id = %L', s), 'shop_locked');
  perform pg_temp.expect_fail('merchant cannot change slug',  format('update suqa.shops set slug = ''hacked'' where id = %L', s), 'shop_locked');
  perform pg_temp.expect_ok  ('merchant can pause',           format('update suqa.shops set status = ''paused'' where id = %L', s));
  perform pg_temp.expect_ok  ('merchant can resume',          format('update suqa.shops set status = ''active'' where id = %L', s));
  perform pg_temp.expect_fail('merchant cannot touch tenant', format('with u as (update suqa.tenants set brand_name = brand_name where id = %L returning 1) select 1/count(*) from u', t), 'division by zero');
  perform pg_temp.expect_fail('merchant cannot read other shop orders', format('select 1/count(*) from suqa.orders where shop_id <> %L and status = ''delivered''', s), 'division by zero');

  -- association admin
  perform pg_temp.as_user(u_admin);
  perform pg_temp.expect_ok  ('admin edits brand',            format('update suqa.tenants set brand_name = brand_name where id = %L', t));
  perform pg_temp.expect_fail('admin cannot change slug',     format('update suqa.tenants set slug = ''other'' where id = %L', t), 'tenant_locked');
  perform pg_temp.expect_fail('admin cannot change status',   format('update suqa.tenants set status = ''draft'' where id = %L', t), 'tenant_locked');
  perform pg_temp.expect_fail('last admin cannot be removed', format('delete from suqa.tenant_members where tenant_id = %L and role = ''admin''', t), 'last_admin');
  perform pg_temp.expect_fail('cannot skip states',           format('update suqa.orders set status = ''delivered'' where id = %L', o), 'not allowed');
end $$;

reset role;
-- clean up: demote dev-ops again and remove the order the test created (as the table owner, bypassing RLS)
update suqa.tenant_members set role = 'ops' where user_id = 'a0000000-0000-4000-8000-000000000002';
delete from suqa.order_events where order_id in (select id from suqa.orders where customer_notes = '__hardening_test__');
delete from suqa.order_items  where order_id in (select id from suqa.orders where customer_notes = '__hardening_test__');
delete from suqa.orders where customer_notes = '__hardening_test__';
select string_agg(test || ' => ' || result, E'\n' order by result desc, test) as results, count(*) filter (where result <> 'PASS') as failures from _r;
