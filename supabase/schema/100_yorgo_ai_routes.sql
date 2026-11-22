-- 100 — Yorgo: which AI provider and model does which task (docs/yorgo/PLAN.md, step B1 + W2).
--   yorgo_ai_routes   one row per task: provider, model, optional fallback, on / off, prices, notes.
--                     Platform settings, not one market's: PLATFORM admins only read and write (Admin → Yorgo → AI providers);
--                     the server reads with the service role. API keys are NEVER here: they are secrets of the site.
--   · 'chat' is today's setup and is a record only in this step (the chat still reads its models and prices from the app's configuration).
--   · 'voice' turns a WhatsApp voice note into text. It ships OFF and without prices, and
--     a route cannot be switched on while its prices are empty — otherwise the caps would count nothing.
--   · every change stamps who and when (updated_at / updated_by), whatever the page sends.
-- Idempotent. No change to existing tables.

create table if not exists suqa.yorgo_ai_routes (
  task              text primary key check (task in ('chat','voice','photo_read','image_generate','image_cleanup','bulk_cleanup')),
  provider          text not null check (provider in ('anthropic','google')),
  model             text not null check (char_length(model) between 1 and 80),
  fallback_provider text check (fallback_provider in ('anthropic','google')),
  fallback_model    text check (fallback_model is null or char_length(fallback_model) between 1 and 80),
  enabled           boolean not null default false,
  price_in_per_m    numeric(10,4) check (price_in_per_m  >= 0),   -- USD per 1M input tokens (text)
  price_out_per_m   numeric(10,4) check (price_out_per_m >= 0),   -- USD per 1M output tokens
  price_audio_per_m numeric(10,4) check (price_audio_per_m >= 0), -- USD per 1M audio input tokens (voice)
  price_per_image   numeric(10,4) check (price_per_image >= 0),   -- USD per image (image tasks)
  notes             text check (notes is null or char_length(notes) <= 500),
  updated_at        timestamptz not null default now(),
  updated_by        uuid,
  constraint yorgo_ai_routes_fallback_pair check ((fallback_provider is null) = (fallback_model is null)),
  -- no route runs unpriced: the caps count money
  constraint yorgo_ai_routes_priced check (not enabled or task = 'chat' or (price_out_per_m is not null and (price_in_per_m is not null or price_audio_per_m is not null or price_per_image is not null))),
  -- sound goes to a provider that takes sound
  constraint yorgo_ai_routes_voice_provider check (task <> 'voice' or (provider = 'google' and coalesce(fallback_provider, 'google') = 'google'))
);
alter table suqa.yorgo_ai_routes enable row level security;
drop policy if exists yorgo_ai_routes_admin on suqa.yorgo_ai_routes;
create policy yorgo_ai_routes_admin on suqa.yorgo_ai_routes for all to authenticated using (suqa.is_platform_admin()) with check (suqa.is_platform_admin());
revoke all on suqa.yorgo_ai_routes from anon, authenticated;
grant select, insert, update on suqa.yorgo_ai_routes to authenticated;

-- who changed it and when: set here, not trusted from the page
create or replace function suqa._yorgo_ai_routes_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end $$;
drop trigger if exists yorgo_ai_routes_stamp on suqa.yorgo_ai_routes;
create trigger yorgo_ai_routes_stamp before insert or update on suqa.yorgo_ai_routes for each row execute function suqa._yorgo_ai_routes_stamp();

-- seed: chat = today's setup; voice = Google, off, no prices (the model can be changed on the page)
insert into suqa.yorgo_ai_routes (task, provider, model, enabled) values
  ('chat', 'anthropic', 'claude-sonnet-5-5', true),
  ('voice', 'google', 'gemini-3.5-flash-lite', false)
on conflict (task) do nothing;

select 'yorgo ai routes installed' as result;
