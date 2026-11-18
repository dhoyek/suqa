-- 78 — Yorgo: what people asked for and was not found (docs/yorgo/PLAN.md). NOT a log of messages: only the item phrase, counted.
--   A phrase Yorgo reports as "not found" is the best hint a shop can get: either the item is missing from the catalog, or it is
--   there under a name customers do not use (then the shop adds an alias). The association must not read conversations, and it
--   does not need to: this table holds the phrase alone, with a count — no person, no conversation, no message.
--
--   yorgo_misses   one row per (shop or whole market) × phrase: how many times, first and last time, dismissed or not.
--   yorgo_miss     the server records phrases after a draft (service role only).
--   yorgo_miss_dismiss   the shop (owner / stock / association setup) or the association hides a phrase it has dealt with.
-- Idempotent.

create table if not exists suqa.yorgo_misses (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references suqa.tenants(id) on delete cascade,
  shop_id      uuid references suqa.shops(id) on delete cascade,          -- the shop that was searched; null = the whole market (storefront, no shop page)
  phrase       text not null check (char_length(phrase) between 2 and 80), -- as the person wrote it (first time seen)
  phrase_norm  text not null,                                             -- norm_text(phrase): one row per shop and phrase
  times        int  not null default 1,
  first_at     timestamptz not null default now(),
  last_at      timestamptz not null default now(),
  dismissed_at timestamptz,
  dismissed_by uuid
);
create unique index if not exists yorgo_misses_key on suqa.yorgo_misses (tenant_id, coalesce(shop_id, '00000000-0000-0000-0000-000000000000'::uuid), phrase_norm);
create index if not exists yorgo_misses_shop on suqa.yorgo_misses (shop_id, last_at desc);
alter table suqa.yorgo_misses enable row level security;
drop policy if exists yorgo_misses_read on suqa.yorgo_misses;
create policy yorgo_misses_read on suqa.yorgo_misses for select to authenticated
  using (suqa.is_tenant_admin(tenant_id) or suqa.is_platform_admin() or (shop_id is not null and suqa.pos_role(shop_id) in ('owner','stock','setup')));
revoke all on suqa.yorgo_misses from anon, authenticated;
grant select on suqa.yorgo_misses to authenticated;                        -- writes only through the functions below

-- The server records the phrases of one draft. A phrase seen again counts up and comes back if it had been dismissed more than 30 days ago.
create or replace function suqa.yorgo_miss(p_tenant uuid, p_shop uuid, p_phrases text[]) returns void
language plpgsql security definer set search_path = public as $$
declare p text; v_norm text; v_phrase text;
begin
  foreach p in array (coalesce(p_phrases, '{}'::text[]))[1:20] loop
    v_phrase := btrim(left(coalesce(p, ''), 80)); v_norm := suqa.norm_text(v_phrase);
    continue when char_length(v_phrase) < 2 or v_norm = '';
    insert into suqa.yorgo_misses as m (tenant_id, shop_id, phrase, phrase_norm) values (p_tenant, p_shop, v_phrase, v_norm)
    on conflict (tenant_id, coalesce(shop_id, '00000000-0000-0000-0000-000000000000'::uuid), phrase_norm)
    do update set times = m.times + 1, last_at = now(),
      dismissed_at = case when m.dismissed_at < now() - interval '30 days' then null else m.dismissed_at end,
      dismissed_by = case when m.dismissed_at < now() - interval '30 days' then null else m.dismissed_by end;
  end loop;
end $$;
revoke all on function suqa.yorgo_miss(uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function suqa.yorgo_miss(uuid, uuid, text[]) to service_role;

create or replace function suqa.yorgo_miss_dismiss(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v suqa.yorgo_misses;
begin
  select * into v from suqa.yorgo_misses where id = p_id;
  if not found then raise exception 'not_found'; end if;
  if not (suqa.is_tenant_admin(v.tenant_id) or suqa.is_platform_admin() or (v.shop_id is not null and suqa.pos_role(v.shop_id) in ('owner','stock','setup')))
  then raise exception 'not_allowed'; end if;
  update suqa.yorgo_misses set dismissed_at = now(), dismissed_by = auth.uid() where id = p_id;
end $$;
revoke all on function suqa.yorgo_miss_dismiss(uuid) from public, anon;
grant execute on function suqa.yorgo_miss_dismiss(uuid) to authenticated;

select 'yorgo misses installed' as result;
