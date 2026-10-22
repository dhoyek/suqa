# WhatsApp message templates (Meta → WhatsApp Manager → Message templates → Create)

Category **Utility**, language **Arabic (ar)** for all four. Body text exactly as below (variables are `{{n}}`).
Once all four show **Approved**, set Netlify env `WHATSAPP_TEMPLATES=1` and redeploy; notifications then deliver
outside the 24-hour window. Sample values are needed when submitting — use the ones listed.

## 1. `order_new_shop`
```
🛒 طلب جديد {{1}} عبر {{2}}.
الطلب: {{3}}
الإجمالي: {{4}}
العميل: {{5}}
العنوان: {{6}}
لقبول الطلب أو رفضه افتح لوحة المتجر: {{7}}
شكراً.
```
Samples: `BAT-000021` · `Batroun Basket` · `2 كيلو بندورة، 1× ربطة خبز` · `$7.50 · 671,250 ل.ل.` · `داني +96170483148` · `البترون، شارع البحر، بناية 3` · `https://suqa-dev.netlify.app/shop`

## 2. `order_status`
```
تحديث من {{1}} بخصوص طلبك {{2}}:
{{3}}
تابع طلبك هنا: {{4}}
شكراً لدعمك متاجر البلدة.
```
Samples: `سمانة أبو إيلي` · `BAT-000021` · `✅ تم قبول طلبك — الوقت المتوقع 25 دقيقة.` · `https://suqa-dev.netlify.app/orders`

## 3. `order_ready_courier`
```
📦 الطلب {{1}} جاهز للاستلام من {{2}} للتوصيل إلى {{3}}.
افتح شاشة الموصّل لاستلامه: {{4}}
شكراً.
```
Samples: `BAT-000021` · `سمانة أبو إيلي` · `البترون` · `https://suqa-dev.netlify.app/courier`

## 4. `order_message`
```
💬 رسالة بخصوص الطلب {{1}} من {{2}}:
{{3}}
يمكنك الرد على هذه الرسالة مباشرة.
```
Samples: `BAT-000021` · `سمانة أبو إيلي` · `تمام، الطلب جاهز خلال ربع ساعة`

Notes
- The sign-in code uses Meta's **Authentication** template type (separate flow: copy-code button, 5-min expiry) — created later with the production number; on the test number the OTP is sent as plain text.
- English versions (`en`) can be added later with the same names; the sender picks the tenant locale.
