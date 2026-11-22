import { getTenantOrNull } from '@/lib/tenant';
import Legal from '../Legal';
import { legalInfo } from '../legal-info';

export const dynamic = 'force-dynamic';
const UPDATED = '2026-11-21';

export default async function Privacy() {
  const t = await getTenantOrNull();
  const brand = t?.brand_name ?? 'Suqa';
  const { OPERATOR, CONTACT } = legalInfo(t);
  const support = t?.settings.support_phone ?? null;
  return (
    <Legal brand={brand} titleAr="سياسة الخصوصية" titleEn="Privacy Policy" updated={UPDATED}>
      <section dir="rtl" lang="ar" className="card stack legal-text">
        <p><strong>{brand}</strong> هو سوق إلكتروني محلي يتيح لك طلب المنتجات من متاجر مدينتك. يشغّل المنصة (Suqa) شركة {OPERATOR} لصالح الجمعية أو البلدية التي تملك العلامة التجارية المعروضة.</p>
        <h3>ما البيانات التي نجمعها</h3>
        <ul>
          <li><strong>بيانات الحساب:</strong> الاسم، رقم الهاتف، البريد الإلكتروني (أو معرّف حساب Google/Facebook/WhatsApp إن سجّلت الدخول بها).</li>
          <li><strong>عناوين التوصيل:</strong> العنوان النصي والموقع الجغرافي الذي تحدّده على الخريطة.</li>
          <li><strong>الطلبات:</strong> الأصناف، المبالغ، الملاحظات، وسجل حالات الطلب.</li>
          <li><strong>بيانات تقنية:</strong> معرّف الجلسة وملفات تعريف الارتباط اللازمة لتسجيل الدخول فقط. لا نستخدم ملفات تتبّع إعلانية.</li>
        </ul>
        <h3>لماذا نستخدمها</h3>
        <ul>
          <li>لتنفيذ طلبك وتسليمه: يرى المتجر اسمك ورقم هاتفك وعنوانك لهذا الطلب فقط؛ ويراها الموصّل عند التسليم.</li>
          <li>لإرسال إشعارات حالة الطلب عبر واتساب أو الرسائل النصية أو داخل التطبيق.</li>
          <li>لإدارة السوق من قبل الجمعية (إحصاءات مجمّعة، معالجة الشكاوى).</li>
          <li>لا نبيع بياناتك ولا نشاركها مع معلنين.</li>
        </ul>
        <h3>مع من نشاركها</h3>
        <p>المتاجر والموصّلون المعنيون بطلبك؛ مزوّدو الخدمة التقنيون الذين يستضيفون المنصة (Supabase وNetlify في الاتحاد الأوروبي، وMeta لرسائل واتساب، وAnthropic للمساعد يورغو، وGoogle لتحويل الرسائل الصوتية إلى نص). جميعهم ملزمون بحماية بياناتك.</p>
        <h3>المساعد «يورغو» (ذكاء اصطناعي)</h3>
        <p>يورغو مساعد يعمل بالذكاء الاصطناعي ويمكنك استخدامه أو تجاهله. عندما تكتب له رسالة، تُرسَل الرسالة مع أسماء الأصناف والأسعار المعروضة في السوق إلى مزوّد الذكاء الاصطناعي (Anthropic، نموذج Claude، في الولايات المتحدة) لصياغة الجواب فقط. نحفظ محادثاتك مع يورغو في المنصة لتتابعها أنت ولتحسين الخدمة؛ المتاجر لا تراها، والجمعية ترى أعداد الاستخدام والأصناف التي طلبتها من يورغو أو بحثت عنها في الموقع (مع اسمك ورقمك إن كان لك حساب أو كتبت على واتساب) لمعرفة ما يحتاجه الناس، لا نصّ الرسائل. لا تكتب في المحادثة معلومات حسّاسة (كلمات سر، بيانات بطاقات، معلومات صحية). يورغو قد يخطئ: لا يُطلَب شيء ولا يُباع قبل أن تؤكّد أنت. الرسائل التي ترسلها إلى رقم واتساب السوق يقرأها المساعد الآلي (يورغو) لتجهيز سلتك. إذا أرسلت رسالة صوتية (على واتساب أو من داخل التطبيق)، تُرسَل إلى مزوّد ذكاء اصطناعي ثانٍ (Google، نموذج Gemini) لتحويلها إلى نص فقط؛ لا نحفظ التسجيل الصوتي، ونحفظ النص كأي رسالة مكتوبة.</p>
        <h3>مدة الاحتفاظ</h3>
        <p>نحتفظ بسجل الطلبات طوال فترة نشاط حسابك ولمدة تصل إلى ٥ سنوات للأغراض المحاسبية، ثم نحذفه أو نجعله مجهول الهوية.</p>
        <h3>حقوقك</h3>
        <p>يمكنك الاطلاع على بياناتك أو تصحيحها أو طلب حذف حسابك في أي وقت. راجع <a href="/legal/delete-data">صفحة حذف البيانات</a> أو راسلنا على {CONTACT}{support ? ` أو اتصل بالدعم على ${support}` : ''}.</p>
      </section>

      <section dir="ltr" lang="en" className="card stack legal-text">
        <p><strong>{brand}</strong> is a local online marketplace that lets you order from the shops of your town. The platform (Suqa) is operated by {OPERATOR} on behalf of the association or municipality whose brand is shown.</p>
        <h3>What we collect</h3>
        <ul>
          <li><strong>Account data:</strong> name, phone number, email (or your Google/Facebook/WhatsApp account identifier if you sign in with them).</li>
          <li><strong>Delivery addresses:</strong> the text address and the map location you pin.</li>
          <li><strong>Orders:</strong> items, amounts, notes and the status history of each order.</li>
          <li><strong>Technical data:</strong> a session identifier and the cookies strictly needed to keep you signed in. We use no advertising trackers.</li>
        </ul>
        <h3>Why we use it</h3>
        <ul>
          <li>To fulfil and deliver your order: the shop sees your name, phone and address for that order only; a courier sees them while delivering.</li>
          <li>To send order-status notifications by WhatsApp, SMS or in the app.</li>
          <li>To let the association run the marketplace (aggregate statistics, complaint handling).</li>
          <li>We do not sell your data or share it with advertisers.</li>
        </ul>
        <h3>Who we share it with</h3>
        <p>The shops and couriers involved in your order; the technical providers that host the platform (Supabase and Netlify in the EU, Meta for WhatsApp messages, Anthropic for the Yorgo assistant, Google for turning voice notes into text). All are bound to protect your data.</p>
        <h3>The assistant "Yorgo" (AI)</h3>
        <p>Yorgo is an AI assistant you may use or ignore. When you write to it, your message, together with item names and prices shown in the marketplace, is sent to an AI provider (Anthropic, the Claude model, in the United States) only to produce the answer. Your conversations with Yorgo are stored on the platform so you can continue them and so we can improve the service; shops do not see them, and the association sees usage figures and the items you asked Yorgo for or searched on the site (with your name and number when you have an account or wrote on WhatsApp), to know what people need — not the text of your messages. Do not write sensitive information in the chat (passwords, card details, health information). Yorgo can be wrong: nothing is ordered or sold until you confirm it yourself. Messages you send to the market's WhatsApp number are read by the AI assistant (Yorgo) to prepare your basket. If you send a voice note (on WhatsApp or in the app), it is sent to a second AI provider (Google, the Gemini model) only to turn it into text; we do not keep the recording, and we keep the text like any typed message.</p>
        <h3>Retention</h3>
        <p>Order history is kept while your account is active and for up to 5 years for accounting purposes, then deleted or anonymised.</p>
        <h3>Your rights</h3>
        <p>You can access, correct or delete your data at any time. See the <a href="/legal/delete-data">data deletion page</a> or write to {CONTACT}{support ? `, or call support at ${support}` : ''}.</p>
      </section>
    </Legal>
  );
}
