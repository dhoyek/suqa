-- Data (not schema): add shop "Le goût d'ici" (homemade Belgian chocolate), 4 zones, 4 items. Idempotent.
-- Prices from the shop's Christmas flyers (2026-11-27). Kilo items are sold per whole kilo online
-- (the storefront takes whole quantities only).
do $$
declare
  t uuid := 'ed1655e4-b41b-47e9-bfba-fded0f51cbc6';
  cat uuid; shop uuid; rate numeric;
begin
  select id into cat from suqa.categories where tenant_id = t and slug = 'bakery';
  select fx_lbp_rate into rate from suqa.tenants where id = t;

  select id into shop from suqa.shops where tenant_id = t and slug = 'le-gout-dici';
  if shop is null then
    insert into suqa.shops (tenant_id, slug, name, description, status, location, opening_hours,
                            min_order_usd, prep_minutes, pickup_enabled, pos_enabled, category_id)
    values (t, 'le-gout-dici', '{"ar":"لو غو ديسي","en":"Le goût d''ici"}',
            '{"ar":"شوكولا بلجيكية، صنع منزلي وباليد. هدية العيد.","en":"Homemade, handmade Belgian chocolate. A perfect Christmas gift."}',
            'pending',
            (select st_pointonsurface(area::geometry)::geography from suqa.delivery_zones where id = 'fedc46d8-2e45-4be2-9607-bfdde9c29561'),
            '{}'::jsonb, 0, 30, true, false, cat)
    returning id into shop;
  end if;

  insert into suqa.shop_delivery_zones (shop_id, zone_id, fee_usd)
  select shop, z.id, null from suqa.delivery_zones z
  where z.tenant_id = t and z.id in ('fedc46d8-2e45-4be2-9607-bfdde9c29561','9b5b958a-9e90-4fba-8b61-a76fa9f8e235',
                                     'a7dcb475-249f-42c3-9232-bb100ff42b19','0591a2e4-c597-4927-bf4f-b36f25cb8409')
  on conflict do nothing;

  insert into suqa.products (tenant_id, shop_id, name, description, price_usd, price_currency, price_lbp, unit, unit_kind, decimal_qty, section, visible_online, sort_order, aliases)
  select t, shop, v.name::jsonb, v.descr::jsonb, v.usd, 'usd', round(v.usd * rate)::bigint, v.unit, 'piece', false, v.section, true, v.ord, v.aliases
  from (values
    ('{"ar":"شوكولا بلجيكية مشكّلة","en":"Belgian chocolate, assorted"}',
     '{"ar":"حبات ذهبية وحبات ملفوفة، صنع منزلي.","en":"Gold-dusted gems and swirls, homemade."}',
     60.00, '1 kg', 'Chocolate', 1, array['chocolat','chocolate','choco','شوكولا','شوكولاتة','belgian','belge']),
    ('{"ar":"شوكولا بلجيكية حمراء وبنية","en":"Belgian chocolate, red & brown gems"}',
     '{"ar":"حبات ماسية حمراء وبنية، صنع منزلي.","en":"Red and milk-chocolate diamond gems, homemade."}',
     70.00, '1 kg', 'Chocolate', 2, array['chocolat','chocolate','choco','شوكولا','شوكولاتة','belgian','belge','red','a7mar']),
    ('{"ar":"شجرة الميلاد شوكولا بلجيكية","en":"Christmas tree, Belgian chocolate"}',
     '{"ar":"محشوة بالغاناش المنزلي.","en":"Filled with homemade ganache."}',
     7.00, 'piece', 'Christmas', 3, array['christmas tree','sapin','shajara','شجرة','ganache','غاناش','chocolate','شوكولا']),
    ('{"ar":"ملبّس لوز","en":"Almond dragées"}',
     '{"ar":"لوز مغطى بالشوكولا البيضاء.","en":"Almonds coated in white chocolate."}',
     10.00, '200 g', 'Dragées', 4, array['dragees','dragée','mlabbas','ملبس','lowz','لوز','almond'])
  ) as v(name, descr, usd, unit, section, ord, aliases)
  where not exists (select 1 from suqa.products p where p.shop_id = shop and p.name->>'en' = (v.name::jsonb)->>'en');
end $$;

select s.id, s.slug, s.status, c.slug cat,
       (select count(*) from suqa.shop_delivery_zones where shop_id = s.id) zones,
       (select string_agg(p.name->>'en' || ' $' || p.price_usd || ' / ' || p.unit || ' (' || p.price_lbp || ' LBP)', '; ' order by p.sort_order)
          from suqa.products p where p.shop_id = s.id) items
from suqa.shops s join suqa.categories c on c.id = s.category_id where s.slug = 'le-gout-dici';
