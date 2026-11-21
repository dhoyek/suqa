-- 92: reports — "by way of paying" counts sales, not payment rows.
--
-- Since 91 a cancelled payment keeps its own row and gets rows that give it back (and the change it gave becomes rows too), so
-- counting rows showed more payments than there were. The count is now the number of sales paid that way: a sale whose rows
-- add up to nothing in a way of paying is not counted there, and a way of paying with nothing left is not listed.
-- The amounts are unchanged. Same rule as the till's own shift summary (pos-core tenderTotals).
--
-- Changes: pos_report (one fragment, patched in place — the function is long and live). No table changes.

do $$
declare v_def text := pg_get_functiondef('suqa.pos_report(uuid,date,date)'::regprocedure);
        v_a text := $q$from (select p.tender, count(*) c, sum(case when p.currency = 'usd' then p.amount else 0 end) u,$q$;
        v_b text := $q$from suqa.payments p join o on o.id = p.order_id group by 1) x),$q$;
begin
  if position('filter (where u <> 0 or l <> 0)' in v_def) > 0 then return; end if;              -- patched already
  if (length(v_def) - length(replace(v_def, v_a, ''))) / length(v_a) <> 1 or (length(v_def) - length(replace(v_def, v_b, ''))) / length(v_b) <> 1 then
    raise exception 'pos_report is not as expected: 92 not applied';
  end if;
  v_def := replace(v_def, v_a, $q$from (select tender, count(*) filter (where u <> 0 or l <> 0) c, sum(u) u, sum(l) l from (select p.tender, p.order_id, sum(case when p.currency = 'usd' then p.amount else 0 end) u,$q$);
  v_def := replace(v_def, v_b, $q$from suqa.payments p join o on o.id = p.order_id group by 1, 2) y group by 1 having bool_or(u <> 0 or l <> 0)) x),$q$);
  execute v_def;
end $$;
