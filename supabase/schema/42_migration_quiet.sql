-- 42_migration_quiet.sql — bulk history stays off the device feed.
-- migrate_apply (38) sets suqa.skip_sync_log = '1' for order/purchase batches: 16k historical receipts are reporting
-- data, not something every phone and PC should download row by row into IndexedDB (the snapshot gives devices the
-- last 7 days; older orders are read from the server). Requires 40 (sync_log_row).

create or replace function suqa.sync_log_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_row jsonb; v_shop uuid; v_tenant uuid; v_id text; v_dev uuid;
begin
  if current_setting('suqa.skip_sync_log', true) = '1' then return null; end if;
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

-- (notify_order_event already ignores channel = 'walkin', which is what migrated receipts are: no webhooks fire for them.)

-- The 430 receipts imported before this file went onto the feed; drop them so devices do not download them
-- (they are already in the orders table; devices read history from the server).
delete from suqa.sync_log where tbl in ('orders','order_items','payments','stock_moves')
  and row_id in (select new_id::text from suqa.migration_map where kind = 'order')
   or (tbl in ('order_items','payments') and (row->>'order_id') in (select new_id::text from suqa.migration_map where kind = 'order'));

-- Receipt numbers: the old POS restarts RCPT_NO daily, so the convert step now uses RCPT_ID ("M-<id>", unique).
-- Re-number the receipts imported before that fix so the whole history follows one rule.
update suqa.orders o set number = 'M-' || m.old_key
  from suqa.migration_map m where m.kind = 'order' and m.new_id = o.id and o.number <> 'M-' || m.old_key;
