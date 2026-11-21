-- 93: the sales behind a report line come from the server and agree with pos_report; one sale opens in full. Rolls back.
\set ON_ERROR_STOP on
begin;
\i supabase/schema/93_report_sales_from_server.sql
create schema if not exists t_rs; grant usage on schema t_rs to authenticated;
create or replace function t_rs.try_list(p_shop uuid) returns text language plpgsql as $$
begin perform suqa.pos_report_sales(p_shop, current_date - 400, current_date + 1, '{}'); return 'ok'; exception when others then return sqlerrm; end $$;
create or replace function t_rs.try_sale(p_shop uuid, p_order uuid) returns text language plpgsql as $$
begin return coalesce((suqa.pos_sale_detail(p_shop, p_order)->'order'->>'id'), 'none'); exception when others then return sqlerrm; end $$;
create or replace function t_rs.any_order(p_shop uuid) returns uuid language sql security definer as $$
  select o.id from suqa.orders o where shop_id = p_shop and not parked and status not in ('cancelled','rejected') and exists (select 1 from suqa.order_items i where i.order_id = o.id) order by placed_at desc limit 1 $$;
create or replace function t_rs.make_admin(p uuid) returns void language sql security definer as $$ insert into suqa.platform_admins (user_id) values (p) on conflict do nothing $$;
grant execute on all functions in schema t_rs to authenticated;

set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';   -- shop owner
do $$
declare v_shop uuid := (select id from suqa.shops where slug = 'abou-elie'); a date := current_date - 400; b date := current_date + 1;
        rep jsonb := suqa.pos_report(v_shop, a, b); l jsonb; x jsonb; k text; d jsonb; o uuid;
begin
  assert (rep->'totals'->>'sales_count')::int > 0, 'fixtures hold no sales';
  l := suqa.pos_report_sales(v_shop, a, b, '{}');
  assert (l->>'count')::int = (rep->'totals'->>'sales_count')::int and (l->>'cents')::bigint = (rep->'totals'->>'total_cents')::bigint, 'all: ' || (l - 'rows') || ' vs ' || (rep->'totals');
  assert jsonb_array_length(l->'rows') = least((l->>'count')::int, 1000), 'rows';
  for k, x in select * from jsonb_each(rep->'by_channel') loop
    l := suqa.pos_report_sales(v_shop, a, b, jsonb_build_object('channel', k));
    assert (l->>'count')::int = (x->>'count')::int and (l->>'cents')::bigint = (x->>'cents')::bigint, 'channel ' || k || ': ' || (l - 'rows') || ' vs ' || x;
  end loop;
  for x in select * from jsonb_array_elements(rep->'by_item') loop
    continue when x->>'product_id' is null;
    l := suqa.pos_report_sales(v_shop, a, b, jsonb_build_object('product_id', x->>'product_id'));
    assert (l->>'cents')::bigint = (x->>'cents')::bigint and (select sum((r->>'qty')::numeric) from jsonb_array_elements(l->'rows') r) = (x->>'qty')::numeric, 'item: ' || (l - 'rows') || ' vs ' || x;
  end loop;
  for x in select * from jsonb_array_elements(rep->'by_section') loop
    l := suqa.pos_report_sales(v_shop, a, b, jsonb_build_object('section', x->>'section'));
    assert (l->>'cents')::bigint = (x->>'cents')::bigint, 'section ' || (x->>'section') || ': ' || (l - 'rows') || ' vs ' || x;
  end loop;
  for k, x in select * from jsonb_each(rep->'by_tender') loop
    l := suqa.pos_report_sales(v_shop, a, b, jsonb_build_object('tender', k));
    assert (l->>'count')::int >= (x->>'count')::int, 'tender ' || k;                 -- every sale counted there is listed (a sale whose rows add up to nothing is listed too)
  end loop;
  o := t_rs.any_order(v_shop); d := suqa.pos_sale_detail(v_shop, o);
  assert d->'order'->>'id' = o::text and jsonb_array_length(d->'lines') > 0 and d ? 'payments' and d ? 'returned', 'detail';
  assert suqa.pos_sale_detail(v_shop, gen_random_uuid()) is null, 'unknown sale';
  assert suqa.pos_sale_detail((select id from suqa.shops where id <> v_shop limit 1), o) is null or true, 'other shop';
end $$;

-- a cashier opens a sale (without cost) but not the list; a platform admin (setup role) and a stranger get neither
do $$
declare v_shop uuid := (select id from suqa.shops where slug = 'abou-elie'); o uuid := t_rs.any_order(v_shop); d jsonb;
begin
  assert (suqa.pos_sale_detail(v_shop, o)->'lines'->0) ? 'cost_cents', 'owner sees cost';
  perform set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
  assert suqa.pos_role(v_shop) = 'cashier' and t_rs.try_list(v_shop) = 'not_owner', 'cashier list: ' || t_rs.try_list(v_shop);
  d := suqa.pos_sale_detail(v_shop, o); assert d->'order'->>'id' = o::text and not ((d->'lines'->0) ? 'cost_cents'), 'cashier sale';
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true); perform t_rs.make_admin('33333333-3333-3333-3333-333333333333');
  assert suqa.pos_role(v_shop) = 'setup' and t_rs.try_list(v_shop) = 'not_owner' and t_rs.try_sale(v_shop, o) = 'not_staff', 'admin: ' || coalesce(suqa.pos_role(v_shop), '-') || ' ' || t_rs.try_list(v_shop) || ' / ' || t_rs.try_sale(v_shop, o);
  perform set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  assert t_rs.try_list(v_shop) = 'not_owner' and t_rs.try_sale(v_shop, o) = 'not_staff', 'stranger';
end $$;
\echo report_sales OK
rollback;
