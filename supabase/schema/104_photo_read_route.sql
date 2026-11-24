-- 104 — the "fill an item from a photo" task gets its row in the AI routes (Dan, 24 Nov 2026).
--   POS → Items → an item → "Fill from a photo": one photo of the item is read by the model of the route 'photo_read'
--   (the task name has been allowed since script 100), which suggests the names, a short description, the category and
--   the barcode. The person checks and saves; nothing is written to the catalog by the reading itself.
--   The row ships ON, on the model the voice route uses, at that model's text prices (USD per 1M tokens): a photo is about
--   1,500 input tokens and 300 of answer, so well under one cent. Model, prices and the switch are changed on
--   Admin → Yorgo → AI providers (platform admins). The cost of each reading is recorded on the shop's Yorgo usage
--   (seller mode), so the same caps count it.
-- No table is changed: one row is added if it is not there. Idempotent (an existing row is left as it is).
--
-- The table, unchanged (script 100):
--   create table suqa.yorgo_ai_routes (
--     task              text primary key check (task in ('chat','voice','photo_read','image_generate','image_cleanup','bulk_cleanup')),
--     provider          text not null check (provider in ('anthropic','google')),
--     model             text not null check (char_length(model) between 1 and 80),
--     fallback_provider text check (fallback_provider in ('anthropic','google')),
--     fallback_model    text check (fallback_model is null or char_length(fallback_model) between 1 and 80),
--     enabled           boolean not null default false,
--     price_in_per_m    numeric(10,4), price_out_per_m numeric(10,4), price_audio_per_m numeric(10,4), price_per_image numeric(10,4),
--     notes             text, updated_at timestamptz not null default now(), updated_by uuid
--   );

insert into suqa.yorgo_ai_routes (task, provider, model, fallback_provider, fallback_model, enabled, price_in_per_m, price_out_per_m, notes)
values ('photo_read', 'google', 'gemini-4-hydrogen', 'google', 'gemini-3.5-flash-lite', true, 1.50, 7.50, 'Item photo → names, description, category, barcode (POS item editor). Prices: estimates, as for voice.')
on conflict (task) do nothing;

select 'photo read route installed' as result;
