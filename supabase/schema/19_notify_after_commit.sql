-- 19_notify_after_commit.sql — fire the new-order notification after the whole order is written   (2026-11-07)
-- The AFTER INSERT row trigger ran before order_items existed (same transaction, later statement), so the shop
-- alert listed no items. A DEFERRABLE INITIALLY DEFERRED constraint trigger runs at commit instead.
-- Status updates keep the ordinary trigger (the row is complete by then).

drop trigger if exists orders_notify on suqa.orders;

create constraint trigger orders_notify_insert
  after insert on suqa.orders
  deferrable initially deferred
  for each row execute function suqa.notify_order_event();

create trigger orders_notify_update
  after update of status on suqa.orders
  for each row execute function suqa.notify_order_event();

select 'notify after commit installed' as result;
