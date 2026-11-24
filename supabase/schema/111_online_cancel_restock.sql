-- 111: an ONLINE order cancelled (or rejected) after its stock was taken gives the stock back.
--   Before: the cancel only released a reservation that was still open; once the items had left the shelf (at "ready" or at
--   "delivered", as the shop chose), a cancel left the shop's stock lower by those items for good.
--   Now orders_stock_on_status, on cancelled / rejected, also writes a 'return' move per product for what the order's 'sale' and
--   'return' moves still add up to — the rule WhatsApp / phone orders already follow. It is counted from the moves, so a second
--   pass adds nothing.
--   pos_order_reopen (110) follows: reopening such an order takes those items again (only if they are still free), instead of
--   finding them still taken.
--   No table change. No old order needs correcting: neither database has an online order cancelled after its stock was taken.
-- Safe to run twice.

CREATE OR REPLACE FUNCTION suqa.orders_stock_on_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_at text; v_item record;
begin
  if new.channel <> 'online' or new.status = old.status then return new; end if;
  select deduct_stock_at into v_at from suqa.shops where id = new.shop_id;

  if new.status::text = v_at or (new.status = 'delivered' and v_at = 'ready') then
    for v_item in select i.product_id, i.quantity from suqa.order_items i join suqa.products p on p.id = i.product_id
                   where i.order_id = new.id and p.track_stock and not i.voided loop
      if not exists (select 1 from suqa.stock_moves m where m.ref_order_id = new.id and m.product_id = v_item.product_id and m.kind = 'sale') then
        insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, ref_order_id)
        values (gen_random_uuid(), new.shop_id, new.tenant_id, v_item.product_id, -v_item.quantity, 'sale', new.id);
        if exists (select 1 from suqa.stock_moves m where m.ref_order_id = new.id and m.product_id = v_item.product_id and m.kind = 'reserve')
           and not exists (select 1 from suqa.stock_moves m where m.ref_order_id = new.id and m.product_id = v_item.product_id and m.kind = 'release') then
          insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, ref_order_id)
          values (gen_random_uuid(), new.shop_id, new.tenant_id, v_item.product_id, -v_item.quantity, 'release', new.id);
        end if;
      end if;
    end loop;
  elsif new.status in ('rejected','cancelled') then
    for v_item in select m.product_id, m.qty from suqa.stock_moves m
                   where m.ref_order_id = new.id and m.kind = 'reserve'
                     and not exists (select 1 from suqa.stock_moves r where r.ref_order_id = new.id and r.product_id = m.product_id and r.kind = 'release') loop
      insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, ref_order_id)
      values (gen_random_uuid(), new.shop_id, new.tenant_id, v_item.product_id, -v_item.qty, 'release', new.id);
    end loop;
    -- 111: what the order had already taken from the shelf comes back — per product, what its 'sale' and 'return' moves still
    -- add up to (the same rule as a WhatsApp / phone order in _pos_order_status). Counted from the moves, so it happens once.
    for v_item in select m.product_id, -sum(m.qty) qty from suqa.stock_moves m
                   where m.ref_order_id = new.id and m.kind in ('sale', 'return') group by m.product_id having sum(m.qty) < 0 loop
      insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, ref_order_id, note)
      values (gen_random_uuid(), new.shop_id, new.tenant_id, v_item.product_id, v_item.qty, 'return', new.id, 'cancelled');
    end loop;
  end if;
  return new;
end $function$;

create or replace function suqa.pos_order_reopen(p_shop uuid, p_order uuid, p_approved_by uuid default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare o suqa.orders; v_role text := suqa.pos_role(p_shop); v_to suqa.order_status; v_from suqa.order_status; v_last suqa.order_events;
        v_neg boolean; r record; v_need numeric; v_free numeric; v_name text;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if coalesce(v_role, '') not in ('owner', 'cashier') then raise exception 'not_allowed' using errcode = 'insufficient_privilege'; end if;
  if v_role = 'cashier' and p_approved_by is null then raise exception 'owner_approval_required' using errcode = 'insufficient_privilege'; end if;
  select * into o from suqa.orders where id = p_order and shop_id = p_shop for update;
  if not found then raise exception 'order_not_found'; end if;
  if o.status not in ('cancelled', 'rejected') then return jsonb_build_object('ok', true, 'noop', true, 'status', o.status); end if;   -- a second tap, or another till did it
  if o.parked or o.channel = 'walkin' then raise exception 'not_an_order'; end if;
  if exists (select 1 from suqa.audit_log a where a.shop_id = p_shop and a.action = 'order.merged' and a.after->>'from' = o.id::text) then raise exception 'merged'; end if;
  if exists (select 1 from suqa.order_cancel_requests q where q.order_id = o.id and q.status = 'accepted') then raise exception 'cancelled_by_customer'; end if;
  select * into v_last from suqa.order_events e where e.order_id = o.id and e.to_status = o.status order by e.created_at desc, e.id desc limit 1;
  if v_last.actor_kind = 'customer' then raise exception 'cancelled_by_customer'; end if;
  v_from := o.status;
  v_to := coalesce(v_last.from_status, (case when o.channel = 'online' and o.status = 'rejected' then 'pending' else 'accepted' end)::suqa.order_status);
  if suqa.order_stage(v_to) is null or v_to = 'delivered' then v_to := 'accepted'; end if;

  select allow_negative_stock into v_neg from suqa.shops where id = p_shop;
  if o.channel = 'online' then
    -- its reservation comes back: the release rows written by the cancel go (a product whose stock was already taken keeps its rows)
    for r in select m.product_id, -sum(m.qty) q from suqa.stock_moves m
              where m.ref_order_id = o.id and m.kind = 'release'
                and not exists (select 1 from suqa.stock_moves s where s.ref_order_id = o.id and s.product_id = m.product_id and s.kind = 'sale')
              group by m.product_id having sum(m.qty) < 0 loop
      select on_hand - reserved, coalesce(name->>'ar', name->>'en') into v_free, v_name from suqa.products where id = r.product_id for update;
      if v_free < r.q then raise exception 'out_of_stock' using detail = v_name; end if;
      delete from suqa.stock_moves m where m.ref_order_id = o.id and m.product_id = r.product_id and m.kind = 'release';
    end loop;
    -- 111: a product whose stock HAD been taken got it back at the cancel — it is taken again, what is missing, if it is still free
    for r in select i.product_id, sum(i.quantity) q from suqa.order_items i join suqa.products p on p.id = i.product_id
              where i.order_id = o.id and not i.voided and p.track_stock
                and exists (select 1 from suqa.stock_moves s where s.ref_order_id = o.id and s.product_id = i.product_id and s.kind = 'sale')
              group by i.product_id loop
      v_need := r.q + coalesce((select sum(m.qty) from suqa.stock_moves m where m.ref_order_id = o.id and m.product_id = r.product_id and m.kind in ('sale', 'return')), 0);
      continue when v_need <= 0;
      select on_hand - reserved, coalesce(name->>'ar', name->>'en') into v_free, v_name from suqa.products where id = r.product_id for update;
      if v_free < v_need then raise exception 'out_of_stock' using detail = v_name; end if;
      insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, ref_order_id, user_id, note)
      values (gen_random_uuid(), o.shop_id, o.tenant_id, r.product_id, -v_need, 'sale', o.id, auth.uid(), 'reopened');
    end loop;
  else
    -- its items leave the shelf again: per product, what the lines need minus what the order's moves still hold
    for r in select i.product_id, sum(i.quantity) q from suqa.order_items i join suqa.products p on p.id = i.product_id
              where i.order_id = o.id and not i.voided and p.track_stock group by i.product_id loop
      v_need := r.q + coalesce((select sum(m.qty) from suqa.stock_moves m where m.ref_order_id = o.id and m.product_id = r.product_id and m.kind in ('sale', 'return')), 0);
      continue when v_need <= 0;
      select on_hand - reserved, coalesce(name->>'ar', name->>'en') into v_free, v_name from suqa.products where id = r.product_id for update;
      if v_free < v_need and not coalesce(v_neg, false) then raise exception 'out_of_stock' using detail = v_name; end if;
      insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, ref_order_id, user_id, note)
      values (gen_random_uuid(), o.shop_id, o.tenant_id, r.product_id, -v_need, 'sale', o.id, auth.uid(), 'reopened');
    end loop;
  end if;

  perform set_config('suqa.reopen', o.id::text, true);
  update suqa.orders set status = v_to, cancel_reason = null, reject_reason = null where id = o.id;
  perform set_config('suqa.reopen', '', true);
  insert into suqa.audit_log (shop_id, tenant_id, user_id, action, ref_tbl, ref_id, after)
  values (p_shop, o.tenant_id, auth.uid(), 'order.reopen', 'orders', o.id::text,
          jsonb_build_object('id', o.id, 'number', coalesce(o.number, o.local_number), 'from', v_from, 'status', v_to, 'approved_by', p_approved_by, 'result', jsonb_build_object('status', 'ok')));
  return jsonb_build_object('ok', true, 'status', v_to, 'from', v_from);
end $function$;
revoke all on function suqa.pos_order_reopen(uuid, uuid, uuid) from public, anon;
grant execute on function suqa.pos_order_reopen(uuid, uuid, uuid) to authenticated;
