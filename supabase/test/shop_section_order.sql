-- 89: a shop's own section order. Runs in one transaction and rolls back.
\set ON_ERROR_STOP on
begin;
do $$
declare sh uuid; tn uuid; other uuid; owner uuid := gen_random_uuid(); stranger uuid := gen_random_uuid(); r jsonb;
begin
  select id, tenant_id into sh, tn from suqa.shops where slug = 'abou-elie';
  select id into other from suqa.shops where tenant_id = tn and id <> sh limit 1;
  insert into auth.users (id) values (owner), (stranger);
  insert into suqa.shop_members (shop_id, user_id, role) values (sh, owner, 'owner');
  insert into suqa.item_categories (tenant_id, key, name, sort_order) values (tn, 'Drinks', '{"en":"Drinks","ar":"مشروبات"}', 10), (tn, 'Manakish', '{"en":"Manakish","ar":"مناقيش"}', 20), (tn, 'Pizza', '{"en":"Pizza","ar":"بيتزا"}', 30)
    on conflict (tenant_id, key) do nothing;

  perform set_config('request.jwt.claim.sub', stranger::text, true);
  begin perform suqa.shop_section_order_set(sh, array['Pizza']); raise exception 'a stranger set the order';
  exception when others then if sqlerrm <> 'not_shop_staff' then raise; end if; end;

  perform set_config('request.jwt.claim.sub', owner::text, true);
  r := suqa.shop_section_order_set(sh, array[' Manakish ', 'Pizza', 'Manakish', 'No Such Category', '', 'Drinks']);
  assert r->'keys' = '["Manakish","Pizza","Drinks"]'::jsonb, 'cleaned, in the order given: ' || r::text;
  assert (select keys from suqa.shop_section_order where shop_id = sh) = array['Manakish', 'Pizza', 'Drinks'];
  assert (select updated_by from suqa.shop_section_order where shop_id = sh) = owner;
  r := suqa.shop_section_order_set(sh, array['Pizza']);
  assert (select keys from suqa.shop_section_order where shop_id = sh) = array['Pizza'], 'saved again = replaced';
  if other is not null then                                               -- (the local fixture may hold a single shop)
    begin perform suqa.shop_section_order_set(other, array['Pizza']); raise exception 'an owner set another shop''s order';
    exception when others then if sqlerrm <> 'not_shop_staff' then raise; end if; end;
  end if;
  r := suqa.shop_section_order_set(sh, '{}');
  assert not exists (select 1 from suqa.shop_section_order where shop_id = sh), 'an empty list goes back to the shared order';
  raise notice 'shop_section_order: all checks passed';
end $$;
rollback;
