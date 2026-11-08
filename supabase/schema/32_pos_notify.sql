-- 32_pos_notify.sql — per-shop customer notification stages   (2026-11-08)
-- Requires 31. Idempotent. Base file 04 carries the column.
-- shops.notify_stages: which order steps message the customer (null = tenant default: accepted, ready, out_for_delivery, rejected).
alter table suqa.shops add column if not exists notify_stages text[];

-- ---------- event payload (24 + shop.notify_stages; tenant default no longer includes 'delivered') --------------
create or replace function suqa.order_event_payload(p_order suqa.orders, p_event text, p_old_status suqa.order_status)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'event',      p_event,
    'old_status', p_old_status,
    'phone_number_id', suqa.wa_sender_for_order(p_order.id),
    'channel', p_order.channel,
    'order', jsonb_build_object(
      'id', p_order.id, 'number', p_order.number, 'status', p_order.status, 'tenant_id', p_order.tenant_id,
      'basket_id', p_order.basket_id, 'basket_seq', p_order.basket_seq,
      'fulfillment', p_order.fulfillment, 'notify_customer', p_order.notify_customer,
      'customer_name', p_order.customer_name, 'customer_phone', p_order.customer_phone, 'customer_notes', p_order.customer_notes,
      'address', p_order.address, 'subtotal_usd', p_order.subtotal_usd, 'delivery_fee_usd', p_order.delivery_fee_usd,
      'total_usd', p_order.total_usd, 'fx_lbp_rate', p_order.fx_lbp_rate,
      'reject_reason', p_order.reject_reason, 'eta_minutes', p_order.eta_minutes, 'shop_notes', p_order.shop_notes,
      'courier_id', p_order.courier_id, 'placed_at', p_order.placed_at),
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.name, 'unit', i.unit, 'quantity', i.quantity, 'line_total_usd', i.line_total_usd, 'notes', i.notes))
                         from suqa.order_items i where i.order_id = p_order.id and not i.voided), '[]'::jsonb),
    'shop', (select jsonb_build_object('id', s.id, 'slug', s.slug, 'name', s.name, 'whatsapp', s.whatsapp, 'phone', s.phone,
                                       'address', s.address_text, 'location', s.location, 'notify_stages', s.notify_stages)
               from suqa.shops s where s.id = p_order.shop_id),
    'tenant', (select jsonb_build_object('id', t.id, 'slug', t.slug, 'brand_name', t.brand_name, 'default_locale', t.default_locale,
                                         'display_currency', t.display_currency,
                                         'courier_enabled', coalesce((t.settings->>'courier_enabled')::boolean, false),
                                         'delivery_mode', coalesce(t.settings->>'delivery_mode', 'per_shop'),
                                         'notify_stages', coalesce(t.settings->'notify_stages', '["accepted","ready","out_for_delivery","rejected"]'::jsonb))
                 from suqa.tenants t where t.id = p_order.tenant_id),
    'courier_phone', (select p.phone from suqa.profiles p where p.id = p_order.courier_id),
    'couriers', coalesce((select jsonb_agg(p.phone) from suqa.couriers c join suqa.profiles p on p.id = c.user_id
                           where c.tenant_id = p_order.tenant_id and c.is_active and p.phone is not null), '[]'::jsonb)
  )
$$;

-- ---------- shop settings (31 + notify_stages) --------------------------------------------------------------------
create or replace function suqa.pos_shop_settings(p_shop uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if suqa.pos_role(p_shop) <> 'owner' then raise exception 'not_owner' using errcode = 'insufficient_privilege'; end if;
  update suqa.shops set
    default_delivery_fee_usd = coalesce((p_patch->>'default_delivery_fee_usd')::numeric, default_delivery_fee_usd),
    max_discount_pct         = coalesce((p_patch->>'max_discount_pct')::numeric, max_discount_pct),
    lbp_rounding_step        = coalesce((p_patch->>'lbp_rounding_step')::int, lbp_rounding_step),
    allow_negative_stock     = coalesce((p_patch->>'allow_negative_stock')::boolean, allow_negative_stock),
    hide_online_when_zero    = coalesce((p_patch->>'hide_online_when_zero')::boolean, hide_online_when_zero),
    deduct_stock_at          = coalesce(p_patch->>'deduct_stock_at', deduct_stock_at),
    receipt_footer           = case when p_patch ? 'receipt_footer' then p_patch->>'receipt_footer' else receipt_footer end,
    offline_days             = coalesce(least(greatest((p_patch->>'offline_days')::int, 1), 90), offline_days),
    default_margin_pct       = coalesce((p_patch->>'default_margin_pct')::numeric, default_margin_pct),
    scale_prefix             = case when p_patch ? 'scale_prefix' then nullif(p_patch->>'scale_prefix', '') else scale_prefix end,
    scale_code_len           = coalesce((p_patch->>'scale_code_len')::int, scale_code_len),
    scale_value_kind         = coalesce(p_patch->>'scale_value_kind', scale_value_kind),
    scale_value_divisor      = coalesce((p_patch->>'scale_value_divisor')::int, scale_value_divisor),
    notify_stages            = case when p_patch ? 'notify_stages' then (select array_agg(x) from jsonb_array_elements_text(p_patch->'notify_stages') x) else notify_stages end
  where id = p_shop;
  insert into suqa.audit_log (shop_id, tenant_id, user_id, action, ref_tbl, ref_id, after)
  select p_shop, tenant_id, auth.uid(), 'shop.settings', 'shops', p_shop::text, p_patch from suqa.shops where id = p_shop;
  return (select to_jsonb(s) - 'printer' from suqa.shops s where id = p_shop);
end $$;
grant execute on function suqa.pos_shop_settings(uuid, jsonb) to authenticated;

select 'pos notify installed' as result;
