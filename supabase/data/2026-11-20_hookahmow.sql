-- Data (not schema): add shop "Hookah Mow" (Hsarat), category "Argile & Tobacco", 4 zones, 8 items.
-- Idempotent: safe to run twice. Dan asked 2026-11-20 for dev and prod.
do $$
declare
  t uuid := 'ed1655e4-b41b-47e9-bfba-fded0f51cbc6';
  cat uuid; shop uuid;
begin
  select id into cat from suqa.categories where tenant_id = t and slug = 'argile';
  if cat is null then
    insert into suqa.categories (tenant_id, slug, name, sort_order)
    values (t, 'argile', '{"ar":"أراكيل ودخان","en":"Argile & Tobacco"}',
            (select coalesce(max(sort_order),0)+1 from suqa.categories where tenant_id = t))
    returning id into cat;
  end if;

  select id into shop from suqa.shops where tenant_id = t and slug = 'hookahmow';
  if shop is null then
    insert into suqa.shops (tenant_id, slug, name, description, status, phone, whatsapp, address_text,
                            location, opening_hours, min_order_usd, prep_minutes, pickup_enabled, pos_enabled, category_id)
    values (t, 'hookahmow', '{"ar":"هوكا ماو","en":"Hookah Mow"}',
            '{"ar":"أراكيل جاهزة، معسل وفحم. 24/24. الدفع كاش عند التسليم أو Whish.","en":"Ready argile, tobacco and charcoal. Open 24 hours. Cash on delivery or Whish."}',
            'pending', '76406562', '76406562', 'Hsarat',
            (select st_pointonsurface(area::geometry)::geography from suqa.delivery_zones where id = 'fedc46d8-2e45-4be2-9607-bfdde9c29561'),
            '{}'::jsonb, 0, 30, true, false, cat)
    returning id into shop;
  end if;

  insert into suqa.shop_delivery_zones (shop_id, zone_id, fee_usd)
  select shop, z.id, null from suqa.delivery_zones z
  where z.tenant_id = t and z.id in ('fedc46d8-2e45-4be2-9607-bfdde9c29561','9b5b958a-9e90-4fba-8b61-a76fa9f8e235',
                                     'a7dcb475-249f-42c3-9232-bb100ff42b19','0591a2e4-c597-4927-bf4f-b36f25cb8409')
  on conflict do nothing;

  insert into suqa.products (tenant_id, shop_id, name, price_usd, unit, unit_kind, decimal_qty, section, visible_online, needs_review, sort_order, aliases)
  select t, shop, v.name::jsonb, v.price, v.unit, v.kind, v.dec, v.section, v.vis, not v.vis, v.ord, v.aliases
  from (values
    ('{"ar":"أركيلة تفاحتين (راس واحد)","en":"Argile 2 apples (1 head)"}', 7.00, null, 'piece', false, 'Argile', true, 1, array['argile','arguile','nargile','narjile','ركيلة','نرجيلة','2 apples','tefahtein','ras']),
    ('{"ar":"أركيلة ليمون ونعناع (راس واحد)","en":"Argile lemon mint (1 head)"}', 7.00, null, 'piece', false, 'Argile', true, 2, array['argile','arguile','nargile','narjile','ركيلة','نرجيلة','lemon mint','laymoun w na3na3','ras']),
    ('{"ar":"فحم أركيلة (حبة)","en":"Argile charcoal (piece)"}', 0, null, 'piece', false, 'Fahem', false, 3, array['fahem','fa7em','charbon','charcoal','فحم']),
    ('{"ar":"فحم أركيلة (كيلو)","en":"Argile charcoal (kilo)"}', 0, 'kg', 'kg', true, 'Fahem', false, 4, array['fahem','fa7em','charbon','charcoal','فحم','kilo']),
    ('{"ar":"معسل نخلة تفاحتين","en":"Tobacco Nakhla 2 apples"}', 0, null, 'piece', false, 'Ma3asel', false, 5, array['nakhle','nakhla','نخلة','ma3asel','2 apples','tefahtein']),
    ('{"ar":"معسل فاخر تفاحتين","en":"Tobacco Al Fakher 2 apples"}', 0, null, 'piece', false, 'Ma3asel', false, 6, array['fakher','al fakher','فاخر','ma3asel','2 apples','tefahtein']),
    ('{"ar":"معسل مزايا ليمون ونعناع","en":"Tobacco Mazaya lemon mint"}', 0, null, 'piece', false, 'Ma3asel', false, 7, array['mazaya','مزايا','ma3asel','lemon mint','laymoun w na3na3']),
    ('{"ar":"معسل فاخر ليمون ونعناع","en":"Tobacco Al Fakher lemon mint"}', 0, null, 'piece', false, 'Ma3asel', false, 8, array['fakher','al fakher','فاخر','ma3asel','lemon mint','laymoun w na3na3'])
  ) as v(name, price, unit, kind, dec, section, vis, ord, aliases)
  where not exists (select 1 from suqa.products p where p.shop_id = shop and p.name->>'en' = (v.name::jsonb)->>'en');
end $$;

select s.slug, s.status, c.slug cat,
       (select count(*) from suqa.shop_delivery_zones where shop_id = s.id) zones,
       (select count(*) from suqa.products where shop_id = s.id) items,
       (select count(*) from suqa.products where shop_id = s.id and visible_online) visible
from suqa.shops s join suqa.categories c on c.id = s.category_id where s.slug = 'hookahmow';
