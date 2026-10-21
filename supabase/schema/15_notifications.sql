-- 15_notifications.sql — outbound order events → web app → WhatsApp                 (2026-10-21)
-- A trigger on suqa.orders posts a self-contained JSON payload (order, items, shop, tenant, courier phones)
-- to the web app's /api/wa/events endpoint via pg_net. The endpoint needs no database access of its own.
-- The target URL and shared secret live in suqa.integration_config (postgres-only; no grants to app roles).

create extension if not exists pg_net with schema extensions;

create table if not exists suqa.integration_config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
revoke all on suqa.integration_config from anon, authenticated;
alter table suqa.integration_config enable row level security;      -- no policies → app roles see nothing

-- Build the notification payload for one order.
create or replace function suqa.order_event_payload(p_order suqa.orders, p_event text, p_old_status suqa.order_status)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'event',      p_event,
    'old_status', p_old_status,
    'order', jsonb_build_object(
      'id', p_order.id, 'number', p_order.number, 'status', p_order.status,
      'basket_id', p_order.basket_id, 'basket_seq', p_order.basket_seq,
      'customer_name', p_order.customer_name, 'customer_phone', p_order.customer_phone, 'customer_notes', p_order.customer_notes,
      'address', p_order.address, 'subtotal_usd', p_order.subtotal_usd, 'delivery_fee_usd', p_order.delivery_fee_usd,
      'total_usd', p_order.total_usd, 'fx_lbp_rate', p_order.fx_lbp_rate,
      'reject_reason', p_order.reject_reason, 'eta_minutes', p_order.eta_minutes, 'shop_notes', p_order.shop_notes,
      'courier_id', p_order.courier_id, 'placed_at', p_order.placed_at),
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.name, 'unit', i.unit, 'quantity', i.quantity, 'line_total_usd', i.line_total_usd, 'notes', i.notes))
                         from suqa.order_items i where i.order_id = p_order.id), '[]'::jsonb),
    'shop', (select jsonb_build_object('id', s.id, 'slug', s.slug, 'name', s.name, 'whatsapp', s.whatsapp, 'phone', s.phone)
               from suqa.shops s where s.id = p_order.shop_id),
    'tenant', (select jsonb_build_object('id', t.id, 'slug', t.slug, 'brand_name', t.brand_name, 'default_locale', t.default_locale,
                                         'display_currency', t.display_currency,
                                         'courier_enabled', coalesce((t.settings->>'courier_enabled')::boolean, false),
                                         'delivery_mode', coalesce(t.settings->>'delivery_mode', 'per_shop'))
                 from suqa.tenants t where t.id = p_order.tenant_id),
    'courier_phone', (select p.phone from suqa.profiles p where p.id = p_order.courier_id),
    'couriers', coalesce((select jsonb_agg(p.phone) from suqa.couriers c join suqa.profiles p on p.id = c.user_id
                           where c.tenant_id = p_order.tenant_id and c.is_active and p.phone is not null), '[]'::jsonb)
  )
$$;

-- Fire-and-forget HTTP post (pg_net is async; failures never block the order).
create or replace function suqa.notify_order_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_url text; v_secret text; v_event text;
begin
  if tg_op = 'INSERT' then v_event := 'order.created';
  elsif new.status is distinct from old.status then v_event := 'order.status';
  else return new; end if;

  select value into v_url    from suqa.integration_config where key = 'wa_events_url';
  select value into v_secret from suqa.integration_config where key = 'wa_events_secret';
  if v_url is null or v_secret is null then return new; end if;

  perform net.http_post(
    url     := v_url,
    body    := suqa.order_event_payload(new, v_event, case when tg_op = 'UPDATE' then old.status end),
    headers := jsonb_build_object('content-type', 'application/json', 'x-suqa-secret', v_secret),
    timeout_milliseconds := 8000);
  return new;
end $$;

drop trigger if exists orders_notify on suqa.orders;
create trigger orders_notify after insert or update of status on suqa.orders
  for each row execute function suqa.notify_order_event();

-- Configure (run once per environment; values are environment-specific):
-- insert into suqa.integration_config(key, value) values
--   ('wa_events_url',    'https://suqa-dev.netlify.app/api/wa/events'),
--   ('wa_events_secret', '<same value as Netlify SUQA_EVENTS_SECRET>')
-- on conflict (key) do update set value = excluded.value, updated_at = now();

select 'notifications installed' as result;
