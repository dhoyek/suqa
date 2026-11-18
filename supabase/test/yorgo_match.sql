-- Item matching (75): accuracy on the pilot shop's catalog + access rules. Run from the repo root, after smoke.sql:
--   psql -v ON_ERROR_STOP=1 -f supabase/test/yorgo_match.sql
-- Everything happens in one transaction that is rolled back. fixtures/pilot_catalog.tsv holds item names only (no prices, no costs).
begin;
insert into suqa.tenants (id, slug, name, brand_name) values ('7e570000-0000-4000-8000-000000000001', 'yorgo-test', '{"en":"Yorgo test"}', 'Yorgo test');
insert into suqa.shops (id, tenant_id, slug, name, status, pos_enabled) values
  ('7e570000-0000-4000-8000-0000000000a1', '7e570000-0000-4000-8000-000000000001', 'pilot',  '{"en":"Pilot shop"}',  'active', true),
  ('7e570000-0000-4000-8000-0000000000b2', '7e570000-0000-4000-8000-000000000001', 'other',  '{"en":"Other shop"}',  'active', true);
create temp table cat (id uuid, en text, ar text, vis boolean);
\copy cat from 'supabase/test/fixtures/pilot_catalog.tsv'
insert into suqa.products (id, tenant_id, shop_id, name, price_usd, visible_online)
select id, '7e570000-0000-4000-8000-000000000001', '7e570000-0000-4000-8000-0000000000a1', jsonb_build_object('en', en, 'ar', ar), 1, vis from cat;
grant select on cat to anon, authenticated;
create temp table ph (phrase text, want text, kind text);
\copy ph from 'supabase/test/fixtures/yorgo_phrases.tsv'

-- ---- accuracy: is an item matching the expected pattern the first candidate / among the first three? ----
create temp table res as
select p.phrase, p.kind, p.want,
       exists (select 1 from suqa.match_items('7e570000-0000-4000-8000-000000000001', array[p.phrase], '7e570000-0000-4000-8000-0000000000a1', 1) m where m.name->>'en' ~* p.want) as top1,
       exists (select 1 from suqa.match_items('7e570000-0000-4000-8000-000000000001', array[p.phrase], '7e570000-0000-4000-8000-0000000000a1', 3) m where m.name->>'en' ~* p.want) as top3,
       (select m.name->>'en' || ' (' || round(m.score::numeric, 2) || ')' from suqa.match_items('7e570000-0000-4000-8000-000000000001', array[p.phrase], '7e570000-0000-4000-8000-0000000000a1', 1) m) as got
from ph p;
select kind, count(*) as phrases, count(*) filter (where top1) as top1, count(*) filter (where top3) as top3 from res group by rollup(kind) order by kind nulls last;
select phrase, kind, coalesce(got, '— nothing —') as first_candidate, top3 as in_top3 from res where not top1 order by kind, phrase;
do $$ declare n int; t3 int; begin
  select count(*), count(*) filter (where top3) into n, t3 from res;
  if n < 50 then raise exception 'test set too small: %', n; end if;
  if t3::numeric / n < 0.85 then raise exception 'top-3 accuracy fell to % of %', t3, n; end if;
end $$;

-- 76: several items contain خبز; for "khebez" the plain bread must come first, on its own score (not by luck of the order)
do $$ declare v_first text; v_bread real; v_crouton real; begin
  select m.name->>'en' into v_first from suqa.match_items('7e570000-0000-4000-8000-000000000001', array['khebez'], null, 1) m;
  select max(m.score) filter (where m.name->>'en' = 'Arabic bread'), max(m.score) filter (where m.name->>'en' ilike '%crouton%') into v_bread, v_crouton
    from suqa.match_items('7e570000-0000-4000-8000-000000000001', array['khebez'], null, 10) m;
  if v_first is distinct from 'Arabic bread' or v_crouton is null or v_bread <= v_crouton then raise exception 'khebez: bread % vs croutons %, first %', v_bread, v_crouton, v_first; end if;
end $$;

-- ---- access ----
insert into auth.users (id) values ('7e570000-0000-4000-8000-00000000aaaa'), ('7e570000-0000-4000-8000-00000000bbbb'), ('7e570000-0000-4000-8000-00000000cccc');
insert into suqa.shop_members (shop_id, user_id, role) values
  ('7e570000-0000-4000-8000-0000000000a1', '7e570000-0000-4000-8000-00000000aaaa', 'owner'),     -- owner of the pilot shop
  ('7e570000-0000-4000-8000-0000000000b2', '7e570000-0000-4000-8000-00000000bbbb', 'owner');     -- owner of the other shop
update suqa.products set visible_online = false where id = (select id from cat where en = 'Eggs');
update suqa.products set aliases = array['bayd baladi'] where id = (select id from cat where en = 'Eggs');

do $$ declare n int; v_id uuid; v_eggs uuid := (select id from cat where en = 'Eggs'); begin
  -- the public never sees a hidden item; the folded table itself is closed
  set local role anon;
  select count(*) into n from suqa.match_items('7e570000-0000-4000-8000-000000000001', array['eggs']) m where m.product_id = v_eggs;
  if n <> 0 then raise exception 'anon sees a hidden item'; end if;
  begin perform 1 from suqa.product_search limit 1; raise exception 'anon can read product_search';
  exception when insufficient_privilege then null; end;
  reset role;

  -- the shop's own staff see it, and the alias is an exact hit
  perform set_config('request.jwt.claim.sub', '7e570000-0000-4000-8000-00000000aaaa', true); set local role authenticated;
  select count(*) into n from suqa.match_items('7e570000-0000-4000-8000-000000000001', array['bayd baladi'], '7e570000-0000-4000-8000-0000000000a1') m where m.product_id = v_eggs and m.score = 1;
  if n <> 1 then raise exception 'owner does not get the alias as an exact hit'; end if;
  reset role;

  -- another shop's owner is an ordinary visitor here: no hidden item, cannot suggest for it, cannot decide
  perform set_config('request.jwt.claim.sub', '7e570000-0000-4000-8000-00000000bbbb', true); set local role authenticated;
  select count(*) into n from suqa.match_items('7e570000-0000-4000-8000-000000000001', array['eggs'], '7e570000-0000-4000-8000-0000000000a1') m where m.product_id = v_eggs;
  if n <> 0 then raise exception 'another shop''s owner sees a hidden item'; end if;
  perform suqa.alias_suggest(v_eggs, 'bayd');
  reset role;
  if exists (select 1 from suqa.alias_suggestions where product_id = v_eggs) then raise exception 'suggestion accepted for an item the caller cannot see'; end if;

  -- a shopper's pick on a visible item becomes a pending suggestion; a second pick counts; only the shop decides
  perform set_config('request.jwt.claim.sub', '7e570000-0000-4000-8000-00000000cccc', true); set local role authenticated;
  perform suqa.alias_suggest((select id from cat where en = 'Arabic bread'), 'rabta khebez');
  perform suqa.alias_suggest((select id from cat where en = 'Arabic bread'), 'Rabta  Khebez');
  select count(*) into n from suqa.alias_suggestions;          -- RLS: a shopper reads none
  if n <> 0 then raise exception 'a shopper can read suggestions'; end if;
  reset role;
  select id into v_id from suqa.alias_suggestions where phrase_norm = 'rabta khebez' and picks = 2 and status = 'pending';
  if v_id is null then raise exception 'suggestion not recorded as one row with two picks'; end if;

  perform set_config('request.jwt.claim.sub', '7e570000-0000-4000-8000-00000000bbbb', true); set local role authenticated;
  begin perform suqa.alias_decide(v_id, true); raise exception 'another shop''s owner decided';
  exception when others then if sqlerrm <> 'not_allowed' then raise; end if; end;
  reset role;

  perform set_config('request.jwt.claim.sub', '7e570000-0000-4000-8000-00000000aaaa', true); set local role authenticated;
  perform suqa.alias_decide(v_id, true);
  reset role;
  if not exists (select 1 from suqa.products where id = (select id from cat where en = 'Arabic bread') and 'rabta khebez' = any(aliases)) then raise exception 'approved alias not on the item'; end if;
  if not exists (select 1 from suqa.audit_log where action = 'alias.approve' and ref_id = (select id::text from cat where en = 'Arabic bread')) then raise exception 'approval not audited'; end if;
  select count(*) into n from suqa.match_items('7e570000-0000-4000-8000-000000000001', array['rabta khebez']) m where m.score = 1 and m.name->>'en' = 'Arabic bread';
  if n <> 1 then raise exception 'approved alias is not an exact hit for the public'; end if;
end $$;
select 'yorgo match: access rules hold' as result;
rollback;
