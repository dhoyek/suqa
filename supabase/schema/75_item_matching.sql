-- 75 — Item matching: find a shop's items from the words people really use (Arabic, Arabizi, English, mixed).
--   The base of the Yorgo assistant (docs/yorgo/PLAN.md, milestone 1) and usable without any AI: a typed, deterministic search.
--
--   A) products.aliases text[]        other names for an item ("khebez", "rabta", "man2ouche"); public, like the name.
--   B) suqa.norm_text / suqa.skel_text one way of folding text, used on both sides of every comparison:
--        norm  lower-case, no tashkeel, alef/ya/ta-marbuta/hamza variants unified, Arabic-Indic digits → Western, punctuation → space
--        skel  a consonant skeleton in ONE alphabet so Arabic, Arabizi and Latin spellings meet:
--              خبز = khebez = 5ebez → "xbz" · منقوشة = man2ouche = mankoushe → "mnkc" · بيبسي = pepsi = bebsi → "bbs"
--   C) suqa.product_search            the folded text of every item, kept by trigger, trigram-indexed. No policies: only the functions read it.
--   D) suqa.match_items(...)          phrases in → ranked candidates out (score, price USD/LBP, availability, weekday limits).
--        Signed-in staff of the shop asked for see all its active items; everyone else only what the public catalog shows.
--   E) suqa.alias_suggestions         "this phrase meant that item", collected when someone picks a candidate; the shop approves or rejects.
--        suqa.alias_suggest(...)       record a pick (any signed-in user, for an item they can see)
--        suqa.alias_decide(...)        owner / stock / association setup: approve (adds the alias to the item) or reject; audited.
--   Later hook: an `embedding` column on product_search + one more term in match_items' score (pgvector) — not added now.
-- Base file 04 (products) lists the new column. Idempotent.

create extension if not exists pg_trgm with schema extensions;
select extensions.similarity('a', 'a') as pg_trgm_loaded;   -- loads the library in this session, so `set pg_trgm.…` on a function below is a known setting

-- ---------- A) aliases ----------
alter table suqa.products add column if not exists aliases text[] not null default '{}';
alter table suqa.products drop constraint if exists products_aliases_small;
alter table suqa.products add constraint products_aliases_small check (cardinality(aliases) <= 40);
grant select (aliases) on suqa.products to anon, authenticated;   -- 71: a new column is private until granted

-- ---------- B) folding ----------
create or replace function suqa.norm_text(t text) returns text
language sql immutable parallel safe as $$
  select btrim(regexp_replace(
    translate(
      regexp_replace(lower(coalesce(t, '')), '[ً-ْـٰ]', '', 'g'),          -- tashkeel, tatweel
      'أإآٱةىؤئ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹éèêëàâäçôöùûüîï',
      'ااااهيوي01234567890123456789eeeeaaacoouuuii'),
    '[^a-z0-9ء-يپچڤگ]+', ' ', 'g'))
$$;

create or replace function suqa.skel_text(t text) returns text
language plpgsql immutable parallel safe as $$
declare w text; res text := '';
begin
  foreach w in array regexp_split_to_array(suqa.norm_text(t), ' ') loop
    continue when w = '';
    w := regexp_replace(w, '([^0-9])\1+', '\1', 'g');                              -- doubled letters, as written ("gallon", "حمّص")
    -- Latin digraphs are one sound: hold them as capitals until the single letters are mapped
    w := replace(replace(replace(replace(replace(replace(replace(w, 'kh', 'X'), 'sh', 'C'), 'ch', 'C'), 'gh', 'G'), 'th', 'T'), 'ph', 'F'), 'ck', 'K');
    if length(w) > 2 then w := regexp_replace(w, '[hه]$', ''); end if;             -- final h: ta marbuta, "labneh", "قهوة"
    -- Arabizi digits: a lone digit inside a Latin word is a letter ("man2ouche", "7alib", "3asal"); a number is left alone ("185ml")
    if w ~ '[a-zA-Z]' and w !~ '[0-9]{2}' then w := translate(w, '235789', 'KEXHGS'); end if;
    w := replace(w, 'x', 'ks');
    -- Latin: vowels and glides out; sounds Arabic does not separate are merged (p/b, v/f, c/k/q)
    w := translate(w, 'aeiouywpvcqXCGTFKHS', '~~~~~~~bfkkxcgtfkhs');
    -- Arabic into the same alphabet: long vowels and hamza out; ع is its own sound (E, like Arabizi 3)
    w := translate(w, 'بتثجحخدذرزسشصضطظعغفقكلمنهپچڤگاويء', 'bttjhxddrzscsdtzEgfkklmnhbcfg~~~~');
    w := replace(w, '~', '');
    if w <> '' then res := res || case when res = '' then '' else ' ' end || w; end if;
  end loop;
  return res;
end $$;

-- ---------- C) the folded catalog ----------
create table if not exists suqa.product_search (
  product_id  uuid primary key references suqa.products(id) on delete cascade,
  tenant_id   uuid not null,
  shop_id     uuid not null,
  name_ar     text not null default '',      -- norm_text of each name, for whole-name closeness
  name_en     text not null default '',
  alias_norms text[] not null default '{}',  -- norm_text of each alias, for exact hits
  norm        text not null default '',      -- names + aliases, folded
  skel        text not null default '',      -- the same, as consonant skeletons
  updated_at  timestamptz not null default now()
);
create index if not exists product_search_shop   on suqa.product_search(shop_id);
create index if not exists product_search_tenant on suqa.product_search(tenant_id);
create index if not exists product_search_norm_trgm on suqa.product_search using gin (norm extensions.gin_trgm_ops);
create index if not exists product_search_skel_trgm on suqa.product_search using gin (skel extensions.gin_trgm_ops);
alter table suqa.product_search enable row level security;      -- no policies on purpose: read only through match_items
revoke all on suqa.product_search from anon, authenticated;

create or replace function suqa.product_search_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_all text;
begin
  v_all := concat_ws(' ', new.name->>'ar', new.name->>'en', array_to_string(new.aliases, ' '));
  insert into suqa.product_search (product_id, tenant_id, shop_id, name_ar, name_en, alias_norms, norm, skel, updated_at)
  values (new.id, new.tenant_id, new.shop_id, suqa.norm_text(new.name->>'ar'), suqa.norm_text(new.name->>'en'),
          coalesce((select array_agg(suqa.norm_text(a)) from unnest(new.aliases) a where suqa.norm_text(a) <> ''), '{}'),
          suqa.norm_text(v_all), suqa.skel_text(v_all), now())
  on conflict (product_id) do update set tenant_id = excluded.tenant_id, shop_id = excluded.shop_id, name_ar = excluded.name_ar, name_en = excluded.name_en,
    alias_norms = excluded.alias_norms, norm = excluded.norm, skel = excluded.skel, updated_at = now();
  return new;
end $$;
drop trigger if exists product_search_sync on suqa.products;
create trigger product_search_sync after insert or update of name, aliases, shop_id on suqa.products
  for each row execute function suqa.product_search_sync();

-- (re)fold items: one shop, or everything when p_shop is null. Used by the backfill below and after a restore (which loads rows with triggers off).
create or replace function suqa.product_search_refresh(p_shop uuid default null) returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  delete from suqa.product_search s where (p_shop is null or s.shop_id = p_shop) and not exists (select 1 from suqa.products p where p.id = s.product_id);
  insert into suqa.product_search (product_id, tenant_id, shop_id, name_ar, name_en, alias_norms, norm, skel)
  select p.id, p.tenant_id, p.shop_id, suqa.norm_text(p.name->>'ar'), suqa.norm_text(p.name->>'en'),
         coalesce((select array_agg(suqa.norm_text(a)) from unnest(p.aliases) a where suqa.norm_text(a) <> ''), '{}'),
         suqa.norm_text(concat_ws(' ', p.name->>'ar', p.name->>'en', array_to_string(p.aliases, ' '))),
         suqa.skel_text(concat_ws(' ', p.name->>'ar', p.name->>'en', array_to_string(p.aliases, ' ')))
  from suqa.products p where p_shop is null or p.shop_id = p_shop
  on conflict (product_id) do update set tenant_id = excluded.tenant_id, shop_id = excluded.shop_id, name_ar = excluded.name_ar, name_en = excluded.name_en,
    alias_norms = excluded.alias_norms, norm = excluded.norm, skel = excluded.skel, updated_at = now();
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function suqa.product_search_refresh(uuid) from public, anon, authenticated;

select suqa.product_search_refresh(null) as items_folded;      -- backfill

-- restore (64) inserts with triggers off: fold the shop's items when it finishes. In-place patch; skipped when already there, stops if the anchor moved.
do $$ declare v_def text; v_find text := '  for r in select id from suqa.suppliers where shop_id = p_shop loop';
begin
  select pg_get_functiondef('suqa.pos_restore_finish(uuid,int,text)'::regprocedure) into v_def;
  if position('product_search_refresh' in v_def) > 0 then return; end if;
  if position(v_find in v_def) = 0 then raise exception 'pos_restore_finish: anchor not found'; end if;
  execute replace(v_def, v_find, '  perform suqa.product_search_refresh(p_shop);' || chr(10) || v_find);
end $$;

-- ---------- D) match_items ----------
-- p_phrases: what the person called each item, one entry per item, WITHOUT the quantity ("khebez arabi", "بيبسي تنك").
-- Returns up to p_limit candidates per phrase, best first. score 1 = an exact name or alias; below ~0.45 treat as "not sure, ask".
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
  with q as (
    select i::int as no, left(ph, 80) as raw, suqa.norm_text(left(ph, 80)) as qn, suqa.skel_text(left(ph, 80)) as qs
    from unnest(p_phrases) with ordinality as u(ph, i)
  ), scored as (
    select q.no, q.raw, s.product_id as pid,
           (q.qn = s.name_ar or q.qn = s.name_en or q.qn = any(s.alias_norms)) as exact,
           -- the phrase as a whole, and word by word (so "pepsi can" prefers the item that has both words, wherever they stand)
           (word_similarity(q.qn, s.norm) + (select avg(word_similarity(tok, s.norm)) from unnest(string_to_array(q.qn, ' ')) tok)) / 2 as w_norm,
           case when length(replace(q.qs, ' ', '')) >= 3
                then (word_similarity(q.qs, s.skel) + (select avg(word_similarity(tok, s.skel)) from unnest(string_to_array(q.qs, ' ')) tok)) / 2 else 0 end as w_skel,
           greatest(similarity(q.qn, s.name_ar), similarity(q.qn, s.name_en)) as whole
    from q
    join suqa.product_search s on s.tenant_id = p_tenant and (p_shop is null or s.shop_id = p_shop)
    where q.qn <> ''
      and (q.qn <% s.norm or q.qs <% s.skel or q.qn = any(s.alias_norms))      -- cheap trigram pre-filter (threshold set on the function); the scoring below is the costly part
  ), ranked as (
    select sc.no, sc.raw, sc.pid,
           (case when sc.exact then 1.0
                 else least(0.99, greatest(sc.w_norm, sc.w_skel * 0.9) * 0.85 + sc.whole * 0.15) end)::real as sc,
           case when sc.exact then 'exact' when sc.w_norm >= sc.w_skel * 0.9 then 'spelling' else 'sound' end as how
    from scored sc
    where sc.exact or sc.w_norm >= 0.3 or sc.w_skel >= 0.45
  ), visible as (
    select r.*, p.shop_id as sid, sh.name as sname, p.name as pname, p.unit as punit, p.price_usd as pusd, p.price_currency as pcur, p.price_lbp as plbp,
           p.is_available as pav, p.available_days as pdays,
           row_number() over (partition by r.no order by r.sc desc, p.is_available desc, p.sort_order, p.id) as rn
    from ranked r
    join suqa.products p on p.id = r.pid and p.is_active
    join suqa.shops sh on sh.id = p.shop_id
    where v_staff or (p.visible_online and sh.status = 'active')
  )
  select v.no, v.raw, v.pid, v.sid, v.sname, v.pname, v.punit, v.pusd, v.pcur, v.plbp, v.pav, v.pdays, v.sc, v.how
  from visible v where v.rn <= v_limit
  order by v.no, v.rn;
end $$;
revoke all on function suqa.match_items(uuid, text[], uuid, int) from public;
grant execute on function suqa.match_items(uuid, text[], uuid, int) to anon, authenticated;

-- ---------- E) alias suggestions ----------
create table if not exists suqa.alias_suggestions (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references suqa.tenants(id) on delete cascade,
  shop_id      uuid not null references suqa.shops(id) on delete cascade,
  product_id   uuid not null references suqa.products(id) on delete cascade,
  phrase       text not null check (char_length(phrase) between 2 and 60),   -- as the person wrote it
  phrase_norm  text not null,                                               -- norm_text(phrase): one row per item and phrase
  picks        int  not null default 1,                                     -- how many times this phrase was resolved to this item
  status       text not null default 'pending' check (status in ('pending','approved','rejected')),
  source       text not null default 'yorgo' check (source in ('yorgo','pos','import')),
  first_by     uuid,                                                        -- who first picked it
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  decided_by   uuid,
  decided_at   timestamptz,
  unique (product_id, phrase_norm)
);
create index if not exists alias_suggestions_shop on suqa.alias_suggestions(shop_id, status, picks desc);
alter table suqa.alias_suggestions enable row level security;
drop policy if exists alias_suggestions_read on suqa.alias_suggestions;
create policy alias_suggestions_read on suqa.alias_suggestions for select to authenticated
  using (suqa.pos_role(shop_id) in ('owner','stock','setup'));           -- item setup, not financial: the association may help
revoke all on suqa.alias_suggestions from anon, authenticated;
grant select on suqa.alias_suggestions to authenticated;                    -- writes only through the two functions below

-- A pick: "<phrase>" meant this item. Ignored when the phrase already is the item's name or alias, or was rejected before.
create or replace function suqa.alias_suggest(p_product uuid, p_phrase text, p_source text default 'yorgo') returns void
language plpgsql security definer set search_path = public as $$
declare v_p suqa.products; v_norm text := suqa.norm_text(p_phrase); v_phrase text := btrim(left(coalesce(p_phrase, ''), 60));
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if char_length(v_phrase) < 2 or v_norm = '' then return; end if;
  select * into v_p from suqa.products where id = p_product and is_active;
  if not found then return; end if;
  if not (v_p.visible_online and exists (select 1 from suqa.shops where id = v_p.shop_id and status = 'active'))
     and suqa.pos_role(v_p.shop_id) is null then return; end if;                                    -- an item the caller cannot see
  if v_norm in (suqa.norm_text(v_p.name->>'ar'), suqa.norm_text(v_p.name->>'en'))
     or exists (select 1 from unnest(v_p.aliases) a where suqa.norm_text(a) = v_norm) then return; end if;
  if (select count(*) from suqa.alias_suggestions where product_id = p_product and status = 'pending') >= 50 then return; end if;
  insert into suqa.alias_suggestions (tenant_id, shop_id, product_id, phrase, phrase_norm, source, first_by)
  values (v_p.tenant_id, v_p.shop_id, v_p.id, v_phrase, v_norm, case when p_source in ('yorgo','pos','import') then p_source else 'yorgo' end, auth.uid())
  on conflict (product_id, phrase_norm) do update set picks = suqa.alias_suggestions.picks + 1, updated_at = now()
    where suqa.alias_suggestions.status = 'pending';
end $$;
revoke all on function suqa.alias_suggest(uuid, text, text) from public, anon;
grant execute on function suqa.alias_suggest(uuid, text, text) to authenticated;

-- The shop's decision. Approve adds the phrase to the item's aliases (which re-folds the item and reaches the tills through the usual feed).
create or replace function suqa.alias_decide(p_id uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v suqa.alias_suggestions; v_role text;
begin
  select * into v from suqa.alias_suggestions where id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  v_role := suqa.pos_role(v.shop_id);
  if v_role is null or v_role not in ('owner','stock','setup') then raise exception 'not_allowed'; end if;
  if v.status <> 'pending' then return; end if;
  if p_approve then
    update suqa.products set aliases = aliases || v.phrase
     where id = v.product_id and cardinality(aliases) < 40
       and not exists (select 1 from unnest(aliases) a where suqa.norm_text(a) = v.phrase_norm);
  end if;
  update suqa.alias_suggestions set status = case when p_approve then 'approved' else 'rejected' end, decided_by = auth.uid(), decided_at = now(), updated_at = now()
   where id = p_id;
  insert into suqa.audit_log (shop_id, tenant_id, user_id, action, ref_tbl, ref_id, after, acting_as_admin)
  values (v.shop_id, v.tenant_id, auth.uid(), case when p_approve then 'alias.approve' else 'alias.reject' end, 'products', v.product_id::text,
          jsonb_build_object('phrase', v.phrase, 'picks', v.picks, 'source', v.source), v_role = 'setup');
end $$;
revoke all on function suqa.alias_decide(uuid, boolean) from public, anon;
grant execute on function suqa.alias_decide(uuid, boolean) to authenticated;

select 'item matching installed' as result;
