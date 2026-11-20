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
--   * 52 categories seeded, and every item moved from its old section to its shared category (the table below).
--     "SYRO JUS/SOFTDR" is split by the item's name: juices → "Juices", the rest → "Soft Drinks".
--     A section this script does not know stays as it is and is added to the list under its own name (nothing is lost).
--   products.section stays the column that holds the category (its key), so the tills, the reports, the search and Yorgo keep
--   working unchanged; shops.section_names (74) is no longer read once a category is in the shared list.
--
-- Table changes: NEW table suqa.item_categories. Data: products.section rewritten for the mapped sections (the tills receive
-- the change on their next sync). Idempotent: running it again changes nothing.

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
    (30, 'Dairy & Eggs', 'ألبان وأجبان وبيض'),
    (40, 'Meat & Cold Cuts', 'لحوم ومرتديلا'),
    (50, 'Grains, Pulses & Spices', 'حبوب وبقول وبهارات'),
    (60, 'Pasta & Soups', 'معكرونة وشوربات'),
    (70, 'Canned Food', 'معلبات'),
    (80, 'Oils & Butter', 'زيوت وسمنة'),
    (90, 'Sauces & Pickles', 'صلصات ومخللات'),
    (100, 'Breakfast & Spreads', 'فطور ومربيات'),
    (110, 'Chips & Nuts', 'تشيبس ومكسرات'),
    (120, 'Chocolate, Biscuits & Candy', 'شوكولا وبسكويت وسكاكر'),
    (130, 'Desserts & Sweets', 'حلويات'),
    (140, 'Ice Cream', 'بوظة'),
    (150, 'Coffee & Tea', 'قهوة وشاي'),
    (160, 'Water', 'مياه'),
    (170, 'Juices', 'عصائر'),
    (180, 'Soft Drinks', 'مشروبات غازية'),
    (190, 'Drinks', 'مشروبات'),
    (200, 'Alcoholic Drinks', 'مشروبات كحولية'),
    (210, 'Tobacco, Argile & Charcoal', 'دخان وأراكيل وفحم'),
    (220, 'Health & Pharmacy', 'صحة وصيدلية'),
    (230, 'Baby', 'أطفال'),
    (240, 'Cleaning & Detergents', 'منظفات ومعقمات'),
    (250, 'Tissues, Wipes & Pads', 'محارم ومناديل وفوط'),
    (260, 'Air Fresheners & Insect Control', 'معطرات ومبيدات حشرات'),
    (270, 'Household & Disposables', 'أدوات منزلية وبلاستيك'),
    (280, 'Personal Care', 'عناية شخصية'),
    (290, 'Batteries & Electrical', 'بطاريات وكهربائيات'),
    (300, 'Phones & Accessories', 'هواتف وإكسسوارات'),
    (310, 'Starters & Salads', 'مقبلات وسلطات'),
    (320, 'Manakish & Pastries', 'مناقيش ومعجنات'),
    (330, 'Pizza', 'بيتزا'),
    (340, 'Sandwiches & Snacks', 'سندويشات وسناك'),
    (350, 'Plates & Meals', 'أطباق ووجبات'),
    (360, 'Ready to Fry', 'جاهز للقلي'),
    (370, 'Sushi Cakes', 'كيك سوشي'),
    (380, 'Sashimi', 'ساشيمي'),
    (390, 'Salmon Sets', 'سيتات سلمون'),
    (400, 'Crab Sets', 'سيتات كراب'),
    (410, 'Mix Sets', 'سيتات مشكّلة'),
    (420, 'Seeds', 'بذور'),
    (430, 'Fertilizers, Pesticides & Soil', 'أسمدة، مبيدات وتراب'),
    (440, 'Irrigation', 'ريّ'),
    (450, 'Machines', 'مكنات'),
    (460, 'Tools & Spare Parts', 'عدّة وقطع غيار'),
    (470, 'Tanks, Containers & Shade Nets', 'خزانات، أوعية وشبك'),
    (480, 'Beekeeping', 'عدّة نحل'),
    (490, 'Pest Control (Public Health)', 'صحة عامة'),
    (500, 'Oils & Lubricants', 'زيوت وشحوم'),
    (510, 'Olive Harvest & Sacks', 'مدّات زيتون وأكياس'),
    (520, 'Other', 'متفرقات')
) as v(ord, key, ar)
on conflict (tenant_id, key) do nothing;

-- ---------- every item onto the shared list ----------
-- juices out of the mixed soft-drinks section, by the item's own name
update suqa.products p set section = 'Juices'
 where p.section = 'SYRO JUS/SOFTDR'
   and (suqa.norm_text(coalesce(p.name->>'ar', '') || ' ' || coalesce(p.name->>'en', '')) ~ '(^| )(juice|juices|juicy|jus|nectar|عصير|عصاير|نكتار)( |$)');

update suqa.products p set section = m.new
from (values
    ('Produce', 'Fruits & Vegetables'),
    ('Bakery', 'Bread & Bakery'),
    ('TOAST/CRAC/BKRL', 'Bread & Bakery'),
    ('Kaak', 'Bread & Bakery'),
    ('Dairy', 'Dairy & Eggs'),
    ('FROMAGE/SELFSERV.', 'Dairy & Eggs'),
    ('FROMAGE/CHARCUT', 'Meat & Cold Cuts'),
    ('Beef', 'Meat & Cold Cuts'),
    ('Lamb', 'Meat & Cold Cuts'),
    ('Poultry', 'Meat & Cold Cuts'),
    ('HBOUB/TAMR SPIC', 'Grains, Pulses & Spices'),
    ('Pantry', 'Grains, Pulses & Spices'),
    ('PASTA', 'Pasta & Soups'),
    ('SOUPE', 'Pasta & Soups'),
    ('CONSERVE', 'Canned Food'),
    ('BUTTER/OIL', 'Oils & Butter'),
    ('OLIVE OIL', 'Oils & Butter'),
    ('SAUCE', 'Sauces & Pickles'),
    ('KETCHUP', 'Sauces & Pickles'),
    ('MAYONNAISE', 'Sauces & Pickles'),
    ('MUSTARD', 'Sauces & Pickles'),
    ('VINAIGRE/PICKEL', 'Sauces & Pickles'),
    ('LAIT/BLED/CEREA', 'Breakfast & Spreads'),
    ('TAHINEH/HALAWA', 'Breakfast & Spreads'),
    ('PISTACHERIE', 'Chips & Nuts'),
    ('NUTS&CANDIES/KG', 'Chips & Nuts'),
    ('CHOBISC/GUM/BON', 'Chocolate, Biscuits & Candy'),
    ('Chocolates', 'Chocolate, Biscuits & Candy'),
    ('SWEET/CAKE/GELO', 'Desserts & Sweets'),
    ('Sweets', 'Desserts & Sweets'),
    ('ICE CREAM', 'Ice Cream'),
    ('COFFEE', 'Coffee & Tea'),
    ('TEA/ZHOURAT', 'Coffee & Tea'),
    ('WATER', 'Water'),
    ('SYRO JUS/SOFTDR', 'Soft Drinks'),
    ('مشروبات', 'Drinks'),
    ('ALCOOL', 'Alcoholic Drinks'),
    ('TABAC', 'Tobacco, Argile & Charcoal'),
    ('ALLUMET/GAZ/FHM', 'Tobacco, Argile & Charcoal'),
    ('ALLUMETTE', 'Tobacco, Argile & Charcoal'),
    ('Argile', 'Tobacco, Argile & Charcoal'),
    ('Fahem', 'Tobacco, Argile & Charcoal'),
    ('Ma3asel', 'Tobacco, Argile & Charcoal'),
    ('Nargile', 'Tobacco, Argile & Charcoal'),
    ('DIETHETIQUE', 'Health & Pharmacy'),
    ('Vitamins', 'Health & Pharmacy'),
    ('Pain relief', 'Health & Pharmacy'),
    ('ALL TYPES', 'Other'),
    ('Others', 'Other'),
    ('DETERG/ANTISEPT', 'Cleaning & Detergents'),
    ('WIPES/PADS/CLIN', 'Tissues, Wipes & Pads'),
    ('AIR REFRESHNING', 'Air Fresheners & Insect Control'),
    ('ANTI-INSECT', 'Air Fresheners & Insect Control'),
    ('HOUSEHOLD', 'Household & Disposables'),
    ('PLASTIC', 'Household & Disposables'),
    ('CANDLE', 'Household & Disposables'),
    ('SHAMPO/CONDITOI', 'Personal Care'),
    ('DEODORANT', 'Personal Care'),
    ('SHAVING', 'Personal Care'),
    ('SOAP', 'Personal Care'),
    ('DENTIFRICE', 'Personal Care'),
    ('TOOTH BRUSH', 'Personal Care'),
    ('COSMETICS', 'Personal Care'),
    ('CREME COLORANT', 'Personal Care'),
    ('Hygiene', 'Personal Care'),
    ('Skin care', 'Personal Care'),
    ('BATERY/FILM CAM', 'Batteries & Electrical'),
    ('ELECTRICITY', 'Batteries & Electrical'),
    ('سلطات', 'Starters & Salads'),
    ('Salads', 'Starters & Salads'),
    ('Starters', 'Starters & Salads'),
    ('Sides', 'Starters & Salads'),
    ('فرن', 'Manakish & Pastries'),
    ('Zaatar Manakish', 'Manakish & Pastries'),
    ('Cheese & Meat Manakish', 'Manakish & Pastries'),
    ('Dough Pies & Pizza', 'Manakish & Pastries'),
    ('Mo3ajjanat', 'Manakish & Pastries'),
    ('Ajine', 'Manakish & Pastries'),
    ('Manakish', 'Manakish & Pastries'),
    ('بيتزا', 'Pizza'),
    ('ساب', 'Sandwiches & Snacks'),
    ('سناك', 'Sandwiches & Snacks'),
    ('Sandwiches', 'Sandwiches & Snacks'),
    ('Burritos', 'Sandwiches & Snacks'),
    ('صحن', 'Plates & Meals'),
    ('Plates', 'Plates & Meals'),
    ('Akel', 'Plates & Meals'),
    ('Lil 2ale', 'Ready to Fry')
) as m(old, new)
where p.section = m.old;

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
       (select count(distinct section) from suqa.products where is_active) as sections_in_use,
       (select count(*) from suqa.products p where p.is_active and coalesce(trim(p.section), '') <> ''
          and not exists (select 1 from suqa.item_categories c where c.tenant_id = p.tenant_id and c.key = p.section)) as items_outside_the_list;
