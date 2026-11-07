# Suqa POS — device setup (pilot)

The POS is a web app: open **https://suqa-dev.netlify.app/pos** in a modern browser. No installer. Works on Windows, Android, iPad.

## 1. First time on a device (needs internet)
1. Sign in with the shop owner / staff account (`/login`, email or WhatsApp code).
2. Open `/pos` → give the device a name (e.g. "كمبيوتر الكاشير") → it gets a letter prefix (A, B, …) for offline receipt numbers.
3. Choose your 4-digit PIN on the lock screen. Every staff member sets their own PIN the first time (needs internet). Owners' PINs also approve discounts/price overrides/refunds for cashiers.
4. Open a shift (الوردية → فتح وردية, opening float in $ and ل.ل.) — selling needs an open shift on the device.

After that the POS opens with no internet for up to `offline_days` (30) since the last sync, and everything syncs when the connection returns.

## 2. Install as an app (recommended)
* **Windows / Android Chrome**: address bar → "Install app" (or ⋮ → Add to Home screen). Keeps local data persistent and gives a full-screen window.
* **iPad Safari**: Share → "Add to Home Screen". Important on iOS: without this, Safari may wipe local data after 7 days of not using the site.

## 3. Thermal printer (same approach as Hsarat POS)
The POS prints through the system printer — no drivers inside the app.
* **Windows**: install the printer's driver (58 mm or 80 mm), set it as the default printer, paper size "58(48) x 210 mm" or similar. In the POS: الإعدادات → الطابعة → paper width, feed lines, cut mark, **auto-print after payment**, "Test print".
* **Silent printing on the counter PC** (no print dialog): create a Chrome shortcut with the flag
  `"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing --app=https://suqa-dev.netlify.app/pos`
  Chrome then prints to the default printer immediately. (Edge: same flag.)
* **Android**: install the printer vendor's *print service* app (or "Bluetooth printer" print service), then print from the POS; Android shows its print sheet (one tap).
* **iPad**: AirPrint printers only; for Bluetooth/USB thermal printers use the WhatsApp or QR receipt instead.
* Cash drawer: if the drawer is wired to the printer, enable "open drawer on print" in the printer driver settings (Windows) — the POS has no separate drawer command.

## 4. Barcode scanner
* **USB/Bluetooth scanner in keyboard (HID) mode**: nothing to configure. It must send **Enter** after the code (factory default). Scanning works on any POS screen, even while a search box is focused.
* **Phone camera**: 📷 button on the sell screen (Chrome/Android native; Safari uses a built-in decoder).

## 5. Daily routine
* Morning: unlock with PIN → open shift with the float.
* Sell: scan / tap, F8 or دفع → tenders → confirm; receipt prints (if auto-print) — "بيع جديد" for the next customer.
* Evening: الوردية → إقفال الوردية → count $ and ل.ل. → Z report prints; the difference is recorded.
* The status pill (متصل / غير متصل, N بانتظار الإرسال) shows unsynced work; "زامن الآن" forces a sync. A yellow banner means a new version is ready — it applies itself when no sale is open.

## 6. Owner: devices & staff
الإعدادات → الأجهزة shows every device (last sync, pending). **Revoke** stops a lost device: it wipes its local data the next time it connects (unsynced sales are saved to a file on that device first).

**Staff** (الإعدادات → الموظفون): add a person by their WhatsApp number, display name and role (owner / cashier / stock). If the number already has a Suqa account they are in immediately; otherwise an invite waits and is claimed on their first sign-in — the 💬 button opens WhatsApp with a ready invite message. Roles can be changed any time, a person can be deactivated (they can no longer unlock the POS), and a forgotten PIN can be reset (they set a new one on next unlock). The last owner cannot be removed.

Roles: **owner** everything · **cashier** sell, orders, debts, shifts; price changes, stock moves and returns need an owner PIN · **stock** items and stock only.

Platform admins and tenant members can open the POS of any POS-enabled shop (shop picker on start).

## 7. Orders (WhatsApp / phone / online)
الطلبات shows four columns: new → in progress → on the way → done. Online orders arrive with a sound; WhatsApp/phone orders are typed in from البيع (👤 → channel, pickup/delivery, address, delivery fee → "حفظ في الطلبات") or from the ＋ button in الطلبات.
* Accept (ETA for online), reject/cancel with a reason (customer is notified when "notify" is on), edit quantities / remove / substitute lines.
* **Pickup handover** opens the pay dialog. **Delivery handover** opens the cash-on-delivery settlement: what the customer paid (split tender or unpaid), driver name and **driver fee** — the fee is taken out of the drawer as a cash move on the open shift, so expected cash stays right.
* Delivered orders can be returned (full/partial, back to stock or damaged, refund $ or ل.ل.; owner PIN for cashiers) and reprinted.

## 8. Debt book (الدين)
Any sale or order paid with the **غير مدفوع** tender (name + phone) becomes a debt line. الدين lists them by person (total per person) or by date, filtered by period and by one or several people; **طباعة كشف** prints a statement on the receipt printer (one person or the filtered list).
**تحصيل**: choose the person, type the amount (cash $, cash ل.ل., card). It is allocated oldest-first: fully covered orders are marked paid, the last one keeps the remainder. The preview shows the allocation before confirming; a receipt can be printed. Cash collected goes into the open shift's drawer ("تحصيل دين · name" on the Z report). Original sales are never edited; the collection is a separate record, so reports show "debt collected" per period.

## 9. Reports & export (owner)
التقارير: today (always, offline too) and period reports — presets or custom range — with net sales, returns, margin, driver/delivery fees, by day / channel / tender / item / section, slow movers, stock value at cost and retail, open debts, shifts (expected vs counted). **Excel** exports one sheet per table; **CSV** exports the open tab; "تصدير كل بيانات المحل" downloads the whole shop (items, orders, payments, stock moves, shifts, returns, staff, devices, audit log). Offline, the period report falls back to this device's data and says so.

## 10. Language, iPad & touch
الإعدادات → اللغة switches this device between Arabic (RTL) and English; "أزرار أكبر" enlarges every button, input and numpad for tablets / touch screens. Both are per device. On iPad add the POS to the home screen (Share → Add to Home Screen) so it opens full-screen and keeps its data; in Safari settings do not clear website data for the POS site.

## 11. Audit & conflicts (owner)
الإعدادات shows the **audit log** (who did what, when — sales, status changes, edits, returns, stock moves, staff and device changes) and **sync conflicts**: when two devices changed the same field while offline, the newer value wins and the older one is listed here for review.
