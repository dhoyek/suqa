-- 63_sync_log_prune.sql — keep the change feed small.   (2026-11-14)
-- suqa.sync_log holds a full copy of every changed row so the tills can pull changes. It was pruned by age only (30 days) and
-- the nightly job was never scheduled on this project (pg_cron was not enabled) — after one week with the pilot's data it was
-- 407 MB of a 470 MB database.
-- A feed row is useless once every live till of the shop has pulled past it, so pruning now follows the tills:
--   * per shop: everything below the slowest live device's cursor goes (a "live" device = not revoked, synced in the last 30 days);
--     one already-pulled row is kept as an anchor so pos_pull does not mistake the gap for "too far behind" and force a resync
--   * a shop with no live device keeps only its newest row (a new device starts from a snapshot anyway)
--   * rows shared by the association (shop_id null) follow the slowest live device of the whole association
--   * whatever is older than 30 days goes regardless, except the newest row of each scope (a device that far behind takes a
--     fresh snapshot — existing behaviour; the kept row stops an up-to-date till of a quiet shop from doing the same)
--   * pos_ops (replay protection) older than 60 days goes, as before
-- Scheduled every night at 03:17 UTC; pg_cron is enabled here if the project allows it. Not callable from the API (61).
-- pos_pull: the "too far behind" test is now made per scope (the shop's rows / the association's shared rows) instead of on the
-- two together — needed for the pruning above and for 64 (a restore drops the shop's rows so every till takes a fresh snapshot).
-- Replaces both functions of 21 (base file updated). Idempotent.

create or replace function suqa.pos_prune_sync_log() returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0; m int; r record; v_min bigint; v_anchor bigint; v_newest bigint;
begin
  for r in select distinct shop_id from suqa.sync_log where shop_id is not null loop
    select min(last_cursor) into v_min from suqa.devices
     where shop_id = r.shop_id and revoked_at is null and last_sync_at > now() - interval '30 days';
    select max(seq) into v_newest from suqa.sync_log where shop_id = r.shop_id;
    if v_min is null then v_anchor := v_newest;
    else select max(seq) into v_anchor from suqa.sync_log where shop_id = r.shop_id and seq <= v_min; end if;
    delete from suqa.sync_log
     where shop_id = r.shop_id and (seq < coalesce(v_anchor, 0) or (at < now() - interval '30 days' and seq < v_newest));
    get diagnostics m = row_count; n := n + m;
  end loop;
  for r in select distinct tenant_id from suqa.sync_log where shop_id is null loop
    select min(last_cursor) into v_min from suqa.devices
     where tenant_id = r.tenant_id and revoked_at is null and last_sync_at > now() - interval '30 days';
    select max(seq) into v_newest from suqa.sync_log where shop_id is null and tenant_id = r.tenant_id;
    if v_min is null then v_anchor := v_newest;
    else select max(seq) into v_anchor from suqa.sync_log where shop_id is null and tenant_id = r.tenant_id and seq <= v_min; end if;
    delete from suqa.sync_log
     where shop_id is null and tenant_id = r.tenant_id and (seq < coalesce(v_anchor, 0) or (at < now() - interval '30 days' and seq < v_newest));
    get diagnostics m = row_count; n := n + m;
  end loop;
  delete from suqa.pos_ops where applied_at < now() - interval '60 days';
  return n;
end $$;
revoke all on function suqa.pos_prune_sync_log() from public, anon, authenticated;

create or replace function suqa.pos_pull(p_device uuid, p_cursor bigint, p_limit int default 1000)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_dev suqa.devices; v_role text; v_rows jsonb; v_next bigint; v_oldest bigint; v_oldest_t bigint; v_count int;
begin
  select * into v_dev from suqa.devices where id = p_device;
  if not found then raise exception 'device_not_found'; end if;
  if v_dev.revoked_at is not null then raise exception 'device_revoked'; end if;
  v_role := suqa.pos_role(v_dev.shop_id);
  if v_role is null then raise exception 'not_a_member' using errcode = 'insufficient_privilege'; end if;

  -- too far behind = the feed no longer reaches back to this till's cursor. Checked per scope (63): the shop's own rows and the
  -- association's shared rows are pruned separately, and a restore (64) drops the shop's rows on purpose to make every till resnapshot.
  select min(seq) into v_oldest from suqa.sync_log where shop_id = v_dev.shop_id;
  select min(seq) into v_oldest_t from suqa.sync_log where shop_id is null and tenant_id = v_dev.tenant_id;
  if p_cursor > 0 and ((v_oldest is not null and p_cursor < v_oldest - 1) or (v_oldest_t is not null and p_cursor < v_oldest_t - 1)) then
    return jsonb_build_object('resync', true, 'cursor', 0, 'server_now', now());
  end if;

  with page as (
    select seq, tbl, row_id, op, origin_device,
           case when tbl in ('products','order_items') and v_role <> 'owner' then row - 'cost_cents' else row end as row
      from suqa.sync_log
     where seq > p_cursor
       and (shop_id = v_dev.shop_id or (shop_id is null and tenant_id = v_dev.tenant_id))
     order by seq
     limit greatest(1, least(p_limit, 2000)))
  select coalesce(jsonb_agg(to_jsonb(page) order by seq), '[]'::jsonb), max(seq), count(*) into v_rows, v_next, v_count from page;

  update suqa.devices set last_sync_at = now(), last_cursor = greatest(last_cursor, coalesce(v_next, p_cursor)) where id = p_device;
  return jsonb_build_object('rows', v_rows, 'cursor', coalesce(v_next, p_cursor), 'count', v_count,
                            'server_now', now(), 'role', v_role,
                            'device', jsonb_build_object('id', v_dev.id, 'prefix', v_dev.prefix, 'name', v_dev.name));
end $$;

do $$ begin
  begin create extension if not exists pg_cron; exception when others then raise notice 'pg_cron not available here: %', sqlerrm; end;
  begin
    perform cron.unschedule('suqa-pos-prune');
  exception when others then null; end;
  begin
    perform cron.schedule('suqa-pos-prune', '17 3 * * *', $c$select suqa.pos_prune_sync_log()$c$);
  exception when others then raise notice 'nightly prune NOT scheduled (pg_cron missing) — run select suqa.pos_prune_sync_log() by hand or enable pg_cron';
  end;
end $$;

select suqa.pos_prune_sync_log() as feed_rows_removed_now;
