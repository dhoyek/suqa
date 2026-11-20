-- 87: shared item categories — items move onto the list, unknown sections are kept, a shop adds its own without doubles.
\set ON_ERROR_STOP on
begin;
insert into suqa.products (tenant_id, shop_id, name, section, price_usd) select s.tenant_id, s.id, x.n::jsonb, x.sec, 1 from suqa.shops s,
  (values ('{"ar":"بيبسي 2 ل","en":"PEPSI 2L"}', 'SYRO JUS/SOFTDR'), ('{"ar":"أوريجينال عصير 240 مل","en":"ORIGINAL 240ML"}', 'SYRO JUS/SOFTDR'), ('{"en":"MR JUICY 1L"}', 'SYRO JUS/SOFTDR'),
          ('{"en":"Soap bar"}', 'SOAP'), ('{"en":"Zaatar"}', 'فرن'), ('{"en":"T-shirt"}', 'My Own Section')) x(n, sec) where s.slug = 'abou-elie';
update suqa.shops set section_names = '{"My Own Section":{"ar":"قسمي","en":"My Own"}}' where slug = 'abou-elie';
\i supabase/schema/87_item_categories.sql
\i supabase/schema/87_item_categories.sql
do $$ declare t uuid := (select tenant_id from suqa.shops where slug = 'abou-elie'); sh uuid := (select id from suqa.shops where slug = 'abou-elie'); r jsonb; n int;
begin
  assert (select section from suqa.products where name->>'en' = 'PEPSI 2L' and shop_id = sh) = 'Soft Drinks';
  assert (select section from suqa.products where name->>'en' = 'ORIGINAL 240ML' and shop_id = sh) = 'Juices';
  assert (select section from suqa.products where name->>'en' = 'MR JUICY 1L' and shop_id = sh) = 'Juices';
  assert (select section from suqa.products where name->>'en' = 'Soap bar' and shop_id = sh) = 'Soap & Hand Wash';
  assert (select section from suqa.products where name->>'en' = 'Zaatar' and shop_id = sh) = 'Manakish';
  assert (select old_section from suqa.item_category_moves m join suqa.products p on p.id = m.product_id where p.name->>'en' = 'Soap bar' and p.shop_id = sh) = 'SOAP', 'the old section is kept for undo (and survives a second run)';
  assert not exists (select 1 from suqa.item_category_moves where old_section = new_section), 'a move that moved nothing';
  assert (select name->>'ar' from suqa.item_categories where tenant_id = t and key = 'My Own Section') = 'قسمي', 'unknown section kept with the shop''s name';
  assert not exists (select 1 from suqa.products p where coalesce(trim(p.section), '') <> '' and not exists (select 1 from suqa.item_categories c where c.tenant_id = p.tenant_id and c.key = p.section)), 'an item is outside the list';
  n := (select count(*) from suqa.item_categories where tenant_id = t);
  -- a shop owner adds a category; the same one again (other case / other language) is not doubled
  perform set_config('role', 'authenticated', true); perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  r := suqa.item_category_add(sh, 'Men''s Clothing', 'ألبسة رجالية'); assert (r->>'existing')::boolean = false and r->>'key' = 'Men''s Clothing', 'add: ' || r;
  r := suqa.item_category_add(sh, 'men''s  clothing', null); assert (r->>'existing')::boolean and r->>'key' = 'Men''s Clothing', 'same again: ' || r;
  r := suqa.item_category_add(sh, null, 'البسه رجاليه'); assert (r->>'existing')::boolean, 'same in Arabic: ' || r;
  r := suqa.item_category_add(sh, 'water', null); assert (r->>'existing')::boolean and r->>'key' = 'Water', 'seeded one: ' || r;
  r := suqa.item_category_add(sh, null, 'مياه'); assert r->>'key' = 'Water', 'seeded one by its Arabic name: ' || r;
  perform set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true);
  begin perform suqa.item_category_add(sh, 'Hack', 'x'); raise exception 'a stranger added a category'; exception when others then if sqlerrm <> 'not_shop_staff' then raise; end if; end;
  perform set_config('role', 'postgres', true);
  assert (select count(*) from suqa.item_categories where tenant_id = t) = n + 1, 'exactly one category added';
end $$;
select 'item categories: all checks passed' as result;
rollback;
