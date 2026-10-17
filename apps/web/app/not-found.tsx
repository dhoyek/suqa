import Link from 'next/link';
import { getTenantOrNull } from '@/lib/tenant';

export default async function NotFound() {
  const t = await getTenantOrNull();
  const ar = (t?.default_locale ?? 'ar') === 'ar';
  return (
    <main className="login">
      <div className="card stack" style={{ textAlign: 'center' }}>
        <div className="brand">{t?.brand_name ?? 'Suqa'}</div>
        <h1 style={{ margin: 0, fontSize: 20 }}>{ar ? 'الصفحة غير موجودة' : 'Page not found'}</h1>
        <p className="muted">{ar ? 'ربما تم نقل الرابط أو حذفه.' : 'The link may have moved or been removed.'}</p>
        <Link className="btn primary" href="/">{ar ? 'العودة إلى المتاجر' : 'Back to shops'}</Link>
      </div>
    </main>
  );
}
