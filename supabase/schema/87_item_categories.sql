-- 87_item_categories.sql — one shared list of item categories (English + Arabic) for all shops, and every item moved onto it.   (2026-11-20)
--
-- WHY: an item's category was free text typed per shop (products.section): 98 different ones on prod, almost none shared
-- ("Drinks" / "مشروبات" / "SYRO JUS/SOFTDR"), Dekanet Jadde alone had 55 supplier codes, and each shop translated its own.
--
-- NOW:
--   * suqa.item_categories — the shared list per association: key (what products.section holds), name {en, ar}, order.
--     Everyone may read it (the storefront shows the names); the association's admins edit it (Admin → Categories).
--   * suqa.item_category_add(shop, en, ar) — a shop's owner / stock keeper (or an admin) adds a category that is missing
--     (a clothes shop tomorrow: "Men's Clothing"). It joins the shared list at once, for every shop. The same name again
--     (either language, any spelling of case / accents) returns the existing one, never a double.
--   * ONE FLAT, DETAILED list (100 categories): a shop's section keeps its own level of detail — "Shampoo & Conditioner",
--     "Deodorants", "Toothpaste", "Ketchup"… stay separate, because search and Yorgo read the category name. Only the same
--     thing written differently is merged ("سلطات" / "Salads", "Argile" / "Nargile", "صحن" / "Plates", "بيتزا" / "Pizza").
--     Mixed sections are split by the item's own name: "SYRO JUS/SOFTDR" → Juices / Instant Drinks / Soft Drinks.
--     Dekanet Jadde's "AIR REFRESHNING" (115 mixed items: olives, chips, candy, vape…) → "Other", for the shop to sort.
--     A few items plainly in the wrong section are put right (a conditioner under cheese, a mayonnaise under mustard…).
--     A section this script does not know stays as it is and is added to the list under its own name (nothing is lost).
--   * suqa.item_category_moves — every item this script moves, with its OLD section, so a move can be undone:
--       update suqa.products p set section = m.old_section from suqa.item_category_moves m where m.product_id = p.id and p.shop_id = '<shop>';
--   products.section stays the column that holds the category (its key), so the tills, the reports, the search and Yorgo keep
--   working unchanged; shops.section_names (74) is no longer read once a category is in the shared list.
--
-- Table changes: NEW tables suqa.item_categories, suqa.item_category_moves. Data: products.section rewritten for the mapped
-- sections (the tills receive the change on their next sync). Idempotent: running it again changes nothing.

create table if not exists suqa.item_categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references suqa.tenants(id) on delete cascade,
  key         text not null,                                  -- what products.section holds; never changes once used
  name        jsonb not null,                                 -- { "en": "…", "ar": "…" }
  sort_order  int  not null default 10000,
  created_by  uuid,
  created_shop uuid references suqa.shops(id) on delete set null,   -- the shop that added it (null = seeded / admin)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint item_categories_key_unique unique (tenant_id, key),
  constraint item_categories_key_size check (length(key) between 1 and 60),
  constraint item_categories_name_obj check (jsonb_typeof(name) = 'object' and length(name::text) <= 300)
);
alter table suqa.item_categories enable row level security;
grant select on suqa.item_categories to anon, authenticated;
grant insert, update, delete on suqa.item_categories to authenticated;
drop policy if exists item_categories_read on suqa.item_categories;
create policy item_categories_read on suqa.item_categories for select to anon, authenticated using (true);
drop policy if exists item_categories_write on suqa.item_categories;
create policy item_categories_write on suqa.item_categories for all to authenticated
  using (suqa.is_tenant_member(tenant_id)) with check (suqa.is_tenant_member(tenant_id));

create or replace function suqa.item_category_add(p_shop uuid, p_en text, p_ar text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_role text; v_en text := nullif(left(trim(regexp_replace(coalesce(p_en, ''), '\s+', ' ', 'g')), 60), '');
        v_ar text := nullif(left(trim(regexp_replace(coalesce(p_ar, ''), '\s+', ' ', 'g')), 60), ''); v_key text; r record;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  select tenant_id into v_tenant from suqa.shops where id = p_shop;
  if v_tenant is null then raise exception 'no_shop'; end if;
  v_role := suqa.pos_role(p_shop);
  if not (suqa.is_tenant_member(v_tenant) or coalesce(v_role, '') in ('owner', 'stock', 'setup')) then raise exception 'not_shop_staff'; end if;
  if v_en is null and v_ar is null then raise exception 'name_required'; end if;
  v_key := coalesce(v_en, v_ar);
  -- the same category already there (by key or by either name, whatever the case, accents or spelling of hamza…)
  select c.key, c.name into r from suqa.item_categories c
   where c.tenant_id = v_tenant
     and (lower(c.key) = lower(v_key)
          or suqa.norm_text(c.name->>'en') in (suqa.norm_text(v_en), suqa.norm_text(v_ar))
          or suqa.norm_text(c.name->>'ar') in (suqa.norm_text(v_en), suqa.norm_text(v_ar)))
     and coalesce(suqa.norm_text(coalesce(v_en, v_ar)), '') <> ''
   order by c.sort_order limit 1;
  if r.key is not null then return jsonb_build_object('key', r.key, 'name', r.name, 'existing', true); end if;
  insert into suqa.item_categories (tenant_id, key, name, sort_order, created_by, created_shop)
  values (v_tenant, v_key, jsonb_build_object('en', coalesce(v_en, v_ar), 'ar', coalesce(v_ar, v_en)),
          coalesce((select max(sort_order) from suqa.item_categories where tenant_id = v_tenant), 0) + 10, auth.uid(), p_shop);
  return jsonb_build_object('key', v_key, 'name', jsonb_build_object('en', coalesce(v_en, v_ar), 'ar', coalesce(v_ar, v_en)), 'existing', false);
end $$;
revoke all on function suqa.item_category_add(uuid, text, text) from public, anon;
grant execute on function suqa.item_category_add(uuid, text, text) to authenticated;

-- ---------- the shared list, for every association ----------
insert into suqa.item_categories (tenant_id, key, name, sort_order)
select t.id, v.key, jsonb_build_object('en', v.key, 'ar', v.ar), v.ord
from suqa.tenants t cross join (values
    (10, 'Fruits & Vegetables', 'خضار وفواكه'),
    (20, 'Bread & Bakery', 'خبز ومخبوزات'),
    (30, 'Toast & Crackers', 'توست وكراكرز'),
    (40, 'Dairy & Eggs', 'ألبان وأجبان وبيض'),
    (50, 'Packaged Cheese', 'أجبان معلّبة'),
    (60, 'Cheese & Cold Cuts', 'أجبان ومرتديلا'),
    (70, 'Beef', 'لحم بقر'),
    (80, 'Lamb', 'لحم غنم'),
    (90, 'Poultry', 'دجاج'),
    (100, 'Grains, Pulses & Spices', 'حبوب وبقول وبهارات'),
    (110, 'Pantry (Mouneh)', 'مونة'),
    (120, 'Pasta', 'معكرونة'),
    (130, 'Soups & Noodles', 'شوربات ونودلز'),
    (140, 'Canned Food', 'معلبات'),
    (150, 'Cooking Oils & Butter', 'زيوت وسمنة وزبدة'),
    (160, 'Olive Oil', 'زيت زيتون'),
    (170, 'Sauces', 'صلصات'),
    (180, 'Ketchup', 'كاتشب'),
    (190, 'Mayonnaise', 'مايونيز'),
    (200, 'Mustard', 'خردل'),
    (210, 'Vinegar & Pickles', 'خل ومخللات'),
    (220, 'Milk & Cereals', 'حليب وحبوب فطور'),
    (230, 'Tahini & Halawa', 'طحينة وحلاوة'),
    (240, 'Diet Products', 'منتجات حمية'),
    (250, 'Chips & Nuts', 'تشيبس ومكسرات'),
    (260, 'Nuts', 'مكسرات'),
    (270, 'Chocolate, Biscuits & Candy', 'شوكولا وبسكويت وسكاكر'),
    (280, 'Cakes, Desserts & Baking', 'كيك وحلويات ولوازم الحلو'),
    (290, 'Arabic Sweets', 'حلويات عربية'),
    (300, 'Ice Cream', 'بوظة'),
    (310, 'Coffee', 'قهوة'),
    (320, 'Tea & Herbal Teas', 'شاي وزهورات'),
    (330, 'Water', 'مياه'),
    (340, 'Juices', 'عصائر'),
    (350, 'Soft Drinks', 'مشروبات غازية'),
    (360, 'Instant Drinks', 'شراب بودرة'),
    (370, 'Drinks', 'مشروبات'),
    (380, 'Alcoholic Drinks', 'مشروبات كحولية'),
    (390, 'Tobacco', 'دخان'),
    (400, 'Lighters, Gas & Charcoal', 'ولاعات وغاز وفحم'),
    (410, 'Argile', 'أراكيل'),
    (420, 'Argile Tobacco (Maassel)', 'معسّل'),
    (430, 'Argile Charcoal', 'فحم أراكيل'),
    (440, 'Vitamins', 'فيتامينات'),
    (450, 'Pain Relief', 'مسكّنات'),
    (460, 'Baby Care', 'مستلزمات أطفال'),
    (470, 'Hygiene & Sanitizers', 'تعقيم ونظافة'),
    (480, 'Skin Care', 'عناية بالبشرة'),
    (490, 'Detergents & Disinfectants', 'منظفات ومعقمات'),
    (500, 'Tissues, Wipes & Pads', 'محارم ومناديل مبللة وفوط'),
    (510, 'Air Fresheners', 'معطرات جو'),
    (520, 'Insect Control', 'مبيدات حشرات'),
    (530, 'Household', 'أدوات منزلية'),
    (540, 'Disposable Plates & Cups', 'صحون وأكواب بلاستيك'),
    (550, 'Candles', 'شموع'),
    (560, 'Shampoo & Conditioner', 'شامبو وبلسم'),
    (570, 'Deodorants', 'مزيلات عرق'),
    (580, 'Shaving', 'حلاقة'),
    (590, 'Soap & Hand Wash', 'صابون وغسول يدين'),
    (600, 'Toothpaste', 'معجون أسنان'),
    (610, 'Toothbrushes', 'فراشي أسنان'),
    (620, 'Cosmetics & Body Care', 'مستحضرات تجميل وعناية'),
    (630, 'Hair Colour', 'صبغات شعر'),
    (640, 'Batteries', 'بطاريات'),
    (650, 'Electrical', 'كهربائيات'),
    (660, 'Phones & Accessories', 'هواتف وإكسسوارات'),
    (670, 'Salads', 'سلطات'),
    (680, 'Starters', 'مقبلات'),
    (690, 'Sides', 'أطباق جانبية'),
    (700, 'Manakish', 'مناقيش'),
    (710, 'Zaatar Manakish', 'مناقيش زعتر'),
    (720, 'Cheese & Meat Manakish', 'مناقيش جبنة ولحمة'),
    (730, 'Dough Pies & Pizza', 'معجنات وبيتزا'),
    (740, 'Pastries (Mouajjanat)', 'معجنات'),
    (750, 'Dough', 'عجين'),
    (760, 'Kaak', 'كعك'),
    (770, 'Pizza', 'بيتزا'),
    (780, 'Sandwiches', 'سندويشات'),
    (790, 'Subs', 'ساب'),
    (800, 'Snack', 'سناك'),
    (810, 'Burritos', 'بوريتو'),
    (820, 'Plates', 'صحون'),
    (830, 'Home Cooking', 'أكل بيتي'),
    (840, 'Ready to Fry', 'جاهز للقلي'),
    (850, 'Sushi Cakes', 'كيك سوشي'),
    (860, 'Sashimi', 'ساشيمي'),
    (870, 'Salmon Sets', 'سيتات سلمون'),
    (880, 'Crab Sets', 'سيتات كراب'),
    (890, 'Mix Sets', 'سيتات مشكّلة'),
    (900, 'Seeds', 'بذور'),
    (910, 'Fertilizers, Pesticides & Soil', 'أسمدة ومبيدات وتراب'),
    (920, 'Irrigation', 'ريّ'),
    (930, 'Machines', 'مكنات'),
    (940, 'Tools & Spare Parts', 'عدّة وقطع غيار'),
    (950, 'Tanks, Containers & Shade Nets', 'خزانات وأوعية وشبك'),
    (960, 'Beekeeping', 'عدّة نحل'),
    (970, 'Pest Control (Public Health)', 'مكافحة حشرات وقوارض'),
    (980, 'Oils & Lubricants', 'زيوت وشحوم'),
    (990, 'Olive Harvest & Sacks', 'مدّات زيتون وأكياس'),
    (1000, 'Other', 'متفرقات')
) as v(ord, key, ar)
on conflict (tenant_id, key) do nothing;

-- ---------- where every item came from (for undo) ----------
create table if not exists suqa.item_category_moves (
  product_id   uuid primary key references suqa.products(id) on delete cascade,
  tenant_id    uuid not null references suqa.tenants(id) on delete cascade,
  shop_id      uuid not null references suqa.shops(id) on delete cascade,
  old_section  text not null,
  new_section  text not null,
  moved_at     timestamptz not null default now()
);
create index if not exists item_category_moves_shop_idx on suqa.item_category_moves (shop_id);
alter table suqa.item_category_moves enable row level security;   -- no policies: kept for undo, read by the service role only
revoke all on suqa.item_category_moves from public, anon, authenticated;

-- ---------- every item onto the shared list ----------
-- the new category of each item: by its own name where a section was mixed or the item was plainly misplaced, else by its section
drop table if exists pg_temp.cat_moves;
create temp table cat_moves as
select p.id, p.tenant_id, p.shop_id, p.section as old,
       case
         when p.section = 'SYRO JUS/SOFTDR' and x.n ~ 'master'                                                  then 'Chips & Nuts'
         when p.section = 'SYRO JUS/SOFTDR' and x.n ~ '(darina|inst\.)'                                         then 'Instant Drinks'
         when p.section = 'SYRO JUS/SOFTDR' and x.n ~ '(juice|juicy|jus|juis|nectar|original|x-tra|عصير|نكتار)' then 'Juices'
         when p.section = 'FROMAGE/CHARCUT' and x.n ~ '(^| )cond'                                               then 'Shampoo & Conditioner'
         when p.section = 'CREME COLORANT'  and x.n ~ '(^| )sh\.'                                               then 'Shampoo & Conditioner'
         when p.section = 'MUSTARD'         and x.n ~ 'mayonnaise'                                              then 'Mayonnaise'
         when p.section = 'OLIVE OIL'       and x.n ~ 'sunflower'                                               then 'Cooking Oils & Butter'
         else m.new
       end as new
from suqa.products p
cross join lateral (select lower(coalesce(p.name->>'en', '') || ' ' || coalesce(p.name->>'ar', '')) as n) x
left join (values
    ('Produce', 'Fruits & Vegetables'),
    ('Bakery', 'Bread & Bakery'),
    ('TOAST/CRAC/BKRL', 'Toast & Crackers'),
    ('Dairy', 'Dairy & Eggs'),
    ('FROMAGE/SELFSERV.', 'Packaged Cheese'),
    ('FROMAGE/CHARCUT', 'Cheese & Cold Cuts'),
    ('HBOUB/TAMR SPIC', 'Grains, Pulses & Spices'),
    ('Pantry', 'Pantry (Mouneh)'),
    ('PASTA', 'Pasta'),
    ('SOUPE', 'Soups & Noodles'),
    ('CONSERVE', 'Canned Food'),
    ('BUTTER/OIL', 'Cooking Oils & Butter'),
    ('OLIVE OIL', 'Olive Oil'),
    ('SAUCE', 'Sauces'),
    ('KETCHUP', 'Ketchup'),
    ('MAYONNAISE', 'Mayonnaise'),
    ('MUSTARD', 'Mustard'),
    ('VINAIGRE/PICKEL', 'Vinegar & Pickles'),
    ('LAIT/BLED/CEREA', 'Milk & Cereals'),
    ('TAHINEH/HALAWA', 'Tahini & Halawa'),
    ('DIETHETIQUE', 'Diet Products'),
    ('PISTACHERIE', 'Chips & Nuts'),
    ('NUTS&CANDIES/KG', 'Nuts'),
    ('CHOBISC/GUM/BON', 'Chocolate, Biscuits & Candy'),
    ('Chocolates', 'Chocolate, Biscuits & Candy'),
    ('SWEET/CAKE/GELO', 'Cakes, Desserts & Baking'),
    ('Sweets', 'Arabic Sweets'),
    ('ICE CREAM', 'Ice Cream'),
    ('COFFEE', 'Coffee'),
    ('TEA/ZHOURAT', 'Tea & Herbal Teas'),
    ('WATER', 'Water'),
    ('SYRO JUS/SOFTDR', 'Soft Drinks'),
    ('مشروبات', 'Drinks'),
    ('ALCOOL', 'Alcoholic Drinks'),
    ('TABAC', 'Tobacco'),
    ('ALLUMET/GAZ/FHM', 'Lighters, Gas & Charcoal'),
    ('ALLUMETTE', 'Lighters, Gas & Charcoal'),
    ('Nargile', 'Argile'),
    ('Ma3asel', 'Argile Tobacco (Maassel)'),
    ('Fahem', 'Argile Charcoal'),
    ('Pain relief', 'Pain Relief'),
    ('Baby', 'Baby Care'),
    ('Hygiene', 'Hygiene & Sanitizers'),
    ('Skin care', 'Skin Care'),
    ('DETERG/ANTISEPT', 'Detergents & Disinfectants'),
    ('WIPES/PADS/CLIN', 'Tissues, Wipes & Pads'),
    ('ANTI-INSECT', 'Insect Control'),
    ('HOUSEHOLD', 'Household'),
    ('PLASTIC', 'Disposable Plates & Cups'),
    ('CANDLE', 'Candles'),
    ('SHAMPO/CONDITOI', 'Shampoo & Conditioner'),
    ('DEODORANT', 'Deodorants'),
    ('SHAVING', 'Shaving'),
    ('SOAP', 'Soap & Hand Wash'),
    ('DENTIFRICE', 'Toothpaste'),
    ('TOOTH BRUSH', 'Toothbrushes'),
    ('COSMETICS', 'Cosmetics & Body Care'),
    ('CREME COLORANT', 'Hair Colour'),
    ('BATERY/FILM CAM', 'Batteries'),
    ('ELECTRICITY', 'Electrical'),
    ('سلطات', 'Salads'),
    ('فرن', 'Manakish'),
    ('Mo3ajjanat', 'Pastries (Mouajjanat)'),
    ('Ajine', 'Dough'),
    ('بيتزا', 'Pizza'),
    ('ساب', 'Subs'),
    ('سناك', 'Snack'),
    ('صحن', 'Plates'),
    ('Akel', 'Home Cooking'),
    ('Lil 2ale', 'Ready to Fry'),
    ('AIR REFRESHNING', 'Other'),
    ('ALL TYPES', 'Other'),
    ('Others', 'Other')
) as m(old, new) on m.old = p.section;

insert into suqa.item_category_moves (product_id, tenant_id, shop_id, old_section, new_section)
select id, tenant_id, shop_id, old, new from cat_moves where new is not null and new <> old
on conflict (product_id) do nothing;                                -- run again: the first (original) section is the one kept

update suqa.products p set section = c.new from cat_moves c where c.id = p.id and c.new is not null and c.new <> c.old;
drop table cat_moves;

-- a section this script does not know: kept, and listed under its own name (the shop's own translation when it gave one)
insert into suqa.item_categories (tenant_id, key, name, sort_order, created_shop)
select distinct on (p.tenant_id, p.section) p.tenant_id, p.section,
       jsonb_build_object('en', coalesce(nullif(s.section_names->p.section->>'en', ''), p.section), 'ar', coalesce(nullif(s.section_names->p.section->>'ar', ''), p.section)),
       9000, p.shop_id
from suqa.products p join suqa.shops s on s.id = p.shop_id
where coalesce(trim(p.section), '') <> '' and length(p.section) <= 60
  and not exists (select 1 from suqa.item_categories c where c.tenant_id = p.tenant_id and c.key = p.section)
order by p.tenant_id, p.section, p.shop_id
on conflict (tenant_id, key) do nothing;

select 'item categories installed' as result,
       (select count(*) from suqa.item_categories) as categories,
       (select count(*) from suqa.item_category_moves) as items_moved,
       (select count(distinct section) from suqa.products where is_active) as sections_in_use,
       (select count(*) from suqa.products p where p.is_active and coalesce(trim(p.section), '') <> ''
          and not exists (select 1 from suqa.item_categories c where c.tenant_id = p.tenant_id and c.key = p.section)) as items_outside_the_list;
