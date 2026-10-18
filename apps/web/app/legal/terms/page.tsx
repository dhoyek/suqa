import { getTenantOrNull } from '@/lib/tenant';
import Legal from '../Legal';

export const dynamic = 'force-dynamic';
const UPDATED = '2026-10-18';
const OPERATOR = 'Purple Digits (Lebanon)';

export default async function Terms() {
  const t = await getTenantOrNull();
  const brand = t?.brand_name ?? 'Suqa';
  return (
    <Legal brand={brand} titleAr="شروط الاستخدام" titleEn="Terms of Service" updated={UPDATED}>
      <section dir="rtl" lang="ar" className="card stack legal-text">
        <ol>
          <li><strong>الخدمة.</strong> {brand} منصة تربط الزبائن بمتاجر محلية مستقلة. المتجر هو البائع؛ المنصة تنقل الطلب وتتابع حالته.</li>
          <li><strong>الطلبات والأسعار.</strong> الأسعار بالدولار الأمريكي ويُعرض ما يعادلها بالليرة اللبنانية بسعر صرف تحدّده الجمعية. السعر النهائي هو المعروض عند تأكيد الطلب. قد يرفض المتجر الطلب أو يلغيه (مثلاً لعدم توفر صنف) ويُبلَّغ الزبون بذلك.</li>
          <li><strong>الدفع.</strong> الدفع نقداً عند الاستلام ما لم يُذكر خلاف ذلك.</li>
          <li><strong>التوصيل.</strong> رسوم التوصيل ومدّته تقديرية وتُعرض قبل التأكيد. يتم التوصيل من قبل المتجر أو موصّل الجمعية ضمن المناطق المحددة.</li>
          <li><strong>الإلغاء.</strong> يمكن للزبون إلغاء الطلب ما دام المتجر لم يقبله بعد.</li>
          <li><strong>الحساب.</strong> أنت مسؤول عن صحة بياناتك وعن استخدام حسابك. يحق لنا تعليق الحسابات المسيئة.</li>
          <li><strong>المسؤولية.</strong> جودة المنتجات ومطابقتها من مسؤولية المتجر البائع. تتوسّط الجمعية في الشكاوى بحسن نية.</li>
          <li><strong>التعديلات.</strong> قد نحدّث هذه الشروط؛ يُنشر تاريخ آخر تحديث أعلاه.</li>
          <li><strong>القانون.</strong> تخضع هذه الشروط للقانون اللبناني. تشغّل المنصة {OPERATOR}.</li>
        </ol>
      </section>
      <section dir="ltr" lang="en" className="card stack legal-text">
        <ol>
          <li><strong>The service.</strong> {brand} connects customers with independent local shops. The shop is the seller; the platform transmits the order and tracks its status.</li>
          <li><strong>Orders and prices.</strong> Prices are in US dollars with a Lebanese-pound equivalent at a rate set by the association. The final price is the one shown when you confirm. A shop may reject or cancel an order (e.g. an item is out of stock); you are notified.</li>
          <li><strong>Payment.</strong> Cash on delivery unless stated otherwise.</li>
          <li><strong>Delivery.</strong> Delivery fees and times are estimates shown before confirmation. Delivery is made by the shop or by an association courier within the defined zones.</li>
          <li><strong>Cancellation.</strong> You may cancel an order as long as the shop has not yet accepted it.</li>
          <li><strong>Account.</strong> You are responsible for the accuracy of your details and the use of your account. We may suspend abusive accounts.</li>
          <li><strong>Liability.</strong> Product quality and conformity are the selling shop’s responsibility. The association mediates complaints in good faith.</li>
          <li><strong>Changes.</strong> We may update these terms; the last-updated date is shown above.</li>
          <li><strong>Law.</strong> These terms are governed by Lebanese law. The platform is operated by {OPERATOR}.</li>
        </ol>
      </section>
    </Legal>
  );
}
