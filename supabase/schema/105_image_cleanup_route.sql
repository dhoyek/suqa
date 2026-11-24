-- 105 — the "remove background" task gets its row in the AI routes (Dan, 24 Nov 2026).
--   POS → Items → an item → its photo → "Remove background": the picture is redrawn by an image model on a clean white
--   background, without shadows. The editor shows the original and the cleaned picture side by side and the person taps the
--   one to keep; nothing is replaced by itself (the model can change small print on a pack).
--   The row ships ON, on the faster of the two models tried on real pack photos on 24 Nov ('gemini-3.1-flash-lite-image',
--   3.5–5 s a photo). Its price was NOT on Google's price list that day: the row carries the listed prices of its sibling
--   'gemini-3.1-flash-image' ($0.50 / $60 per 1M tokens, about 8 cents a photo at the tokens the test used) so the caps
--   over-count rather than under-count. Change them on Admin → Yorgo → AI providers once the bill shows the real figure.
--   The cost of each cleaning is recorded on the shop's Yorgo usage (seller mode), so the same caps count it.
-- No table is changed (the task name has been allowed since script 100): one row is added if it is not there. Idempotent.
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

insert into suqa.yorgo_ai_routes (task, provider, model, enabled, price_in_per_m, price_out_per_m, notes)
values ('image_cleanup', 'google', 'gemini-3.1-flash-lite-image', true, 0.50, 60.00, 'Item photo → white background, no shadows (POS item editor). Prices are the sibling model''s list prices: check the bill.')
on conflict (task) do nothing;

select 'image cleanup route installed' as result;
