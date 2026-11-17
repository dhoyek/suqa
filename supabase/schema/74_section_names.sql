-- 74 — Display names for a shop's item sections, in Arabic and English.
--   products.section stays what it is: the section's KEY (free text, often an abbreviation from the shop's old system — "CHOBISC/GUM/BON").
--   shops.section_names  jsonb   { "<section key>": { "ar": "…", "en": "…" }, … }
--   The storefront shows the name in the visitor's language and falls back to the key when a section has no entry.
--   Readable by everyone like the rest of the shop card; written by the shop's owner / the association through the existing shop rules.
-- Base file 04 (shops) lists the column. Idempotent.

alter table suqa.shops add column if not exists section_names jsonb not null default '{}'::jsonb;
alter table suqa.shops drop constraint if exists shops_section_names_obj;
alter table suqa.shops add constraint shops_section_names_obj check (jsonb_typeof(section_names) = 'object');

select 'section names installed' as result;
