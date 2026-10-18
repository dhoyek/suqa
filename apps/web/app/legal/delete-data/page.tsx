import { getTenantOrNull } from '@/lib/tenant';
import Legal from '../Legal';

export const dynamic = 'force-dynamic';
const UPDATED = '2026-10-18';
const CONTACT = 'privacy@yorgoinc.com';

// Meta "User data deletion" URL: explains how a person removes their account and data.
export default async function DeleteData() {
  const t = await getTenantOrNull();
  const brand = t?.brand_name ?? 'Suqa';
  const wa = t?.settings.whatsapp_number ?? null;
  return (
    <Legal brand={brand} titleAr="حذف الحساب والبيانات" titleEn="Delete your account & data" updated={UPDATED}>
      <section dir="rtl" lang="ar" className="card stack legal-text">
        <p>يمكنك طلب حذف حسابك في <strong>{brand}</strong> وجميع بياناتك الشخصية في أي وقت، بإحدى الطرق التالية:</p>
        <ol>
          <li><strong>عبر البريد الإلكتروني:</strong> أرسل رسالة إلى <a href={`mailto:${CONTACT}?subject=${encodeURIComponent('حذف حسابي - ' + brand)}`}>{CONTACT}</a> من البريد المسجّل في حسابك، بعنوان «حذف حسابي».</li>
          {wa && <li><strong>عبر واتساب:</strong> راسل الدعم على <a href={`https://wa.me/${wa.replace(/\D/g, '')}`} dir="ltr">{wa}</a> من رقم الهاتف المسجّل في حسابك.</li>}
          <li><strong>إن سجّلت الدخول عبر Facebook:</strong> يمكنك أيضاً إزالة التطبيق من إعدادات Facebook ← التطبيقات والمواقع؛ سيصلنا طلب الحذف تلقائياً.</li>
        </ol>
        <h3>ماذا يحدث بعد الطلب</h3>
        <ul>
          <li>نؤكد هويتك ثم نحذف حسابك وبيانات تسجيل الدخول وعناوينك ورقم هاتفك خلال <strong>٣٠ يوماً</strong>.</li>
          <li>سجلات الطلبات المكتملة تُجعل مجهولة الهوية (يُزال اسمك ورقمك وعنوانك منها) لأن المتاجر ملزمة قانونياً بالاحتفاظ بسجل مبيعاتها.</li>
          <li>الطلبات التي ما زالت قيد التنفيذ تُلغى أو تُكمل أولاً.</li>
          <li>نرسل لك تأكيداً عند اكتمال الحذف.</li>
        </ul>
      </section>

      <section dir="ltr" lang="en" className="card stack legal-text">
        <p>You can ask us to delete your <strong>{brand}</strong> account and all your personal data at any time, in one of these ways:</p>
        <ol>
          <li><strong>By email:</strong> write to <a href={`mailto:${CONTACT}?subject=${encodeURIComponent('Delete my account - ' + brand)}`}>{CONTACT}</a> from the email registered on your account, subject “Delete my account”.</li>
          {wa && <li><strong>By WhatsApp:</strong> message support at <a href={`https://wa.me/${wa.replace(/\D/g, '')}`}>{wa}</a> from the phone number registered on your account.</li>}
          <li><strong>If you signed in with Facebook:</strong> you can also remove the app under Facebook Settings → Apps and Websites; we receive the deletion request automatically.</li>
        </ol>
        <h3>What happens next</h3>
        <ul>
          <li>We verify your identity, then delete your account, sign-in data, addresses and phone number within <strong>30 days</strong>.</li>
          <li>Completed order records are anonymised (your name, phone and address are removed) because shops must legally keep their sales records.</li>
          <li>Orders still in progress are cancelled or completed first.</li>
          <li>You receive a confirmation when the deletion is complete.</li>
        </ul>
      </section>
    </Legal>
  );
}
