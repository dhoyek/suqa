-- 64_shop_backup_restore.sql — a backup file per shop, and a way to put it back.   (2026-11-14)
-- Three layers protect a shop's data; this file adds the third:
--   1. the till: every operation is written on the device first and stays there until the server confirms it (offline, crash,
--      power cut → nothing typed is lost; it goes up when the till is back)
--   2. the platform: Supabase's own database backups (whole project)
--   3. the shop's own copy: the owner downloads ONE file with everything the shop owns (POS → Settings → backup); kept wherever
--      he likes (USB, Drive). An association admin can load such a file back (Admin → restore).
--
-- BACKUP (owner):  pos_backup_tables(shop) → the list, in restore order, with row counts
--                  pos_backup_page(shop, table, offset, limit) → rows as JSON, in primary-key order (the POS pages through every
--                  table, zips the result and saves it as suqa-backup-<shop>-<date>.json.gz)
-- RESTORE (association admin / platform admin / service key):
--                  pos_restore_page(shop, table, rows) → inserts the rows that are MISSING (by primary key); a row that still
--                  exists is never overwritten, so running a restore twice — or on a healthy shop — changes nothing.
--                  Rows of another shop inside the file are ignored. Triggers are off while the rows go in (the file already
--                  holds the stock movements, totals and numbers as they were — nothing is recomputed or re-notified).
--                  pos_restore_finish(shop) → supplier balances recomputed from their documents, tills told to take a fresh
--                  snapshot, audit entry.
-- What a restore is: exact for an empty shop (new project, or a shop wiped by mistake). For a shop that lost only SOME records
-- it brings those records back; stock on hand of products that still existed is not recomputed — check it afterwards.
-- Not in the file: staff accounts and PINs, devices, the audit log, the association's own data (zones, categories).
-- Requires 60, 61, 62 (functions are private by default: the grants below are explicit). Idempotent.

create or replace function suqa._backup_tables() returns text[] language sql immutable as $$
  select array['suppliers','shop_customers','shop_drivers','products','product_barcodes','exchange_rates','shifts','driver_payouts',
               'orders','order_items','payments','order_events','returns','return_lines','stock_moves','cash_moves',
               'purchases','purchase_lines','supplier_payments','debt_settlements','debt_allocations','order_ratings',
               'quick_buttons','shop_delivery_zones']
$$;

-- "rows of this shop" for a table, as a WHERE on alias t
create or replace function suqa._backup_filter(p_table text) returns text language sql immutable as $$
  select case when p_table = 'order_events' then 't.order_id in (select o.id from suqa.orders o where o.shop_id = $1)' else 't.shop_id = $1' end
$$;

create or replace function suqa.pos_backup_tables(p_shop uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare t text; n bigint; v_out jsonb := '[]'::jsonb;
begin
  if suqa.pos_role(p_shop) is distinct from 'owner' then raise exception 'owner_only' using errcode = 'insufficient_privilege'; end if;
  foreach t in array suqa._backup_tables() loop
    execute format('select count(*) from suqa.%I t where %s', t, suqa._backup_filter(t)) into n using p_shop;
    v_out := v_out || jsonb_build_object('table', t, 'rows', n);
  end loop;
  return jsonb_build_object('version', 1, 'at', now(), 'shop', (select to_jsonb(s) - 'printer' from suqa.shops s where s.id = p_shop), 'tables', v_out);
end $$;

create or replace function suqa.pos_backup_page(p_shop uuid, p_table text, p_offset int default 0, p_limit int default 1000)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_pk text; v_rows jsonb;
begin
  if suqa.pos_role(p_shop) is distinct from 'owner' then raise exception 'owner_only' using errcode = 'insufficient_privilege'; end if;
  if not (p_table = any (suqa._backup_tables())) then raise exception 'unknown_table'; end if;
  select string_agg(format('t.%I', a.attname), ', ' order by array_position(i.indkey::int[], a.attnum::int)) into v_pk
    from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
   where i.indrelid = format('suqa.%I', p_table)::regclass and i.indisprimary;
  execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from (select t.* from suqa.%I t where %s order by %s offset %s limit %s) x',
                 p_table, suqa._backup_filter(p_table), v_pk, greatest(coalesce(p_offset, 0), 0), least(greatest(coalesce(p_limit, 1000), 1), 2000))
    into v_rows using p_shop;
  return v_rows;
end $$;

-- who may restore: platform admin, an admin of the shop's association, or the server's service key
create or replace function suqa._restore_guard(p_shop uuid) returns void
language plpgsql stable security definer set search_path = public as $$
declare v_tenant uuid; v_role text := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role');
begin
  select tenant_id into v_tenant from suqa.shops where id = p_shop;
  if v_tenant is null then raise exception 'shop_not_found'; end if;
  if v_role = 'service_role' or suqa.is_platform_admin() or suqa.is_tenant_admin(v_tenant) then return; end if;
  raise exception 'admin_only' using errcode = 'insufficient_privilege';
end $$;

create or replace function suqa.pos_restore_page(p_shop uuid, p_table text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_cols text; v_n int; v_got int := coalesce(jsonb_array_length(p_rows), 0);
begin
  perform suqa._restore_guard(p_shop);
  if not (p_table = any (suqa._backup_tables())) then raise exception 'unknown_table'; end if;
  if v_got = 0 then return jsonb_build_object('received', 0, 'inserted', 0); end if;
  if v_got > 2000 then raise exception 'too_many_rows'; end if;
  -- only the columns the file has (a column added since the backup takes its default)
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
    from pg_attribute a
   where a.attrelid = format('suqa.%I', p_table)::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
     and (p_rows -> 0) ? a.attname;
  if v_cols is null then raise exception 'no_matching_columns'; end if;
  execute format('alter table suqa.%I disable trigger user', p_table);
  execute format('insert into suqa.%1$I (%2$s) overriding system value select %2$s from jsonb_populate_recordset(null::suqa.%1$I, $2) t where %3$s on conflict do nothing',
                 p_table, v_cols, suqa._backup_filter(p_table)) using p_shop, p_rows;
  get diagnostics v_n = row_count;
  execute format('alter table suqa.%I enable trigger user', p_table);
  return jsonb_build_object('received', v_got, 'inserted', v_n);
end $$;

create or replace function suqa.pos_restore_finish(p_shop uuid, p_inserted int default 0, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; r record; v_seq text;
begin
  perform suqa._restore_guard(p_shop);
  select tenant_id into v_tenant from suqa.shops where id = p_shop;
  for r in select id from suqa.suppliers where shop_id = p_shop loop perform suqa.supplier_recalc(r.id); end loop;
  -- serial keys restored with their old values: keep the counters ahead of them
  v_seq := pg_get_serial_sequence('suqa.order_events', 'id');
  if v_seq is not null then perform setval(v_seq, greatest((select coalesce(max(id), 1) from suqa.order_events), nextval(v_seq))); end if;
  -- the tills hold a copy of the shop: drop its feed and leave a gap so every till takes a fresh snapshot on its next sync
  delete from suqa.sync_log where shop_id = p_shop;
  perform nextval(pg_get_serial_sequence('suqa.sync_log', 'seq')), nextval(pg_get_serial_sequence('suqa.sync_log', 'seq'));
  update suqa.shops set updated_at = now() where id = p_shop;
  insert into suqa.audit_log (shop_id, tenant_id, user_id, action, ref_tbl, ref_id, after)
  values (p_shop, v_tenant, auth.uid(), 'shop.restore', 'shops', p_shop::text, jsonb_build_object('inserted', p_inserted, 'note', p_note));
  return jsonb_build_object('ok', true);
end $$;

revoke all on function suqa._backup_tables() from public, anon, authenticated;
revoke all on function suqa._backup_filter(text) from public, anon, authenticated;
revoke all on function suqa._restore_guard(uuid) from public, anon, authenticated;
revoke all on function suqa.pos_backup_tables(uuid), suqa.pos_backup_page(uuid, text, int, int), suqa.pos_restore_page(uuid, text, jsonb), suqa.pos_restore_finish(uuid, int, text) from public, anon;
grant execute on function suqa.pos_backup_tables(uuid), suqa.pos_backup_page(uuid, text, int, int), suqa.pos_restore_page(uuid, text, jsonb), suqa.pos_restore_finish(uuid, int, text) to authenticated;
do $$ begin if exists (select 1 from pg_roles where rolname = 'service_role') then
  grant execute on function suqa.pos_backup_tables(uuid), suqa.pos_backup_page(uuid, text, int, int), suqa.pos_restore_page(uuid, text, jsonb), suqa.pos_restore_finish(uuid, int, text) to service_role;
end if; end $$;

select 'shop backup / restore installed' as result;
