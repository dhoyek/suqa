-- 02_tenants.sql — tenants, tenant_domains                (2026-10-16)

-- One row per client (association / municipality / mall). Brand is configuration.
create table if not exists suqa.tenants (
  id                 uuid primary key default gen_random_uuid(),
  slug               citext not null unique,                    -- 'batroun'  → suqa-batroun
  name               text   not null,                           -- 'Batroun Merchants Association'
  brand_name         text   not null,                           -- what shoppers see
  status             suqa.tenant_status not null default 'draft',
  default_locale     text   not null default 'ar' check (default_locale in ('ar','en','fr')),
  locales            text[] not null default array['ar','en'],
  display_currency   suqa.display_currency not null default 'both',
  fx_lbp_rate        numeric(14,2) not null default 89500,      -- LBP per 1 USD, tenant-managed
  commission_rate    numeric(5,4)  not null default 0 check (commission_rate between 0 and 1),
  timezone           text   not null default 'Asia/Beirut',
  country_code       char(2) not null default 'LB',
  center             geography(point, 4326),                    -- map default centre
  branding           jsonb  not null default '{}'::jsonb,       -- logo_url, colors{primary,…}, app_icon_url
  settings           jsonb  not null default '{}'::jsonb,       -- min_order_usd, whatsapp_number, support_phone …
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Hostnames that resolve to a tenant (web). Mobile uses the slug at build time.
create table if not exists suqa.tenant_domains (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references suqa.tenants(id) on delete cascade,
  hostname    citext not null unique,                           -- 'batroun.suqa.app', 'shop.gobatroun.com'
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists tenant_domains_tenant_idx on suqa.tenant_domains(tenant_id);
