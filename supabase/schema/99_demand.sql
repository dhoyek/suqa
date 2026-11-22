-- 99 — Demand: what people ask for, how often, who, and whether it was found (the association's "Demand" page).
--   Two sources, one report:
--     · Yorgo (app chat and WhatsApp): read from what is ALREADY stored — every item search Yorgo ran is in yorgo_messages
--       (the tool result: the phrase and its candidates with a score). Nothing new is written for Yorgo, so the report
--       goes back to Yorgo's first day. Shopper conversations only: a seller searching their own catalog is not demand.
--     · The search boxes (home page and a shop's page): not recorded until now → new table search_log, written by search_note.
--   "Found" is the same line Yorgo uses for its misses: best candidate score >= 0.45.
--
--   search_log       one row per search a person stopped typing on: the words, found or not, the shop (null = home page),
--                    the person when signed in, else a random visitor key that lives in the browser tab only.
--   search_note      the storefront records one search (anyone; typing on — "kh", "khe", "khebez" — replaces the row).
--   demand_report    association admins: phrases with counts, people, found / not found, by source.
--   demand_people    association admins: who asked for one phrase — name and phone, how, how many times, last time.
--   The association sees the item words and who asked, NOT the text of the messages. Shops see nothing of this.
-- Idempotent. No change to existing tables.

create table if not exists suqa.search_log (
  id           bigserial primary key,
  tenant_id    uuid not null references suqa.tenants(id) on delete cascade,
  shop_id      uuid references suqa.shops(id) on delete cascade,           -- the shop page searched; null = the home page (every shop)
  user_id      uuid,                                                      -- signed in: the person; null = a visitor
  visitor      text check (visitor is null or char_length(visitor) <= 40), -- visitor: a random key from the browser tab (not a person, gone when the tab closes)
  phrase       text not null check (char_length(phrase) between 2 and 80), -- as typed
  phrase_norm  text not null,                                             -- norm_text(phrase)
  found        boolean not null,                                          -- the box showed at least one item
  created_at   timestamptz not null default now()
);
create index if not exists search_log_tenant on suqa.search_log (tenant_id, created_at desc);
create index if not exists search_log_who on suqa.search_log (coalesce(user_id::text, visitor), created_at desc);
alter table suqa.search_log enable row level security;                     -- no policy: read only through the functions below
revoke all on suqa.search_log from anon, authenticated;

-- One search from the storefront. Called when the person stops typing (the page waits ~2 s). Never fails the page.
--   · typing on within 2 minutes ("khe" → "khebez", or back to "kh") replaces the person's last row instead of adding one;
--   · the very same words again within 10 minutes are not counted twice;
--   · a brake: at most 300 rows a minute for the association, whatever happens.
create or replace function suqa.search_note(p_tenant uuid, p_shop uuid, p_phrase text, p_found boolean, p_visitor text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_phrase text := btrim(left(coalesce(p_phrase, ''), 80)); v_norm text; v_who text; v_tenant uuid; v_last suqa.search_log;
begin
  if char_length(v_phrase) < 2 or p_found is null then return; end if;
  v_norm := suqa.norm_text(v_phrase);
  if coalesce(v_norm, '') = '' then return; end if;
  if p_shop is not null then                                                                         -- a shop page: the shop says which association (p_tenant may be left out)
    select tenant_id into v_tenant from suqa.shops where id = p_shop;
    if v_tenant is null or (p_tenant is not null and p_tenant <> v_tenant) then return; end if;
  else
    select id into v_tenant from suqa.tenants where id = p_tenant;
    if v_tenant is null then return; end if;
  end if;
  v_who := coalesce(auth.uid()::text, nullif(left(btrim(coalesce(p_visitor, '')), 40), ''));
  if v_who is not null then
    select * into v_last from suqa.search_log
     where coalesce(user_id::text, visitor) = v_who and tenant_id = v_tenant and shop_id is not distinct from p_shop and created_at > now() - interval '10 minutes'
     order by id desc limit 1;
    if found then
      if v_last.phrase_norm = v_norm then return; end if;                                            -- the same words again
      if v_last.created_at > now() - interval '2 minutes' and (v_norm like v_last.phrase_norm || '%' or v_last.phrase_norm like v_norm || '%') then
        if char_length(v_norm) >= char_length(v_last.phrase_norm) then                               -- typing on: keep the longer words
          update suqa.search_log set phrase = v_phrase, phrase_norm = v_norm, found = p_found, created_at = now() where id = v_last.id;
        end if;
        return;
      end if;
    end if;
  end if;
  if (select count(*) from suqa.search_log where tenant_id = v_tenant and created_at > now() - interval '1 minute') >= 300 then return; end if;
  insert into suqa.search_log (tenant_id, shop_id, user_id, visitor, phrase, phrase_norm, found)
  values (v_tenant, p_shop, auth.uid(), case when auth.uid() is null then nullif(left(btrim(coalesce(p_visitor, '')), 40), '') end, v_phrase, v_norm, p_found);
exception when others then return;
end $$;
revoke all on function suqa.search_note(uuid, uuid, text, boolean, text) from public;
grant execute on function suqa.search_note(uuid, uuid, text, boolean, text) to anon, authenticated;

-- A tool result as stored (text) → its list of searched phrases; anything else (a draft's answer, an error, broken text) → empty list.
create or replace function suqa._demand_items(p_content text) returns jsonb
language plpgsql immutable set search_path = public as $$
declare j jsonb;
begin
  if p_content is null or left(ltrim(p_content), 1) <> '[' then return '[]'::jsonb; end if;
  j := p_content::jsonb;
  if jsonb_typeof(j) <> 'array' then return '[]'::jsonb; end if;
  return j;
exception when others then return '[]'::jsonb;
end $$;
revoke all on function suqa._demand_items(text) from public, anon, authenticated;

-- Every request of the period, one row each. Internal: the two functions below check who is asking.
--   source: 'yorgo_app' (chat on the storefront), 'yorgo_whatsapp', 'search' (a search box).
--   who:    one key per person — the account, else the WhatsApp phone, else the visitor key; null = unknown visitor.
create or replace function suqa._demand_rows(p_tenant uuid, p_since timestamptz)
returns table (phrase text, phrase_norm text, found boolean, source text, shop_id uuid, user_id uuid, wa_phone text, who text, at timestamptz)
language sql stable security definer set search_path = public as $$
  select y.phrase, suqa.norm_text(y.phrase), y.found, y.source, null::uuid, y.user_id, y.wa_phone, coalesce(y.user_id::text, y.wa_phone), y.at
  from (
    select btrim(left(it->>'phrase', 80)) as phrase,
           coalesce((select max((c->>'score')::numeric) from jsonb_array_elements(case when jsonb_typeof(it->'candidates') = 'array' then it->'candidates' else '[]'::jsonb end) c
                     where (c->>'score') ~ '^[0-9.]+$'), 0) >= 0.45 as found,
           case when cv.wa_phone is not null or cv.channel = 'whatsapp' then 'yorgo_whatsapp' else 'yorgo_app' end as source,
           cv.user_id, cv.wa_phone, m.created_at as at
    from suqa.yorgo_messages m
    join suqa.yorgo_conversations cv on cv.id = m.conversation_id
    cross join lateral jsonb_array_elements(case when jsonb_typeof(m.content) = 'array' then m.content else '[]'::jsonb end) b
    cross join lateral jsonb_array_elements(suqa._demand_items(b->>'content')) it
    where m.tenant_id = p_tenant and m.role = 'tool' and m.created_at >= p_since and cv.mode = 'shopper'
      and b->>'type' = 'tool_result' and jsonb_typeof(it) = 'object' and it ? 'phrase' and it ? 'candidates'
  ) y
  where char_length(y.phrase) >= 2 and suqa.norm_text(y.phrase) <> ''
  union all
  select s.phrase, s.phrase_norm, s.found, 'search', s.shop_id, s.user_id, null::text, coalesce(s.user_id::text, s.visitor), s.created_at
  from suqa.search_log s where s.tenant_id = p_tenant and s.created_at >= p_since;
$$;
revoke all on function suqa._demand_rows(uuid, timestamptz) from public, anon, authenticated;

-- The report: one line per phrase (spelling folded), most asked first. p_days 1..365.
--   { days, total, not_found, people, phrases: [{ key, phrase, times, people, found, not_found, yorgo_app, yorgo_whatsapp, search, last_at }] }
--   "phrase" is the spelling used most; "people" counts the persons we can tell apart (accounts, WhatsApp phones, visitor tabs).
create or replace function suqa.demand_report(p_tenant uuid, p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_days int := greatest(1, least(365, coalesce(p_days, 30))); v_since timestamptz; v jsonb;
begin
  if not (suqa.is_tenant_admin(p_tenant) or suqa.is_platform_admin()) then raise exception 'not_allowed'; end if;
  v_since := now() - make_interval(days => v_days);
  with r as (select * from suqa._demand_rows(p_tenant, v_since)),
  spell as (select distinct on (phrase_norm) phrase_norm, phrase from (select phrase_norm, phrase, count(*) n, max(at) l from r group by 1, 2) x order by phrase_norm, n desc, l desc),
  g as (
    select r.phrase_norm, count(*) times, count(distinct r.who) people,
           count(*) filter (where r.found) found, count(*) filter (where not r.found) not_found,
           count(*) filter (where r.source = 'yorgo_app') yorgo_app, count(*) filter (where r.source = 'yorgo_whatsapp') yorgo_whatsapp,
           count(*) filter (where r.source = 'search') search, max(r.at) last_at
    from r group by r.phrase_norm)
  select jsonb_build_object(
    'days', v_days,
    'total', (select count(*) from r),
    'not_found', (select count(*) from r where not r.found),
    'people', (select count(distinct who) from r),
    'phrases', coalesce((select jsonb_agg(to_jsonb(t) order by t.times desc, t.last_at desc) from (
        select g.phrase_norm as key, s.phrase, g.times, g.people, g.found, g.not_found, g.yorgo_app, g.yorgo_whatsapp, g.search, g.last_at
        from g join spell s using (phrase_norm) order by g.times desc, g.last_at desc limit 300) t), '[]'::jsonb))
  into v;
  return v;
end $$;
revoke all on function suqa.demand_report(uuid, int) from public, anon;
grant execute on function suqa.demand_report(uuid, int) to authenticated;

-- Who asked for one phrase (p_key = the report line's key). Name and phone from the person's account; on WhatsApp the phone,
-- and the name when that phone has an account. A visitor who is not signed in has neither: counted, shown as a visitor.
--   [{ name, phone, source, shop_id, times, found, last_at, as_written }]
create or replace function suqa.demand_people(p_tenant uuid, p_key text, p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_days int := greatest(1, least(365, coalesce(p_days, 30))); v jsonb;
begin
  if not (suqa.is_tenant_admin(p_tenant) or suqa.is_platform_admin()) then raise exception 'not_allowed'; end if;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.last_at desc), '[]'::jsonb) into v from (
    select coalesce(p.full_name, wp.full_name) as name,
           coalesce(case when x.wa_phone is not null then '+' || x.wa_phone end, p.phone) as phone,
           x.source, x.shop_id, x.times, x.found, x.last_at, x.as_written
    from (
      select r.who, r.source, r.shop_id, (array_agg(r.user_id))[1] user_id, max(r.wa_phone) wa_phone, count(*) times, bool_or(r.found) found, max(r.at) last_at,
             (array_agg(r.phrase order by r.at desc))[1] as_written
      from suqa._demand_rows(p_tenant, now() - make_interval(days => v_days)) r
      where r.phrase_norm = p_key group by r.who, r.source, r.shop_id) x
    left join suqa.profiles p on p.id = x.user_id
    left join lateral (select q.full_name from suqa.profiles q
                       where x.wa_phone is not null and q.phone is not null and regexp_replace(q.phone, '\D', '', 'g') = x.wa_phone limit 1) wp on true
    order by x.last_at desc limit 200) t;
  return v;
end $$;
revoke all on function suqa.demand_people(uuid, text, int) from public, anon;
grant execute on function suqa.demand_people(uuid, text, int) to authenticated;

select 'demand report installed' as result;
