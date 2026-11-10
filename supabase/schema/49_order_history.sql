-- 49_order_history.sql — one read for the POS order detail sheet: timeline, edits, payments, debt allocations,
-- returns, stock moves, WhatsApp messages and the customer thread, plus the customer's context. Read-only; shop members + tenant members.
-- Everything here already exists in the tables; nothing new is written. Requires 21, 26, 17.

create or replace function suqa.pos_order_history(p_order uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o suqa.orders; v_role text;
begin
  select * into o from suqa.orders where id = p_order;
  if not found then raise exception 'order_not_found'; end if;
  v_role := suqa.pos_role(o.shop_id);
  if v_role is null and not suqa.is_tenant_member(o.tenant_id) then raise exception 'not_member' using errcode = 'insufficient_privilege'; end if;

  return jsonb_build_object(
    -- status changes + notes (storefront thread) in one list, oldest first
    'events', coalesce((select jsonb_agg(jsonb_build_object('at', e.created_at, 'from', e.from_status, 'to', e.to_status, 'actor', e.actor_kind, 'note', e.note,
                 'by', (select coalesce(sm.display_name, p.full_name) from suqa.profiles p left join suqa.shop_members sm on sm.user_id = p.id and sm.shop_id = o.shop_id where p.id = e.actor_id))
               order by e.created_at) from suqa.order_events e where e.order_id = p_order), '[]'::jsonb),
    -- POS actions on this order from the audit log (edits, pay, status, driver, returns…), with who/which device
    'audit', coalesce((select jsonb_agg(jsonb_build_object('at', a.at, 'action', a.action, 'after', a.after,
                 'by', (select coalesce(sm.display_name, p.full_name) from suqa.profiles p left join suqa.shop_members sm on sm.user_id = p.id and sm.shop_id = o.shop_id where p.id = a.user_id),
                 'device', (select d.name from suqa.devices d where d.id = a.device_id))
               order by a.at) from suqa.audit_log a where a.shop_id = o.shop_id and (a.ref_id = p_order::text or a.after->>'order_id' = p_order::text or a.after->>'id' = p_order::text)), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('at', p.at, 'tender', p.tender, 'currency', p.currency, 'amount', p.amount, 'unpaid_name', p.unpaid_name, 'reference', p.reference) order by p.at)
               from suqa.payments p where p.order_id = p_order), '[]'::jsonb),
    'debt', coalesce((select jsonb_agg(jsonb_build_object('at', ds.at, 'amount_cents', da.amount_cents, 'tender', ds.tender, 'currency', ds.currency, 'amount', ds.amount) order by ds.at)
               from suqa.debt_allocations da join suqa.debt_settlements ds on ds.id = da.settlement_id where da.order_id = p_order), '[]'::jsonb),
    'returns', coalesce((select jsonb_agg(jsonb_build_object('at', r.at, 'number', r.number, 'refund_usd_cents', r.refund_usd_cents, 'refund_lbp', r.refund_lbp, 'reason', r.reason,
                 'lines', (select jsonb_agg(jsonb_build_object('qty', rl.qty, 'destination', rl.destination, 'amount_cents', rl.amount_cents,
                            'name', (select oi.name from suqa.order_items oi where oi.id = rl.order_item_id))) from suqa.return_lines rl where rl.return_id = r.id)) order by r.at)
               from suqa.returns r where r.order_id = p_order), '[]'::jsonb),
    'stock', coalesce((select jsonb_agg(jsonb_build_object('at', s.at, 'kind', s.kind, 'qty', s.qty, 'name', (select pr.name from suqa.products pr where pr.id = s.product_id)) order by s.at)
               from suqa.stock_moves s where s.ref_order_id = p_order), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('at', m.created_at, 'direction', m.direction, 'party', m.party, 'phone', m.phone, 'body', m.body, 'status', m.status, 'error', m.error) order by m.created_at)
               from suqa.wa_messages m where m.order_id = p_order), '[]'::jsonb),
    'customer', (select jsonb_build_object('name', c.name, 'phone', c.phone, 'orders_count', c.orders_count, 'last_order_at', c.last_order_at, 'notes', c.notes,
                   'open_debt_cents', (select coalesce(sum(case when p.currency = 'lbp' then round(p.amount * 100 / nullif(oo.rate_lbp_per_usd, 0)) else p.amount end), 0)
                                        - coalesce((select sum(da.amount_cents) from suqa.debt_allocations da join suqa.orders o2 on o2.id = da.order_id where o2.shop_id = o.shop_id and o2.customer_phone = o.customer_phone), 0)
                                       from suqa.payments p join suqa.orders oo on oo.id = p.order_id where oo.shop_id = o.shop_id and oo.customer_phone = o.customer_phone and p.tender = 'unpaid' and oo.status not in ('cancelled','rejected')))
                 from suqa.shop_customers c where c.shop_id = o.shop_id and c.phone_key = suqa._phone_key(o.customer_phone) limit 1)
  );
end $$;
grant execute on function suqa.pos_order_history(uuid) to authenticated;

select 'order history installed' as result;
