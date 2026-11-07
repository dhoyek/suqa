import 'server-only';

// Meta utility templates used for order notifications (mirrors docs/whatsapp-templates.md).
// Submitted with POST /api/wa/templates (secret-protected); Meta reviews them, usually within minutes.
export type TemplateDef = { name: string; language: string; category: 'UTILITY' | 'AUTHENTICATION'; text: string; samples: string[] };

export const TEMPLATES: TemplateDef[] = [
  // Sign-in code. Meta fixes the wording of authentication templates; we only choose the options
  // (security note + 5-minute expiry + copy-code button). text/samples are informational here.
  { name: 'login_code', language: 'ar', category: 'AUTHENTICATION', text: '{{1}} هو رمز التحقق الخاص بك.', samples: ['123456'] },
  {
    name: 'order_new_shop', language: 'ar', category: 'UTILITY',
    text: '🛒 طلب جديد {{1}} عبر {{2}}.\nالطلب: {{3}}\nالإجمالي: {{4}}\nالعميل: {{5}}\nالعنوان: {{6}}\nلقبول الطلب أو رفضه افتح لوحة المتجر: {{7}}\nشكراً.',
    samples: ['BAT-000021', 'Batroun Basket', '2 كيلو بندورة، 1× ربطة خبز', '$7.50 · 671,250 ل.ل.', 'داني +96170483148', 'البترون، شارع البحر، بناية 3', 'https://suqa-dev.netlify.app/shop'],
  },
  {
    name: 'order_status', language: 'ar', category: 'UTILITY',
    text: 'تحديث من {{1}} بخصوص طلبك {{2}}:\n{{3}}\nتابع طلبك هنا: {{4}}\nشكراً لدعمك متاجر البلدة.',
    samples: ['سمانة أبو إيلي', 'BAT-000021', '✅ تم قبول طلبك — الوقت المتوقع 25 دقيقة.', 'https://suqa-dev.netlify.app/orders'],
  },
  {
    name: 'order_ready_courier', language: 'ar', category: 'UTILITY',
    text: '📦 الطلب {{1}} جاهز للاستلام من {{2}} للتوصيل إلى {{3}}.\nافتح شاشة الموصّل لاستلامه: {{4}}\nشكراً.',
    samples: ['BAT-000021', 'سمانة أبو إيلي', 'البترون', 'https://suqa-dev.netlify.app/courier'],
  },
  {
    name: 'order_message', language: 'ar', category: 'UTILITY',
    text: '💬 رسالة بخصوص الطلب {{1}} من {{2}}:\n{{3}}\nيمكنك الرد على هذه الرسالة مباشرة.',
    samples: ['BAT-000021', 'سمانة أبو إيلي', 'تمام، الطلب جاهز خلال ربع ساعة'],
  },
];

/** Graph API components for a template definition. Authentication templates have a fixed Meta-defined body. */
export function templateComponents(d: TemplateDef) {
  if (d.category === 'AUTHENTICATION') return [
    { type: 'BODY', add_security_recommendation: true },
    { type: 'FOOTER', code_expiration_minutes: 5 },
    { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }] },
  ];
  return [{ type: 'BODY', text: d.text, example: { body_text: [d.samples] } }];
}
