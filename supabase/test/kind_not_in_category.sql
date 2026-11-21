-- 97: a kind of item never matches in a category it cannot belong to; a name still matches anywhere. Rolls back.
\set ON_ERROR_STOP on
begin;
\i supabase/schema/97_kind_not_in_category.sql
\i supabase/schema/97_kind_not_in_category.sql
do $$
declare t uuid := (select id from suqa.tenants where slug = 'batroun'); a uuid := (select id from suqa.shops where slug = 'abou-elie'); r record; names text[];
  function_ok boolean;
begin
  update suqa.shops set status = 'active' where id = a;
  insert into suqa.products (tenant_id, shop_id, name, price_usd, section) values
    (t, a, '{"ar":"بانادول اكسترا","en":"Panadol Extra"}', 2, 'Pain Relief'),
    (t, a, '{"ar":"خبز عربي تست","en":"Arabic bread t97"}', 1, 'Bread & Bakery'),
    (t, a, '{"ar":"مزيل عرق قهوة","en":"Deo coffee t97"}', 3, 'Deodorants'),
    (t, a, '{"ar":"قهوة مطحونة تست","en":"Ground coffee t97"}', 5, 'Coffee'),
    (t, a, '{"ar":"شيبس جبنة تست","en":"Cheese chips t97"}', 1, 'Chips & Nuts'),
    (t, a, '{"ar":"جبنة عكاوي تست","en":"Akawi cheese t97"}', 6, 'Packaged Cheese'),
    (t, a, '{"ar":"حليب شوكولا تست","en":"Chocolate milk t97"}', 1, 'Chocolate, Biscuits & Candy'),
    (t, a, '{"ar":"حليب كامل الدسم تست","en":"Full cream milk t97"}', 2, 'Milk & Cereals'),
    (t, a, '{"ar":"قهوة خاصة بالمحل","en":"Coffee own-category t97"}', 4, 'My Own Category');

  select array_agg(m.name->>'en') into names from suqa.match_items(t, array['khebez'], null, 10) m;
  assert 'Arabic bread t97' = any(names) and not ('Panadol Extra' = any(names)), 'khebez: ' || names::text;
  select array_agg(m.name->>'en') into names from suqa.match_items(t, array['ahwe'], null, 10) m;
  assert 'Ground coffee t97' = any(names) and 'Coffee own-category t97' = any(names) and not ('Deo coffee t97' = any(names)), 'ahwe: ' || names::text;      -- a shop's own category is left alone
  select array_agg(m.name->>'en') into names from suqa.match_items(t, array['jebne'], null, 10) m;
  assert 'Akawi cheese t97' = any(names) and not ('Cheese chips t97' = any(names)), 'jebne: ' || names::text;
  select array_agg(m.name->>'en') into names from suqa.match_items(t, array['7alib'], null, 10) m;
  assert 'Full cream milk t97' = any(names) and not ('Chocolate milk t97' = any(names)), '7alib: ' || names::text;       -- (when the shop has real milk; with none, the name alone still brings it)
  -- by its own name an item is found wherever it is filed
  select array_agg(m.name->>'en') into names from suqa.match_items(t, array['panadol'], null, 10) m;
  assert 'Panadol Extra' = any(names), 'panadol by name: ' || names::text;
  select array_agg(m.name->>'en') into names from suqa.match_items(t, array['deo coffee'], null, 10) m;
  assert names[1] = 'Deo coffee t97', 'a name with a kind word in it: ' || names::text;
  select array_agg(m.name->>'en') into names from suqa.match_items(t, array['cheese chips'], null, 10) m;
  assert 'Cheese chips t97' = any(names), 'cheese chips by name: ' || names::text;
  -- every key in the lists is a real category, or the list is stale
  for r in select c.id, k from suqa.match_concepts c, unnest(c.not_in) k where exists (select 1 from suqa.item_categories where key = 'Vapes') and not exists (select 1 from suqa.item_categories ic where ic.key = k) loop      -- (a database older than 88 has not got the whole list)
    raise exception 'kind % names a category that does not exist: %', r.id, r.k;
  end loop;
end $$;
\echo kind_not_in_category OK
rollback;
