-- Data (not schema): add shop "Chibon Chocolat" (phone 71 872 818), 5 items from its Christmas price list. Idempotent.
-- Prices read as per kilo (the flyer shows no unit). Same set-up as Le goût d'ici: pending, POS on, rate 90,000 (tenant rate),
-- owner invite for 961 71 872 818, driver keeps the whole delivery fee, open 08:00–24:00 every day.
do $$
declare
  t uuid := 'ed1655e4-b41b-47e9-bfba-fded0f51cbc6';
  cat uuid; shop uuid; rate numeric;
begin
  select id into cat from suqa.categories where tenant_id = t and slug = 'bakery';
  select fx_lbp_rate into rate from suqa.tenants where id = t;

  select id into shop from suqa.shops where tenant_id = t and slug = 'chibon';
  if shop is null then
    insert into suqa.shops (tenant_id, slug, name, description, status, phone, whatsapp, location, opening_hours,
                            min_order_usd, prep_minutes, pickup_enabled, pos_enabled, category_id, driver_pay_mode, driver_pay_cents)
    values (t, 'chibon', '{"ar":"شيبون شوكولا","en":"Chibon Chocolat"}',
            '{"ar":"شوكولا محشية، شوكولا مع مكسّرات وفواكه مجففة، وشوكولا بيضاء. لائحة أسعار الميلاد.","en":"Filled chocolate, chocolate with nuts and dried fruit, and white chocolate. Christmas price list."}',
            'pending', '71872818', '71872818',
            (select st_pointonsurface(area::geometry)::geography from suqa.delivery_zones where id = 'fedc46d8-2e45-4be2-9607-bfdde9c29561'),
            (select jsonb_object_agg(d, '[["08:00","00:00"]]'::jsonb) from unnest(array['mon','tue','wed','thu','fri','sat','sun']) d),
            0, 30, true, true, cat, 'delivery_fee', 0)
    returning id into shop;
  end if;

  insert into suqa.shop_delivery_zones (shop_id, zone_id, fee_usd)
  select shop, z.id, null from suqa.delivery_zones z
  where z.tenant_id = t and z.id in ('fedc46d8-2e45-4be2-9607-bfdde9c29561','9b5b958a-9e90-4fba-8b61-a76fa9f8e235',
                                     'a7dcb475-249f-42c3-9232-bb100ff42b19','0591a2e4-c597-4927-bf4f-b36f25cb8409')
  on conflict do nothing;

  insert into suqa.exchange_rates (shop_id, tenant_id, lbp_per_usd)
  select shop, t, rate where not exists (select 1 from suqa.exchange_rates where shop_id = shop);

  insert into suqa.staff_invites (shop_id, tenant_id, phone, role)
  select shop, t, '96171872818', 'owner'
  where not exists (select 1 from suqa.staff_invites where shop_id = shop and phone = '96171872818');

  insert into suqa.products (tenant_id, shop_id, name, description, price_usd, price_currency, price_lbp, unit, unit_kind, decimal_qty, section, visible_online, sort_order, aliases)
  select t, shop, v.name::jsonb, v.descr::jsonb, v.usd, 'usd', round(v.usd * rate)::bigint, '1 kg', 'piece', false, v.section, true, v.ord, v.aliases
  from (values
    ('{"ar":"شوكولا محشية","en":"Filled chocolate"}',
     '{"ar":"لوتس، أوريو، كيندر، فوييتين، ويفر مقرمش، كاسر، فستق، تشيز كيك، غزل البنات. اكتبوا النكهات بملاحظة.","en":"Lotus, Oreo, Kinder, Feuilletine, Crispy Wafer, Kasser, Pistachio, Cheesecake, Cotton Candy. Write the flavours you want in the note."}',
     26.00, 'Chocolate', 1, array['chocolat','chocolate','choco','شوكولا','mahchiye','محشي','lotus','oreo','kinder','feuilletine','wafer','pistachio','fosto2','cheesecake','cotton candy']),
    ('{"ar":"شوكولا مميزة (لوتس / أوريو، بونبون، مكسّرات)","en":"Special chocolate: dipped Lotus or Oreo, bonbons, nuts"}',
     '{"ar":"لوتس أو أوريو مغمّس بالشوكولا، بونبون، شوكولا مع مكسّرات.","en":"Chocolate-dipped Lotus or Oreo, bonbons, chocolate with nuts."}',
     28.00, 'Chocolate', 2, array['chocolat','chocolate','شوكولا','bonbon','بونبون','lotus','oreo','nuts','mkassarat','مكسرات']),
    ('{"ar":"شوكولا مميزة (بلح، تمر، فواكه مجففة، روشيه)","en":"Special chocolate: dates, dried fruit, mendiants, rochers"}',
     '{"ar":"بلح، تمر، فواكه مجففة، مكسّرات وفواكه مجففة، منديان، روشيه بالبندق.","en":"Balah, tamer, dried fruit, nuts & dried fruit, mendiants, hazelnut rochers."}',
     30.00, 'Chocolate', 3, array['chocolat','chocolate','شوكولا','balah','بلح','tamer','tamr','تمر','dried fruit','fawakeh','mendiants','rocher','روشيه','bonde2']),
    ('{"ar":"شوكولا بيضاء","en":"White chocolate"}',
     '{"ar":"شوكولا بيضاء.","en":"White chocolate."}',
     28.00, 'White chocolate', 4, array['white chocolate','chocolat blanc','بيضاء','bayda','شوكولا']),
    ('{"ar":"شوكولا بيضاء مع مكسّرات أو فواكه مجففة","en":"White chocolate with nuts or dried fruit"}',
     '{"ar":"شوكولا بيضاء مع مكسّرات أو فواكه مجففة.","en":"White chocolate with nuts or dried fruit."}',
     30.00, 'White chocolate', 5, array['white chocolate','chocolat blanc','بيضاء','bayda','nuts','mkassarat','مكسرات','dried fruit'])
  ) as v(name, descr, usd, section, ord, aliases)
  where not exists (select 1 from suqa.products p where p.shop_id = shop and p.name->>'en' = (v.name::jsonb)->>'en');
end $$;

select s.id, s.status, s.pos_enabled, s.driver_pay_mode, s.opening_hours->'mon' mon,
  (select count(*) from suqa.shop_delivery_zones where shop_id = s.id) zones,
  (select lbp_per_usd from suqa.exchange_rates where shop_id = s.id order by effective_at desc limit 1) rate,
  (select string_agg(phone||':'||role, ', ') from suqa.staff_invites where shop_id = s.id) invites,
  (select string_agg(p.name->>'en'||' $'||p.price_usd, '; ' order by p.sort_order) from suqa.products p where p.shop_id = s.id) items
from suqa.shops s where s.slug = 'chibon';
