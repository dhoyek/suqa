-- 40_sync_quiet.sql — stop the sync-log feedback storm.
-- Problem: pos_pull/pos_push update devices.last_sync_at on every call; the devices trigger logged each of those as a
-- feed row, Realtime poked every online device, each poked device pulled → wrote another row → … 92% of sync_log
-- (420k rows) was device heartbeats and every device had to download them all.
-- Fix: (1) heartbeat-only device updates are no longer logged; (2) pos_pull returns the shop's device list with every
-- page so the Settings device list still shows fresh "last sync" times; (3) purge the historic heartbeat rows.
-- Requires: 21..39.

create or replace function suqa.sync_log_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_row jsonb; v_shop uuid; v_tenant uuid; v_id text; v_dev uuid;
begin
  -- devices: only membership-relevant changes travel through the feed (name, revocation, registration), not heartbeats
  if tg_table_name = 'devices' and tg_op = 'UPDATE'
     and (to_jsonb(new) - 'last_sync_at' - 'last_cursor' - 'pending_count' - 'app_version' - 'user_agent' - 'updated_at')
       = (to_jsonb(old) - 'last_sync_at' - 'last_cursor' - 'pending_count' - 'app_version' - 'user_agent' - 'updated_at') then
    return null;
  end if;
  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_tenant := (v_row->>'tenant_id')::uuid;
  v_shop   := (v_row->>'shop_id')::uuid;
  if tg_table_name = 'shops' then v_shop := (v_row->>'id')::uuid; end if;
  if tg_table_name = 'shop_members' then
    v_id := (v_row->>'shop_id') || ':' || (v_row->>'user_id');
    select tenant_id into v_tenant from suqa.shops where id = v_shop;
  elsif tg_table_name = 'product_barcodes' then
    v_id := (v_row->>'product_id') || ':' || (v_row->>'barcode');
  else
    v_id := v_row->>'id';
  end if;
  if tg_table_name = 'shops' then
    v_row := v_row - 'commission_rate' - 'cover_url' - 'location';
  end if;
  v_dev := nullif(current_setting('suqa.device', true), '')::uuid;
  insert into suqa.sync_log (tenant_id, shop_id, tbl, row_id, op, row, origin_device)
  values (v_tenant, v_shop, tg_table_name, v_id, case when tg_op = 'DELETE' then 'delete' else 'upsert' end, v_row, v_dev);
  return null;
end $$;

create or replace function suqa.pos_pull(p_device uuid, p_cursor bigint, p_limit int default 1000)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_dev suqa.devices; v_role text; v_rows jsonb; v_next bigint; v_oldest bigint; v_count int;
begin
  select * into v_dev from suqa.devices where id = p_device;
  if not found then raise exception 'device_not_found'; end if;
  if v_dev.revoked_at is not null then raise exception 'device_revoked'; end if;
  v_role := suqa.pos_role(v_dev.shop_id);
  if v_role is null then raise exception 'not_a_member' using errcode = 'insufficient_privilege'; end if;

  select min(seq) into v_oldest from suqa.sync_log where shop_id = v_dev.shop_id or (shop_id is null and tenant_id = v_dev.tenant_id);
  if p_cursor > 0 and v_oldest is not null and p_cursor < v_oldest - 1 then
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
                            'device', jsonb_build_object('id', v_dev.id, 'prefix', v_dev.prefix, 'name', v_dev.name),
                            'devices', (select coalesce(jsonb_agg(to_jsonb(d)), '[]') from suqa.devices d where d.shop_id = v_dev.shop_id));
end $$;
grant execute on function suqa.pos_pull(uuid, bigint, int) to authenticated;

-- Purge the heartbeat rows already logged. Devices rows that were not heartbeats (name/revocation changes) are kept
-- by keeping the last row per device; a device behind the purge still gets the fresh list from every pull anyway.
delete from suqa.sync_log l
 where l.tbl = 'devices'
   and l.seq < (select max(seq) from suqa.sync_log x where x.tbl = 'devices' and x.row_id = l.row_id);
