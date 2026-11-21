-- 96: item search across shops — every shop that has the thing shows up among the candidates.
--
-- match_items returned the best N candidates of the whole market by score. A shop with many variants of an item (six kinds of
-- labne) took every place, so Yorgo offered one shop although others sell the same thing. When the search is not limited to one
-- shop, the best candidate of EACH shop now comes first (as long as it is about as good as the best one found: within 0.15),
-- then the rest by score as before. A search inside one shop (the POS, "min 3end X", a shop's page) is unchanged, and so are the
-- scores themselves.
--
-- Changes: match_items (two fragments, patched in place — the function is long and live). No table changes.

-- the function carries a pg_trgm setting: the library must be loaded in this session before the function is created again
-- (otherwise "permission denied to set parameter" on Supabase — same as script 84)
select extensions.similarity('a', 'a');

do $$
declare v_def text := pg_get_functiondef('suqa.match_items(uuid,text[],uuid,int)'::regprocedure);
        v_a text := $q$row_number() over (partition by r.no order by r.sc desc, p.is_available desc, length(coalesce(p.name->>'ar', '')) + length(coalesce(p.name->>'en', '')), p.sort_order, p.id) as ord$q$;
        v_b text := $q$  from visible v where v.ord <= v_limit$q$;
begin
  if position('as sord' in v_def) > 0 then return; end if;                                        -- patched already
  if (length(v_def) - length(replace(v_def, v_a, ''))) / length(v_a) <> 1 or (length(v_def) - length(replace(v_def, v_b, ''))) / length(v_b) <> 1 then
    raise exception 'match_items is not as expected: 96 not applied';
  end if;
  v_def := replace(v_def, v_a, replace(v_a, ') as ord', ') as ord0') || $q$,
           row_number() over (partition by r.no, p.shop_id order by r.sc desc, p.is_available desc, length(coalesce(p.name->>'ar', '')) + length(coalesce(p.name->>'en', '')), p.sort_order, p.id) as sord,
           max(r.sc) over (partition by r.no) as top$q$);
  v_def := replace(v_def, v_b, $q$  from (select x.*, row_number() over (partition by x.no order by (case when p_shop is null and x.sord = 1 and x.sc >= x.top - 0.15 then 0 else 1 end), x.ord0) as ord from visible x) v where v.ord <= v_limit$q$);
  execute v_def;
end $$;
