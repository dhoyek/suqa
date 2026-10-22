import 'server-only';

// Source of truth for the Meta utility templates (mirrors docs/whatsapp-templates.md).
export type TemplateSpec = { name: string; body: string; samples: string[] };

export const TEMPLATES: TemplateSpec[] = [
  {
    name: 'order_new_shop',
    body: '🛒 طلب جديد {{1}} عبر {{2}}.\nالطلب: {{3}}\nالإجمالي: {{4}}\nالعميل: {{5}}\nالعنوان: {{6}}\nلقبول الطلب أو رفضه افتح لوحة المتجر: {{7}}\nشكراً.',
    samples: ['BAT-000021', 'Batroun Basket', '2 كيلو بندورة، 1× ربطة خبز', '$7.50 · 671,250 ل.ل.', 'داني +96170483148', 'البترون، شارع البحر، بناية 3', 'https://suqa-dev.netlify.app/shop'],
  },
  {
    name: 'order_status',
    body: 'تحديث من {{1}} بخصوص طلبك {{2}}:\n{{3}}\nتابع طلبك هنا: {{4}}\nشكراً لدعمك متاجر البلدة.',
    samples: ['سمانة أبو إيلي', 'BAT-000021', '✅ تم قبول طلبك — الوقت المتوقع 25 دقيقة.', 'https://suqa-dev.netlify.app/orders'],
  },
  {
    name: 'order_ready_courier',
    body: '📦 الطلب {{1}} جاهز للاستلام من {{2}} للتوصيل إلى {{3}}.\nافتح شاشة الموصّل لاستلامه: {{4}}\nشكراً.',
    samples: ['BAT-000021', 'سمانة أبو إيلي', 'البترون', 'https://suqa-dev.netlify.app/courier'],
  },
  {
    name: 'order_message',
    body: '💬 رسالة بخصوص الطلب {{1}} من {{2}}:\n{{3}}\nيمكنك الرد على هذه الرسالة مباشرة.',
    samples: ['BAT-000021', 'سمانة أبو إيلي', 'تمام، الطلب جاهز خلال ربع ساعة'],
  },
];
