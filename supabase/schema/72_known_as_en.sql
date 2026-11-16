-- 72 — A shop's "known as" name in English too.
--   shops.known_as      text   stays the Arabic one (69)
--   shops.known_as_en   text   the same in English / Latin letters ("Abou Elie"); shown to English readers, searchable in both
-- Readable by everyone like the rest of the shop card. Base file 04 (shops) lists the column. Requires 69. Idempotent.

alter table suqa.shops add column if not exists known_as_en text;
alter table suqa.shops drop constraint if exists shops_known_as_en_len;
alter table suqa.shops add constraint shops_known_as_en_len check (known_as_en is null or length(known_as_en) <= 60);

select 'known-as (English) installed' as result;
