-- 88_dekanet_other_items.sql — Dekanet Jadde's mixed "Other" items put in their real categories, item by item.   (2026-11-20)
--
-- WHY: the shop kept 115 unrelated items under "AIR REFRESHNING" (olives, chips, candy, vape, soap…) and 11 under "Others" /
-- "ALL TYPES". Script 87 moved them all to "Other" so that a search for air fresheners would not return olives.
--
-- NOW: each of those items is matched by its own name to a shared category (114 items, the table below):
--   the 14 car / home scents go back to "Air Fresheners"; canned food, olives, rice, chips, candy, water, deodorants… to theirs.
--   Two categories are new on the shared list: "Vapes" (فيب) and "Ice" (ثلج).
--   12 items whose name does not say what they are stay in "Other" for the shop to sort:
--     lahme, pizza, chilli and lemon, DIPLOKO MOLA, SILCA (3 flavours), crystal 400, DISPENSER MARS, FRUITS MANGO, dispo tech,
--     CARTE SUPERFINE (playing cards).
--   Only items that 87 itself moved to "Other" from those three old sections are touched (suqa.item_category_moves), matched on
--   the English name — so it does the same on dev and on prod, and never touches an item the shop has re-filed since.
--   The old section stays recorded in item_category_moves (undo as in 87).
--
-- Table changes: none. Data: 2 rows added to suqa.item_categories per association; products.section of the items below.
-- Idempotent: running it again changes nothing.

insert into suqa.item_categories (tenant_id, key, name, sort_order)
select t.id, v.key, jsonb_build_object('en', v.key, 'ar', v.ar), v.ord
from suqa.tenants t cross join (values (335, 'Ice', 'ثلج'), (395, 'Vapes', 'فيب')) as v(ord, key, ar)
on conflict (tenant_id, key) do nothing;

drop table if exists pg_temp.other_fix;
create temp table other_fix as
select p.id, v.new
from suqa.products p
join suqa.item_category_moves m on m.product_id = p.id and m.old_section in ('AIR REFRESHNING', 'ALL TYPES', 'Others')
join (values
    ('black ice', 'Air Fresheners'),
    ('buble gum', 'Air Fresheners'),
    ('candy', 'Air Fresheners'),
    ('cherry', 'Air Fresheners'),
    ('coconut', 'Air Fresheners'),
    ('flowe garden', 'Air Fresheners'),
    ('jasmin', 'Air Fresheners'),
    ('mango', 'Air Fresheners'),
    ('ocean', 'Air Fresheners'),
    ('papaya', 'Air Fresheners'),
    ('pine', 'Air Fresheners'),
    ('plume', 'Air Fresheners'),
    ('spring', 'Air Fresheners'),
    ('tropez', 'Air Fresheners'),
    ('ananas', 'Canned Food'),
    ('ananas pui dor', 'Canned Food'),
    ('foul mdamas', 'Canned Food'),
    ('fweke mchakale', 'Canned Food'),
    ('halyoun akhdar', 'Canned Food'),
    ('leb l nakhel', 'Canned Food'),
    ('offre chmandar', 'Canned Food'),
    ('offre foter', 'Canned Food'),
    ('offre tuna', 'Canned Food'),
    ('tuna zet offre', 'Canned Food'),
    ('sardine har', 'Canned Food'),
    ('taj sardin 7ar', 'Canned Food'),
    ('taj sardin 7elo', 'Canned Food'),
    ('top nitch zghire', 'Canned Food'),
    ('top notch', 'Canned Food'),
    ('kornichon', 'Vinegar & Pickles'),
    ('zaitoun aswad', 'Vinegar & Pickles'),
    ('zaitoun har', 'Vinegar & Pickles'),
    ('zaitoun w jazar', 'Vinegar & Pickles'),
    ('zaitoun w zaatar', 'Vinegar & Pickles'),
    ('offre diamond', 'Grains, Pulses & Spices'),
    ('rez ahmar', 'Grains, Pulses & Spices'),
    ('rez american offer', 'Grains, Pulses & Spices'),
    ('rez aswad', 'Grains, Pulses & Spices'),
    ('pasta', 'Pasta'),
    ('nouille', 'Soups & Noodles'),
    ('ketchup white bell', 'Ketchup'),
    ('buffies sweet', 'Chips & Nuts'),
    ('curvy 7ar', 'Chips & Nuts'),
    ('curvy ketchuup', 'Chips & Nuts'),
    ('curvy pizza', 'Chips & Nuts'),
    ('karkech meleh kbir', 'Chips & Nuts'),
    ('karkich', 'Chips & Nuts'),
    ('karkich cocktail', 'Chips & Nuts'),
    ('kettle black pepper', 'Chips & Nuts'),
    ('kettle honey mustard', 'Chips & Nuts'),
    ('kettle khal kbir', 'Chips & Nuts'),
    ('kettle meleh kbir', 'Chips & Nuts'),
    ('kettle olive', 'Chips & Nuts'),
    ('kettle zaatar', 'Chips & Nuts'),
    ('krakech cheese ball kbir', 'Chips & Nuts'),
    ('master cones', 'Chips & Nuts'),
    ('master hot spicy', 'Chips & Nuts'),
    ('master khal', 'Chips & Nuts'),
    ('sitos kbir', 'Chips & Nuts'),
    ('sitos kbir har w helou', 'Chips & Nuts'),
    ('sitos onion', 'Chips & Nuts'),
    ('castania 15g corn cheese/barb', 'Chips & Nuts'),
    ('master chips buffies cheese balls 70g', 'Chips & Nuts'),
    ('festok', 'Nuts'),
    ('digestive zghir', 'Chocolate, Biscuits & Candy'),
    ('dxb chocolat', 'Chocolate, Biscuits & Candy'),
    ('espreso bobon', 'Chocolate, Biscuits & Candy'),
    ('extra refrecher strawbery lemon', 'Chocolate, Biscuits & Candy'),
    ('eye ball', 'Chocolate, Biscuits & Candy'),
    ('eyeball soft candy', 'Chocolate, Biscuits & Candy'),
    ('kinder bueno', 'Chocolate, Biscuits & Candy'),
    ('lollo posps', 'Chocolate, Biscuits & Candy'),
    ('lolly pop', 'Chocolate, Biscuits & Candy'),
    ('mint candy', 'Chocolate, Biscuits & Candy'),
    ('pizza jelly', 'Chocolate, Biscuits & Candy'),
    ('snickers coffe', 'Chocolate, Biscuits & Candy'),
    ('snickers xtreme', 'Chocolate, Biscuits & Candy'),
    ('twix tiramisou', 'Chocolate, Biscuits & Candy'),
    ('waffle blueberry', 'Chocolate, Biscuits & Candy'),
    ('waffle kinder', 'Chocolate, Biscuits & Candy'),
    ('waffle lotus', 'Chocolate, Biscuits & Candy'),
    ('waffle oreo', 'Chocolate, Biscuits & Candy'),
    ('waffle strawberry', 'Chocolate, Biscuits & Candy'),
    ('caramel cakee', 'Cakes, Desserts & Baking'),
    ('roni choclt', 'Ice Cream'),
    ('roni milk', 'Ice Cream'),
    ('xtra aple redd', 'Juices'),
    ('xtra apple', 'Juices'),
    ('nasma 0.5 littre', 'Water'),
    ('nasma 1.5 litre', 'Water'),
    ('tannourine 1.5l', 'Water'),
    ('sakr ice 2kg', 'Ice'),
    ('colgate optic white', 'Toothpaste'),
    ('cosmo leave in', 'Cosmetics & Body Care'),
    ('cosmo leave in 2', 'Cosmetics & Body Care'),
    ('cosmo leave in 3', 'Cosmetics & Body Care'),
    ('dove care', 'Deodorants'),
    ('dove men cool fresh', 'Deodorants'),
    ('dove original limited edition', 'Deodorants'),
    ('dove pomegranate', 'Deodorants'),
    ('dove talc soft', 'Deodorants'),
    ('hayat boudra', 'Detergents & Disinfectants'),
    ('hayat dawa jale hamod', 'Detergents & Disinfectants'),
    ('hayat dawa jale tefe7', 'Detergents & Disinfectants'),
    ('liffet jale', 'Household'),
    ('sanita argile yahya', 'Household'),
    ('coco al masa', 'Lighters, Gas & Charcoal'),
    ('fahem chawe 2', 'Lighters, Gas & Charcoal'),
    ('fakher na3na3', 'Argile Tobacco (Maassel)'),
    ('vape blubery ice', 'Vapes'),
    ('vape lemon mint', 'Vapes'),
    ('vape passion fruit', 'Vapes'),
    ('vape peach mango', 'Vapes'),
    ('vape watermalon', 'Vapes')
) as v(en, new) on v.en = lower(trim(regexp_replace(p.name->>'en', '\s+', ' ', 'g')))
where p.section = 'Other'
  and exists (select 1 from suqa.item_categories c where c.tenant_id = p.tenant_id and c.key = v.new);

update suqa.products p set section = f.new from other_fix f where f.id = p.id;
update suqa.item_category_moves m set new_section = f.new from other_fix f where f.id = m.product_id;
drop table other_fix;

select 'dekanet other items filed' as result,
       (select count(*) from suqa.products p join suqa.item_category_moves m on m.product_id = p.id
         where m.old_section in ('AIR REFRESHNING', 'ALL TYPES', 'Others') and p.section <> 'Other') as filed,
       (select count(*) from suqa.products p join suqa.item_category_moves m on m.product_id = p.id
         where m.old_section in ('AIR REFRESHNING', 'ALL TYPES', 'Others') and p.section = 'Other') as left_in_other;
