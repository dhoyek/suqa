-- 58_internal_fn_lockdown.sql — internal helper functions are no longer callable from the API.   (2026-11-12)
-- Functions whose name starts with "_" (suqa._pos_sale_commit, _pos_order_edit, _order_recalc, _account_delete_impl …) are steps
-- of a public function: pos_push checks the device, the caller's membership and role and THEN calls _pos_*; the admin functions
-- check _admin_guard and then call _account_*. They are SECURITY DEFINER, and Postgres/Supabase grant EXECUTE on new functions to
-- everyone by default — so each could also be called directly through the REST API (/rpc/_pos_order_edit …) with a hand-made
-- device row, skipping every check. This file removes that direct access:
--   * every SECURITY DEFINER function in schema suqa whose name starts with "_": EXECUTE revoked from public, anon, authenticated;
--     kept for service_role (server routes / webhooks).
--   * they keep working where they are meant to: called from inside pos_push / the admin functions / triggers, which run with the
--     owner's rights.
--   * no exceptions: the one helper the web app called directly (_account_in_tenant, admin accounts page) now goes through the
--     server's service key.
-- RE-RUN THIS FILE after adding any new internal function (new functions get the default grants again). Idempotent.

do $$
declare f record; v_service boolean := exists (select 1 from pg_roles where rolname = 'service_role');
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
     where p.pronamespace = 'suqa'::regnamespace and p.proname like '\_%' and p.prosecdef
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if v_service then execute format('grant execute on function %s to service_role', f.sig); end if;
  end loop;
end $$;

-- what is left reachable (expect 0)
select count(*) as internal_functions_still_callable_from_the_api
  from pg_proc p
 where p.pronamespace = 'suqa'::regnamespace and p.proname like '\_%' and p.prosecdef
   and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'));
