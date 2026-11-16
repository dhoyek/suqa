-- 70 — SECURITY FIX: owner-only POS functions were open to any signed-in user.
--   The gate was written   if suqa.pos_role(p_shop) <> 'owner' then raise …
--   For someone who is not a member of the shop pos_role() is NULL, and NULL <> 'owner' is NULL (not true),
--   so the exception was never raised: a customer account could call pos_export, pos_report, pos_staff_list,
--   pos_shop_settings, pos_staff_set, pos_set_pin, pos_bulk_price, pos_import_products … for any shop.
--   Fix: every such comparison becomes   pos_role(…) is distinct from 'owner'   (NULL is then "not the owner").
--   The functions are patched in place from their current definitions, so nothing else in them changes;
--   the script stops if a gate it expects is not found, and lists what it changed.
-- No table changes. Idempotent (a second run finds nothing left to patch).

do $$
declare r record; v_def text; v_new text; v_n int := 0; v_names text := '';
begin
  for r in
    select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'suqa' and p.prokind = 'f' and p.prosrc ~ 'pos_role\([^)]*\)\s*<>\s*''owner'''
     order by p.proname
  loop
    v_def := pg_get_functiondef(r.oid);
    v_new := regexp_replace(v_def, '(suqa\.pos_role\([^)]*\))\s*<>\s*''owner''', '\1 is distinct from ''owner''', 'g');
    if v_new = v_def then raise exception 'could not patch %', r.proname; end if;
    execute v_new;
    v_n := v_n + 1; v_names := v_names || ' ' || r.proname;
  end loop;
  raise notice 'owner gate fixed in % function(s):%', v_n, v_names;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'suqa' and p.prosrc ~ 'pos_role\([^)]*\)\s*(<>|!=)\s*''') then
    raise exception 'a pos_role comparison with <> is still present';
  end if;
end $$;

select 'owner gate fix installed' as result;
