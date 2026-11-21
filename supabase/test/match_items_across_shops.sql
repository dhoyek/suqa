-- 96: a market-wide search shows every shop that has the thing; a search inside one shop is unchanged. Rolls back.
\set ON_ERROR_STOP on
begin;
do $$
declare t uuid := (select id from suqa.tenants where slug = 'batroun'); a uuid := (select id from suqa.shops where slug = 'abou-elie'); b uuid := gen_random_uuid(); c uuid := gen_random_uuid();
        cols text := (select string_agg(quote_ident(column_name), ', ') from information_schema.columns where table_schema = 'suqa' and table_name = 'shops' and column_name not in ('id', 'slug') and is_generated = 'NEVER');
        before_ uuid[]; after_ uuid[]; one_shop_before uuid[]; one_shop_after uuid[]; n int;
begin
  execute format('insert into suqa.shops (id, slug, %s) select $1, ''t96-b'', %s from suqa.shops where id = $2', cols, cols) using b, a;
  execute format('insert into suqa.shops (id, slug, %s) select $1, ''t96-c'', %s from suqa.shops where id = $2', cols, cols) using c, a;
  update suqa.shops set status = 'active' where id in (a, b, c);
  -- shop A: eight kinds of the thing (they would take every place); shops B and C: one each
  insert into suqa.products (tenant_id, shop_id, name, price_usd) select t, a, jsonb_build_object('ar', 'قشقوان ' || g, 'en', 'Kashkawan ' || g), 3 from generate_series(1, 8) g;
  insert into suqa.products (tenant_id, shop_id, name, price_usd) values (t, b, '{"ar":"قشقوان بلدي","en":"Kashkawan baladi"}', 4), (t, c, '{"ar":"قشقوان","en":"Kashkawan"}', 5);

  select array_agg(shop_id order by ord) into before_ from (select m.shop_id, row_number() over () ord from suqa.match_items(t, array['kashkawan'], null, 6) m) x;
  select array_agg(product_id order by ord) into one_shop_before from (select m.product_id, row_number() over () ord from suqa.match_items(t, array['kashkawan'], a, 6) m) x;
  raise notice 'before: % shops in % candidates', (select count(distinct s) from unnest(before_) s), cardinality(before_);
  create temp table t96 on commit drop as select before_ as b, one_shop_before as o, t, a, c as shop_c, b as shop_b;
end $$;
\i supabase/schema/96_match_items_across_shops.sql
\i supabase/schema/96_match_items_across_shops.sql
do $$
declare r record; after_ uuid[]; one_shop_after uuid[]; sc real[];
begin
  select * into r from t96;
  select array_agg(shop_id order by ord), array_agg(score order by ord) into after_, sc from (select m.shop_id, m.score, row_number() over () ord from suqa.match_items(r.t, array['kashkawan'], null, 6) m) x;
  select array_agg(product_id order by ord) into one_shop_after from (select m.product_id, row_number() over () ord from suqa.match_items(r.t, array['kashkawan'], r.a, 6) m) x;
  assert cardinality(after_) = 6, 'six candidates';
  assert r.a = any(after_) and r.shop_b = any(after_) and r.shop_c = any(after_), 'every shop that has it is among the candidates: ' || after_::text;
  assert (select count(distinct s) from unnest(after_[1:3]) s) = 3, 'the three shops come first: ' || after_::text;
  assert sc[1] >= sc[2] and sc[2] >= sc[3], 'best first among the shops: ' || sc::text;
  assert one_shop_after = r.o, 'a search inside one shop is unchanged';
  raise notice 'after: shops %, scores %', (select count(distinct s) from unnest(after_) s), sc;
end $$;
\echo match_items_across_shops OK
rollback;
