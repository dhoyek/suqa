-- 84_category_matching.sql — search by the KIND of item, not only its name.   (2026-11-19)
--
-- WHY: on prod, "machroub" / "chou 3endo machroubet" at Dekanet Jadde found only the few items whose NAME holds مشروب, never the
-- 77 drinks of its section "SYRO JUS/SOFTDR" nor its "WATER" items; "miyah" found milk and Miranda. People ask by kind
-- ("machroub", "may", "chokola", "dekhen") as often as by name.
--
-- NOW:
--   * suqa.match_concepts — the kinds of item and how people call them (say: Arabic, Arabizi, English, French) and the words that
--     mark an item of that kind in its name, aliases or section (tags). Seeded with 18 kinds; the same list is in
--     packages/pos-core/src/concepts.ts for the storefront and till search (a test keeps the two in step).
--   * suqa.match_items — a word of the phrase that names a kind (as written, or by sound for words of 3+ sounds:
--     "mashroub", "machroubet", "مشروبات" = machroub) now stands for every item of that kind:
--       "machroub"        → the shop's drinks (0.75 + up to 0.2 for the closest name; available first)
--       "machroub pepsi"  → the Pepsi items of the drinks (the other words matched by name, +0.15 for being of the kind)
--       "miyah" / "may"   → water, not milk;   "بوظة شوكولا" → items that are ice cream AND chocolate
--     The score by name alone (76) is always kept as a floor, so nothing found before is lost; a phrase with no kind word is
--     scored exactly as before. By sound only towards the Arabic names of a kind ("machroub" = مشروب). Same signature, same access.
--   Tags of four letters or fewer, and "=word", match a whole word only ("bon" = section "CHOBISC/GUM/BON", not "Bonduelle";
--   "=water" not "watermelon"); "-word" keeps an item out ("-tuna": tuna in water is not water).
--
-- Speed (84b, after "pepsi cans" took 11 s on prod and the 3 s limit cut it): sections are folded once per search, a kind word
-- is tested with one pattern per item, every step is computed once (materialized, not re-run per item), and the costly scoring by name runs only on the items the trigram pre-filter lets through.
--
-- Table changes: NEW table suqa.match_concepts (no grants: read only inside match_items). Idempotent: the seed upserts.

select extensions.similarity('a', 'a') as pg_trgm_loaded;   -- load pg_trgm first (see 76)

create table if not exists suqa.match_concepts (
  id          text primary key,
  say         text[]      not null default '{}',   -- how people call the kind
  tags        text[]      not null default '{}',   -- words that mark an item of the kind (name, alias, section)
  updated_at  timestamptz not null default now(),
  constraint match_concepts_id_format check (id ~ '^[a-z_]{2,30}$'),
  constraint match_concepts_small check (cardinality(say) <= 60 and cardinality(tags) <= 80)
);
alter table suqa.match_concepts enable row level security;     -- no policies: only security-definer functions read it
revoke all on suqa.match_concepts from public, anon, authenticated;

insert into suqa.match_concepts (id, say, tags) values
  ('drinks',
   array['machroub', 'mashroub', 'machroubet', 'mashroubet', 'mashroubat', 'مشروب', 'مشروبات', 'drink', 'drinks', 'beverage', 'beverages', 'boisson', 'boissons', 'soft drink', 'soft drinks', 'soda', 'sodas'],
   array['drink', 'beverage', 'boisson', 'softdr', 'soft drink', 'soda', 'مشروب', 'مشروبات', 'jus', 'juice', 'عصير', '=water', 'مياه', 'cola', 'كولا', 'pepsi', 'بيبسي', '7up', 'سفن', 'miranda', 'mirinda', 'ميرندا', 'sprite', 'سبرايت', 'fanta', 'فانتا', 'energy', 'طاقة', 'red bull', 'ريد بول', 'ice tea', 'nestea', 'gazeuse', 'غازية', 'syro', 'sirop', 'شراب', 'جلاب', 'tamarind', 'تمر هندي', '-vape', '-فيب', '-tuna', '-تونا', '-micellar', '-ميسيلار', '-alcool', '-alcohol', '-كحول', '-روحية', '-beer', '-bira', '-بيرة', '-arak', '-عرق', '-whisk', '-ويسكي', '-vodka', '-فودكا', '-wine', '-نبيذ', '-liqueur', '-ليكور', '-gin', '-rum']),
  ('water',
   array['may', 'mayy', 'maye', 'mayye', 'mayyeh', 'mai', 'miyah', 'miyeh', 'mia', 'مي', 'مية', 'مياه', 'ماء', 'water', 'eau'],
   array['=water', 'مياه', 'sohat', 'صحة', 'tannourine', 'تنورين', 'sannine', 'صنين', 'rim', 'ريم', 'نسمة', 'aquafina', 'nestle pure', '-tuna', '-تونا', '-تونة', '-micellar', '-ميسيلار', '-gum', '-علكة', '-vape', '-فيب', '-wipes', '-محارم']),
  ('juice',
   array['3asir', '3aseer', 'asir', 'aseer', 'عصير', 'عصاير', 'juice', 'juices', 'jus'],
   array['juice', 'juicy', 'عصير', 'nectar', 'نكتار', 'jus de']),
  ('chocolate',
   array['chokola', 'chocola', 'shokola', 'chocolat', 'chocolate', 'chocolates', 'choco', 'شوكولا', 'شوكولاته', 'شوكولاتة', 'شوكولا'],
   array['choco', 'شوكولا', 'cacao', 'kitkat', 'kit kat', 'snickers', 'twix', 'mars', 'galaxy', 'kinder', 'nutella', 'bounty', 'milka', 'toblerone', 'unica', 'يونيكا']),
  ('chips',
   array['chips', 'tchips', 'shibs', 'chibs', 'شيبس', 'شيبسات', 'crisps', 'رقائق'],
   array['chips', 'شيبس', 'crisps', 'pringles', 'برينغلز', 'doritos', 'lays', 'ليز', 'cheetos', 'تشيتوس', 'master chips']),
  ('sweets',
   array['sakaker', 'skaker', 'سكاكر', 'bonbon', 'bonbons', 'بونبون', 'candy', 'candies', '7elwiyet', 'helwiyet', '7elwayet', 'حلويات', 'sweets', 'bombon'],
   array['bon', 'بونبون', 'candy', 'سكاكر', 'sweet', 'حلو', 'gum', 'علكة', 'chewing', 'lollipop', 'مصاصة', 'marshmallow', 'gelo', 'jelly', 'جيلي']),
  ('coffee',
   array['ahwe', 'ahweh', '2ahwe', '2ahweh', 'kahwe', 'qahwa', 'قهوة', 'قهوه', 'coffee', 'cafe', 'nescafe', 'نسكافيه'],
   array['coffee', 'cafe', 'قهوة', 'قهوه', 'nescafe', 'نسكافيه', 'espresso', 'cappuccino', 'كابتشينو', 'najjar', 'نجار']),
  ('tea',
   array['shay', 'chay', 'chai', 'shai', 'شاي', 'tea', 'zhourat', 'zhurat', 'زهورات'],
   array['tea', 'شاي', 'zhourat', 'زهورات', 'lipton', 'ليبتون', 'infusion', 'يانسون', 'بابونج']),
  ('milk',
   array['7alib', 'halib', '7aleeb', 'haleeb', 'حليب', 'milk', 'lait'],
   array['milk', 'lait', 'حليب', 'بودرة حليب', 'nido', 'نيدو']),
  ('cheese',
   array['jebne', 'jebneh', 'jibne', 'jibneh', 'جبنة', 'جبنه', 'جبن', 'cheese', 'fromage'],
   array['cheese', 'fromage', 'جبن', 'جبنة', 'jebne', 'halloumi', 'حلوم', 'akawi', 'عكاوي', 'kashkaval', 'قشقوان', 'feta', 'فيتا']),
  ('bread',
   array['khebez', '5ebez', 'khebz', 'khobz', 'kheboz', 'خبز', 'bread', 'pain'],
   array['خبز', 'bread', 'pain', 'toast', 'توست', 'كعك', 'baguette']),
  ('ice_cream',
   array['bouza', 'buza', 'boza', 'بوظة', 'بوظه', 'ice cream', 'icecream', 'glace', 'gelato', 'glaces'],
   array['ice cream', 'بوظة', 'glace', 'magnum', 'ماغنوم', 'cornetto', 'كورنيتو', 'extreme']),
  ('nuts',
   array['mkasarat', 'mkassarat', 'mokassarat', 'مكسرات', 'nuts', 'bzourat', 'bzurat', 'بزورات', 'pistache', 'fosto2', 'fostu2', 'فستق'],
   array['nut', 'nuts', 'مكسرات', 'بزورات', 'pistach', 'فستق', 'لوز', 'almond', 'كاجو', 'cashew', 'بزر', 'peanut', 'noisette', 'بندق']),
  ('canned',
   array['konserva', 'kounserva', 'conserve', 'conserves', 'معلبات', 'معلب', 'canned'],
   array['conserve', 'canned', 'معلب', 'tuna', 'تونة', 'تون', 'sardine', 'سردين', 'corned', 'luncheon', 'لانشون']),
  ('cleaning',
   array['tandif', 'tanzif', 'تنظيف', 'منظف', 'منظفات', 'cleaning', 'cleaner', 'detergent', 'detergents', 'nettoyage', 'mon7af'],
   array['deterg', 'antisept', 'تنظيف', 'منظف', 'clean', 'nettoy', 'javel', 'جافيل', 'clorox', 'كلوركس', 'dettol', 'ديتول', 'fairy', 'فيري', 'سائل جلي', 'dish', 'لافاجيل']),
  ('tobacco',
   array['dekhen', 'dikhen', 'dukhan', 'دخان', 'cigarette', 'cigarettes', 'sigara', 'sigarat', 'سيجارة', 'سجائر', 'tabac', 'tobacco', 'ma3asel', 'معسل'],
   array['tabac', 'tobacco', 'cigarette', 'دخان', 'سجائر', 'سيجارة', 'marlboro', 'مارلبورو', 'cedars', 'سيدرز', 'winston', 'ونستون', 'gitanes', 'معسل', 'ma3sal', 'kent', 'davidoff']),
  ('beer',
   array['beer', 'beers', 'bira', 'birra', 'بيرة', 'بيره', 'biere', 'bière'],
   array['beer', 'bira', 'بيرة', 'biere', 'almaza', 'ألمازة', 'ألمازا', 'heineken', 'هاينكن', 'efes', 'إفس', 'beirut beer', 'بيرة بيروت', 'corona', 'kronenbourg', 'stella']),
  ('alcohol',
   array['alcohol', 'alcool', 'ka7oul', 'kohol', 'كحول', 'wine', 'nbid', 'نبيذ', 'arak', '3ara2', 'عرق', 'whisky', 'whiskey', 'vodka'],
   array['alcool', 'alcohol', 'beer', 'bira', 'بيرة', 'wine', 'نبيذ', 'arak', 'عرق', 'whisk', 'ويسكي', 'vodka', 'فودكا', 'almaza', 'ألمازا', 'heineken', 'tequila'])
on conflict (id) do update set say = excluded.say, tags = excluded.tags, updated_at = now();

create or replace function suqa.match_items(p_tenant uuid, p_phrases text[], p_shop uuid default null, p_limit int default 5)
returns table (phrase_no int, phrase text, product_id uuid, shop_id uuid, shop_name jsonb, name jsonb, unit text,
               price_usd numeric, price_currency text, price_lbp bigint, is_available boolean, available_days smallint[],
               score real, matched_on text)
language plpgsql stable security definer set search_path = public, extensions set pg_trgm.word_similarity_threshold = 0.3 as $$
declare v_staff boolean := p_shop is not null and auth.uid() is not null and suqa.pos_role(p_shop) is not null;
        v_limit int := least(greatest(coalesce(p_limit, 5), 1), 10);
begin
  if p_tenant is null or p_phrases is null or cardinality(p_phrases) = 0 then return; end if;
  if cardinality(p_phrases) > 40 then raise exception 'too_many_phrases'; end if;
  return query
  with q as materialized (
    select i::int as no, left(ph, 80) as raw, suqa.norm_text(left(ph, 80)) as qn
    from unnest(p_phrases) with ordinality as u(ph, i)
  ), kw as materialized (                     -- every way to say a kind, folded. By sound only for the Arabic-script names (one word, 3+ sounds), so an
                                 -- Arabizi word reaches its Arabic kind ("machroub" = مشروب) while English words must be written as listed
                                 -- (by sound "galaxy" would be "glaces" and "gillette" "gelato")
    select c.id, x.sn, case when x.sn ~ ' ' or x.sn !~ '[ء-ي]' or length(suqa.skel_text(x.sn)) < 3 then null else suqa.skel_text(x.sn) end as ss
    from suqa.match_concepts c, unnest(c.say) w, lateral (select suqa.norm_text(w) as sn) x where x.sn <> ''
  ), kt as materialized (                     -- "=word": a whole word whatever its length; "-word": keeps an item out of the kind
    select c.id, x.tn, x.neg, (x.eq or length(replace(x.tn, ' ', '')) <= 4) as whole
    from suqa.match_concepts c, unnest(c.tags) t,
         lateral (select suqa.norm_text(regexp_replace(t, '^[-=]+', '')) as tn, t like '-%' as neg, regexp_replace(t, '^-', '') like '=%' as eq) x
    where x.tn <> ''
  ), qt as materialized (
    select q.no, t.w, t.i::int as i, suqa.skel_text(t.w) as ws from q, unnest(string_to_array(q.qn, ' ')) with ordinality t(w, i) where t.w <> ''
  ), hit as materialized (                    -- word i of phrase no names a kind: as written, or the same sound (+ one sound: "machroubet")
    select qt.no, qt.i, kw.id from qt join kw on kw.sn !~ ' '
       and (qt.w = kw.sn or (kw.ss is not null and (qt.ws = kw.ss or (left(qt.ws, length(kw.ss)) = kw.ss and length(qt.ws) - length(kw.ss) <= 1))))
    union
    select qt.no, qt.i, kw.id from qt join q on q.no = qt.no join kw on kw.sn ~ ' '
       and (' ' || q.qn || ' ') like ('% ' || kw.sn || ' %') and qt.w = any(string_to_array(kw.sn, ' '))
  ), wk as materialized (                     -- per kind word of a phrase: ONE pattern of its tags, and one of its exclusions (cheap to test per item)
    select h.no, h.i,
           '(' || string_agg(distinct case when kt.whole then ' ' || kt.tn || ' ' else ' ' || kt.tn end, '|') filter (where not kt.neg) || ')' as pos,
           '(' || string_agg(distinct case when kt.whole then ' ' || kt.tn || ' ' else ' ' || kt.tn end, '|') filter (where kt.neg) || ')' as neg
    from hit h join kt on kt.id = h.id group by h.no, h.i
  ), qx as materialized (                     -- per phrase: does it name a kind, and the words left to match by name
    select q.no, q.raw, q.qn, suqa.skel_text(q.qn) as qs,
           exists (select 1 from hit h where h.no = q.no) as has_kind,
           coalesce((select string_agg(qt.w, ' ' order by qt.i) from qt where qt.no = q.no and not exists (select 1 from hit h where h.no = qt.no and h.i = qt.i)), '') as rn
    from q
  ), qy as materialized (
    select qx.*, suqa.skel_text(qx.rn) as rs from qx
  ), secs as materialized (                   -- each section folded once: a shop has a few dozen, not one per item
    select x.sec, ' ' || suqa.norm_text(x.sec) || ' ' as sn
    from (select distinct coalesce(p.section, '') as sec from suqa.products p
          where p.tenant_id = p_tenant and (p_shop is null or p.shop_id = p_shop) and p.is_active) x
  ), base as materialized (
    select s.product_id as pid, s.norm, s.skel, s.name_ar, s.name_en, s.alias_norms, ' ' || s.norm || ' ' || x.sn as txt
    from suqa.product_search s
    join suqa.products p on p.id = s.product_id and p.is_active
    join secs x on x.sec = coalesce(p.section, '')
    where s.tenant_id = p_tenant and (p_shop is null or s.shop_id = p_shop)
  ), cand0 as materialized (
    select qy.no, qy.raw, qy.qn, qy.qs, qy.has_kind, qy.rn, qy.rs, b.pid, b.norm, b.skel, b.name_ar, b.name_en, b.alias_norms,
           (qy.qn <% b.norm or qy.qs <% b.skel or qy.qn = any(b.alias_norms)
            or (qy.has_kind and qy.rn <> '' and (qy.rn <% b.norm or qy.rs <% b.skel))) as by_name,   -- cheap trigram pre-filter
           -- of the kind: for EVERY kind word of the phrase, the item carries one of its tags and none of its exclusions
           (qy.has_kind and not exists (select 1 from wk where wk.no = qy.no
                                          and not (b.txt ~ wk.pos and (wk.neg is null or b.txt !~ wk.neg)))) as of_kind
    from qy cross join base b
    where qy.qn <> ''
  ), cand as materialized (
    select * from cand0 where by_name or (of_kind and rn = '')   -- a phrase that is only a kind: every item of it
  ), scored as materialized (
    select c.no, c.raw, c.pid, c.rn, c.has_kind, c.of_kind,
           (c.qn = c.name_ar or c.qn = c.name_en or c.qn = any(c.alias_norms)) as exact,
           -- by name, the whole phrase (exactly as 76) — only for the items the pre-filter let through
           case when not c.by_name then 0 else
             (word_similarity(c.qn, c.norm) + (select avg(word_similarity(tok, c.norm)) from unnest(string_to_array(c.qn, ' ')) tok)) / 2 end as w_norm,
           case when not c.by_name or length(replace(c.qs, ' ', '')) < 3 then 0 else
             (word_similarity(c.qs, c.skel) + (select avg(word_similarity(tok, c.skel)) from unnest(string_to_array(c.qs, ' ')) tok)) / 2 end as w_skel,
           case when not c.by_name then greatest(similarity(c.qn, c.name_ar), similarity(c.qn, c.name_en))   -- an item found only by its kind: a light tie-break
                else greatest(similarity(c.qn, c.name_ar), similarity(c.qn, c.name_en),
                              case when length(replace(c.qs, ' ', '')) >= 3
                                   then greatest(similarity(c.qs, suqa.skel_text(c.name_ar)), similarity(c.qs, suqa.skel_text(c.name_en))) * 0.9 else 0 end) end as whole,
           -- … and the words left once the kind words are taken out ("machroub pepsi" → "pepsi")
           case when c.rn = '' or not c.of_kind then 0 else
             (word_similarity(c.rn, c.norm) + (select avg(word_similarity(tok, c.norm)) from unnest(string_to_array(c.rn, ' ')) tok)) / 2 end as r_norm,
           case when c.rn = '' or not c.of_kind or length(replace(c.rs, ' ', '')) < 3 then 0 else
             (word_similarity(c.rs, c.skel) + (select avg(word_similarity(tok, c.skel)) from unnest(string_to_array(c.rs, ' ')) tok)) / 2 end as r_skel,
           case when c.rn = '' or not c.of_kind then 0 else
             greatest(similarity(c.rn, c.name_ar), similarity(c.rn, c.name_en),
                      case when length(replace(c.rs, ' ', '')) >= 3
                           then greatest(similarity(c.rs, suqa.skel_text(c.name_ar)), similarity(c.rs, suqa.skel_text(c.name_en))) * 0.9 else 0 end) end as r_whole
    from cand c
  ), ranked as (
    select sc.no, sc.raw, sc.pid, sc.rn, sc.has_kind, sc.of_kind, sc.exact,
           bool_or(sc.of_kind) over (partition by sc.no) as kind_found,
           (case when sc.exact then 1.0 else greatest(
              -- by name, as before
              case when sc.w_norm >= 0.3 or sc.w_skel >= 0.45 then least(0.99, greatest(sc.w_norm, sc.w_skel * 0.9) * 0.85 + sc.whole * 0.15) else 0 end,
              -- only a kind ("machroub"): every item of it, the closest name first ("عرق" → the arak before the whisky)
              case when sc.rn = '' and sc.of_kind then 0.75 + 0.2 * sc.whole else 0 end,
              -- a kind and a name ("machroub pepsi"): the name decides, the items of the kind first
              case when sc.rn <> '' and sc.of_kind and (sc.r_norm >= 0.3 or sc.r_skel >= 0.45)
                   then least(0.99, greatest(sc.r_norm, sc.r_skel * 0.9) * 0.85 + sc.r_whole * 0.15 + 0.15) else 0 end) end)::real as sc,
           case when sc.exact then 'exact'
                when sc.has_kind and sc.of_kind then 'kind'
                when sc.w_norm >= sc.w_skel * 0.9 then 'spelling' else 'sound' end as how
    from scored sc
  ), ranked2 as (
    -- a phrase that is only a kind keeps only the items of that kind ("miyah": the water, not the milk that sounds alike),
    -- unless the shop has none of them — then the names found are still worth showing
    select * from ranked where sc > 0 and (exact or not (has_kind and rn = '' and kind_found and not of_kind))
  ), visible as (
    select r.no, r.raw, r.pid, r.sc, r.how, p.shop_id as sid, sh.name as sname, p.name as pname, p.unit as punit, p.price_usd as pusd, p.price_currency as pcur, p.price_lbp as plbp,
           p.is_available as pav, p.available_days as pdays,
           row_number() over (partition by r.no order by r.sc desc, p.is_available desc, length(coalesce(p.name->>'ar', '')) + length(coalesce(p.name->>'en', '')), p.sort_order, p.id) as ord
    from ranked2 r
    join suqa.products p on p.id = r.pid and p.is_active
    join suqa.shops sh on sh.id = p.shop_id
    where v_staff or (p.visible_online and sh.status = 'active')
  )
  select v.no, v.raw, v.pid, v.sid, v.sname, v.pname, v.punit, v.pusd, v.pcur, v.plbp, v.pav, v.pdays, v.sc, v.how
  from visible v where v.ord <= v_limit
  order by v.no, v.ord;
end $$;
revoke all on function suqa.match_items(uuid, text[], uuid, int) from public;
grant execute on function suqa.match_items(uuid, text[], uuid, int) to anon, authenticated;

select 'category matching installed' as result, (select count(*) from suqa.match_concepts) as kinds;
