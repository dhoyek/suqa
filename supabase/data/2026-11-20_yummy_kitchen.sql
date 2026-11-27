-- Data (not schema): add shop "Yummy Kitchen" (pastries, phone 76 142 566), 4 zones, 23 items. Idempotent.
-- Prices from the Christmas 2026 flyer (shish barak 40 pcs $7; older flyer said $8).
-- "+1" items = price to fry at home; the fried version is a separate item at +$1.
do $$
declare
  t uuid := 'ed1655e4-b41b-47e9-bfba-fded0f51cbc6';
  cat uuid; shop uuid; rate numeric;
begin
  select id into cat from suqa.categories where tenant_id = t and slug = 'bakery';
  select fx_lbp_rate into rate from suqa.tenants where id = t;

  select id into shop from suqa.shops where tenant_id = t and slug = 'yummy-kitchen';
  if shop is null then
    insert into suqa.shops (tenant_id, slug, name, description, status, phone, whatsapp, address_text,
                            location, opening_hours, min_order_usd, prep_minutes, pickup_enabled, pos_enabled, category_id)
    values (t, 'yummy-kitchen', '{"ar":"يمي كيتشن","en":"Yummy Kitchen"}',
            '{"ar":"جميع أنواع المعجنات. الحجز مسبقاً ضروري.","en":"All kinds of pastries. Please order in advance."}',
            'pending', '76142566', '76142566', null,
            (select st_pointonsurface(area::geometry)::geography from suqa.delivery_zones where id = 'fedc46d8-2e45-4be2-9607-bfdde9c29561'),
            '{}'::jsonb, 0, 30, true, false, cat)
    returning id into shop;
  end if;

  insert into suqa.shop_delivery_zones (shop_id, zone_id, fee_usd)
  select shop, z.id, null from suqa.delivery_zones z
  where z.tenant_id = t and z.id in ('fedc46d8-2e45-4be2-9607-bfdde9c29561','9b5b958a-9e90-4fba-8b61-a76fa9f8e235',
                                     'a7dcb475-249f-42c3-9232-bb100ff42b19','0591a2e4-c597-4927-bf4f-b36f25cb8409')
  on conflict do nothing;

  insert into suqa.products (tenant_id, shop_id, name, price_usd, price_currency, price_lbp, unit, unit_kind, decimal_qty, section, visible_online, sort_order, aliases)
  select t, shop, v.name::jsonb,
         coalesce(v.usd, round(v.lbp / rate, 2)), case when v.lbp is null then 'usd' else 'lbp' end, coalesce(v.lbp, round(v.usd * rate)::bigint),
         v.unit, 'piece', false, v.section, true, v.ord, v.aliases
  from (values
    ('{"ar":"كباب بالحمة (للقلي)","en":"Meat kebab (to fry)"}',               8.00, null::bigint, 'dozen', 'Lil 2ale', 1,  array['kebab','kbab','كباب']),
    ('{"ar":"كباب بالحمة (مقلي)","en":"Meat kebab (fried)"}',                 9.00, null, 'dozen', 'Lil 2ale', 2,  array['kebab','kbab','كباب','ma2le']),
    ('{"ar":"سمبوسك (للقلي)","en":"Sambousek (to fry)"}',                      5.00, null, 'dozen', 'Lil 2ale', 3,  array['sambousek','sambusak','سمبوسك']),
    ('{"ar":"سمبوسك (مقلي)","en":"Sambousek (fried)"}',                        6.00, null, 'dozen', 'Lil 2ale', 4,  array['sambousek','sambusak','سمبوسك','ma2le']),
    ('{"ar":"رقاقات جبنة (للقلي)","en":"Cheese rolls (to fry)"}',              5.00, null, 'dozen', 'Lil 2ale', 5,  array['rkakat','ra2a2at','رقاقات','jebne','cheese rolls']),
    ('{"ar":"رقاقات جبنة (مقلية)","en":"Cheese rolls (fried)"}',               6.00, null, 'dozen', 'Lil 2ale', 6,  array['rkakat','ra2a2at','رقاقات','jebne','cheese rolls','ma2le']),
    ('{"ar":"رقاقات بالخضار (للقلي)","en":"Vegetable rolls (to fry)"}',        5.00, null, 'dozen', 'Lil 2ale', 7,  array['rkakat','ra2a2at','رقاقات','khodra','vegetable rolls']),
    ('{"ar":"رقاقات بالخضار (مقلية)","en":"Vegetable rolls (fried)"}',         6.00, null, 'dozen', 'Lil 2ale', 8,  array['rkakat','ra2a2at','رقاقات','khodra','vegetable rolls','ma2le']),
    ('{"ar":"سبرينغ رولز (للقلي)","en":"Spring rolls (to fry)"}',              5.00, null, 'dozen', 'Lil 2ale', 9,  array['spring rolls','سبرينغ رول']),
    ('{"ar":"سبرينغ رولز (مقلية)","en":"Spring rolls (fried)"}',               6.00, null, 'dozen', 'Lil 2ale', 10, array['spring rolls','سبرينغ رول','ma2le']),
    ('{"ar":"دزينة بيتزا","en":"Mini pizza (dozen)"}',                         5.00, null, 'dozen', 'Mo3ajjanat', 11, array['pizza','بيتزا']),
    ('{"ar":"دزينة زعتر","en":"Zaatar (dozen)"}',                              4.00, null, 'dozen', 'Mo3ajjanat', 12, array['zaatar','za3tar','زعتر','man2ouche']),
    ('{"ar":"دزينة هوت دوغ","en":"Hot dog (dozen)"}',                          5.00, null, 'dozen', 'Mo3ajjanat', 13, array['hot dog','هوت دوغ']),
    ('{"ar":"دزينة فطائر جبنة","en":"Cheese fatayer (dozen)"}',                5.00, null, 'dozen', 'Mo3ajjanat', 14, array['fatayer','fatayir','فطائر','jebne']),
    ('{"ar":"دزينة لحمة بالعجين","en":"Lahm bi ajeen (dozen)"}',               5.50, null, 'dozen', 'Mo3ajjanat', 15, array['la7me bi 3ajin','lahm bi ajeen','لحم بعجين','sfi7a']),
    ('{"ar":"دزينة فطائر كشك","en":"Kishk fatayer (dozen)"}',                  4.50, null, 'dozen', 'Mo3ajjanat', 16, array['fatayer','فطائر','kechek','kishk','كشك']),
    ('{"ar":"دزينة فطائر سلق","en":"Chard fatayer (dozen)"}',                  5.50, null, 'dozen', 'Mo3ajjanat', 17, array['fatayer','فطائر','sele2','sile2','سلق']),
    ('{"ar":"شيش برك (٤٠ حبة)","en":"Shish barak (40 pcs)"}',                  7.00, null, '40 pcs', 'Akel', 18, array['shish barak','chich barak','شيش برك']),
    ('{"ar":"صينية كبة لحمة","en":"Meat kibbeh tray"}',                        15.00, null, 'tray', 'Akel', 19, array['kebbe','kibbeh','كبة','sayniye','صينية']),
    ('{"ar":"بيتزا لبنانية","en":"Pizza Lebanese"}',                           8.00, null, null, 'Pizza', 20, array['pizza','بيتزا','lebnaniye']),
    ('{"ar":"بيتزا بيبروني","en":"Pizza Pepperoni"}',                          9.00, null, null, 'Pizza', 21, array['pizza','بيتزا','pepperoni','peperoni']),
    ('{"ar":"بيتزا دجاج","en":"Pizza Chicken"}',                               10.00, null, null, 'Pizza', 22, array['pizza','بيتزا','chicken','djej','دجاج']),
    ('{"ar":"عجينة مناقيش (٦ قطع)","en":"Manakish dough (6 pieces)"}',         null, 110000, '6 pcs', 'Ajine', 23, array['3ajine','ajine','عجينة','man2ouche','manakish','مناقيش'])
  ) as v(name, usd, lbp, unit, section, ord, aliases)
  where not exists (select 1 from suqa.products p where p.shop_id = shop and p.name->>'en' = (v.name::jsonb)->>'en');
end $$;

select s.id, s.slug, s.status, c.slug cat,
       (select count(*) from suqa.shop_delivery_zones where shop_id = s.id) zones,
       (select count(*) from suqa.products where shop_id = s.id) items,
       (select price_usd from suqa.products where shop_id = s.id and price_currency = 'lbp') dough_usd
from suqa.shops s join suqa.categories c on c.id = s.category_id where s.slug = 'yummy-kitchen';
