-- 03_identity.sql — profiles, platform_admins, tenant_members   (2026-10-16)

-- Mirror of auth.users with app fields. Created by trigger on sign-up.
-- A profile belongs to the tenant it signed up on (customers are tenant-scoped);
-- staff of several tenants are handled via memberships, not via home_tenant_id.
create table if not exists suqa.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  home_tenant_id  uuid references suqa.tenants(id) on delete set null,
  full_name       text,
  phone           text,                                         -- E.164, copied from auth
  locale          text check (locale in ('ar','en','fr')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists profiles_home_tenant_idx on suqa.profiles(home_tenant_id);

-- Yorgoinc / Dan. Sees and manages every tenant.
create table if not exists suqa.platform_admins (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- Association staff.
create table if not exists suqa.tenant_members (
  tenant_id   uuid not null references suqa.tenants(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        suqa.tenant_role not null default 'ops',
  created_at  timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index if not exists tenant_members_user_idx on suqa.tenant_members(user_id);
