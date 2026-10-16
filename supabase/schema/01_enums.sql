-- 01_enums.sql — enum types                              (2026-10-16)
do $$ begin
  create type suqa.tenant_status    as enum ('draft', 'live', 'suspended');
  create type suqa.tenant_role      as enum ('admin', 'ops');
  create type suqa.shop_role        as enum ('owner', 'staff');
  create type suqa.shop_status      as enum ('pending', 'active', 'paused', 'disabled');
  create type suqa.display_currency as enum ('usd', 'lbp', 'both');
  create type suqa.payment_method   as enum ('cod', 'card');
  create type suqa.order_status     as enum (
    'pending', 'accepted', 'preparing', 'ready', 'out_for_delivery',
    'delivered', 'rejected', 'cancelled');
  create type suqa.actor_kind       as enum ('customer', 'shop', 'tenant', 'platform', 'system');
exception when duplicate_object then null; end $$;
