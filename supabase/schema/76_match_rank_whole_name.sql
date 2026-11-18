-- 76 — Item matching: rank the closest NAME first when several items contain the same word.
--   Found on prod: "khebez" returned two crouton items ("… خبز محمّص …") ahead of "خبز عربي". All three contain خبز and scored the same,
--   because closeness to the whole name was measured by spelling only — a Latin phrase against an Arabic name always gave 0.
--   Now the whole-name term is also measured by sound (the consonant skeleton), and equal scores go to the shorter name.
--   Only suqa.match_items changes (same signature, same access rules). No table changes. Idempotent.

-- load pg_trgm in this session first: until then its settings are unknown names, and a function may not be created with `set pg_trgm.…`
select extensions.similarity('a', 'a') as pg_trgm_loaded;

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
           -- how close the phrase is to the WHOLE name — by spelling, and by sound so a Latin phrase is compared with an Arabic name too.
           -- This is what puts "خبز عربي" ahead of "ماكسيمز خبز محمّص سادة 75 غ" for "khebez": both contain the word, the shorter name is the closer one.
           greatest(similarity(q.qn, s.name_ar), similarity(q.qn, s.name_en),
                    case when length(replace(q.qs, ' ', '')) >= 3
                         then greatest(similarity(q.qs, suqa.skel_text(s.name_ar)), similarity(q.qs, suqa.skel_text(s.name_en))) * 0.9 else 0 end) as whole
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
           row_number() over (partition by r.no order by r.sc desc, p.is_available desc, length(coalesce(p.name->>'ar', '')) + length(coalesce(p.name->>'en', '')), p.sort_order, p.id) as rn
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

select 'match ranking updated' as result;
