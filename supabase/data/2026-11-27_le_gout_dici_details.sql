-- Data: Le goût d'ici — client's answers (2026-11-27): phone, known as Zeina, Hsarat–Jbeil, Christmas pre-orders, ½ kg options. Idempotent.
do $$
declare t uuid := 'ed1655e4-b41b-47e9-bfba-fded0f51cbc6'; shop uuid; rate numeric;
begin
  select id into shop from suqa.shops where tenant_id = t and slug = 'le-gout-dici';
  select fx_lbp_rate into rate from suqa.tenants where id = t;
  update suqa.shops set phone = '71231708', whatsapp = '71231708',
         known_as = 'زينة', known_as_en = 'Zeina', address_text = 'Hsarat, Jbeil',
         description = '{"ar":"شوكولا بلجيكية، صنع منزلي وباليد. اطلبوا من هلّق لقبل العيد.","en":"Homemade, handmade Belgian chocolate. Order now for Christmas."}'
  where id = shop;

  insert into suqa.products (tenant_id, shop_id, name, description, price_usd, price_currency, price_lbp, unit, unit_kind, decimal_qty, section, visible_online, sort_order, aliases)
  select t, shop, v.name::jsonb, v.descr::jsonb, v.usd, 'usd', round(v.usd * rate)::bigint, '½ kg', 'piece', false, 'Chocolate', true, v.ord, v.aliases
  from (values
    ('{"ar":"شوكولا بلجيكية مشكّلة (نص كيلو)","en":"Belgian chocolate, assorted (½ kg)"}',
     '{"ar":"حبات ذهبية وحبات ملفوفة، صنع منزلي.","en":"Gold-dusted gems and swirls, homemade."}',
     30.00, 2, array['chocolat','chocolate','choco','شوكولا','شوكولاتة','belgian','belge','nos kilo','half']),
    ('{"ar":"شوكولا بلجيكية حمراء وبنية (نص كيلو)","en":"Belgian chocolate, red & brown gems (½ kg)"}',
     '{"ar":"حبات ماسية حمراء وبنية، صنع منزلي.","en":"Red and milk-chocolate diamond gems, homemade."}',
     35.00, 4, array['chocolat','chocolate','choco','شوكولا','شوكولاتة','belgian','belge','red','a7mar','nos kilo','half'])
  ) as v(name, descr, usd, ord, aliases)
  where not exists (select 1 from suqa.products p where p.shop_id = shop and p.name->>'en' = (v.name::jsonb)->>'en');
  -- order: assorted 1 kg, ½ kg, red & brown 1 kg, ½ kg, tree, dragées
  update suqa.products p set sort_order = o.n from (values
    ('Belgian chocolate, assorted',1),('Belgian chocolate, assorted (½ kg)',2),
    ('Belgian chocolate, red & brown gems',3),('Belgian chocolate, red & brown gems (½ kg)',4),
    ('Christmas tree, Belgian chocolate',5),('Almond dragées',6)) o(en, n)
  where p.shop_id = shop and p.name->>'en' = o.en;
end $$;
select s.phone, s.known_as, s.known_as_en, s.address_text, s.description->>'en' d, s.status,
  (select string_agg(p.name->>'en'||' $'||p.price_usd||' / '||p.unit, '; ' order by p.sort_order) from suqa.products p where p.shop_id=s.id) items
from suqa.shops s where slug='le-gout-dici';
