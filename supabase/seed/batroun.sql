-- seed/batroun.sql — first tenant: suqa-batroun            (2026-10-16)
insert into suqa.tenants (slug, name, brand_name, status, default_locale, locales, display_currency,
                          fx_lbp_rate, commission_rate, center, branding, settings)
values ('batroun', 'Jam3iyet Tejjar al Batroun', 'Batroun Basket', 'draft', 'ar', array['ar','en'], 'both',
        89500, 0, st_setsrid(st_makepoint(35.6581, 34.2553), 4326)::geography,
        '{"colors":{"primary":"#0E7490","accent":"#F59E0B"},"logo_url":null}'::jsonb,
        '{"support_phone":null,"whatsapp_number":null,"min_order_usd":0}'::jsonb)
on conflict (slug) do nothing;

insert into suqa.tenant_domains (tenant_id, hostname, is_primary)
select id, 'batroun.suqa.app', true from suqa.tenants where slug = 'batroun'
on conflict (hostname) do nothing;
insert into suqa.tenant_domains (tenant_id, hostname, is_primary)
select id, 'localhost', false from suqa.tenants where slug = 'batroun'
on conflict (hostname) do nothing;

insert into suqa.order_counters (tenant_id, prefix, last_value)
select id, 'BAT', 0 from suqa.tenants where slug = 'batroun' on conflict do nothing;

insert into suqa.categories (tenant_id, slug, name, sort_order)
select t.id, c.slug, c.name, c.ord from suqa.tenants t,
 (values ('grocery',  '{"en":"Grocery","ar":"سمانة"}'::jsonb, 1),
         ('bakery',   '{"en":"Bakery & Sweets","ar":"فرن وحلويات"}', 2),
         ('butcher',  '{"en":"Butcher & Fish","ar":"لحوم وأسماك"}', 3),
         ('pharmacy', '{"en":"Pharmacy","ar":"صيدلية"}', 4),
         ('restaurant','{"en":"Restaurants","ar":"مطاعم"}', 5),
         ('fashion',  '{"en":"Clothing & Shoes","ar":"ألبسة وأحذية"}', 6),
         ('home',     '{"en":"Home & Hardware","ar":"منزل وعدد"}', 7),
         ('gifts',    '{"en":"Gifts & Crafts","ar":"هدايا وحرف"}', 8)
 ) as c(slug, name, ord)
where t.slug = 'batroun' on conflict (tenant_id, slug) do nothing;

-- Batroun town zone: rough bounding polygon, to be redrawn by the association in the admin.
insert into suqa.delivery_zones (tenant_id, name, area, fee_usd, eta_minutes, sort_order)
select id, '{"en":"Batroun town","ar":"مدينة البترون"}'::jsonb,
       st_multi(st_geomfromtext('POLYGON((35.640 34.240, 35.680 34.240, 35.680 34.270, 35.640 34.270, 35.640 34.240))', 4326))::geography,
       2.00, 30, 1
from suqa.tenants where slug = 'batroun';
