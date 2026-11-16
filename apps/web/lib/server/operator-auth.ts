import { timingSafeEqual } from 'node:crypto';
import { getTenant } from '@/lib/tenant';
import { getTenantRole } from '@/lib/admin';

/** Operator tools (WhatsApp account set-up): the shared SUQA_EVENTS_SECRET header, or a signed-in tenant admin. */
export async function operatorAuthorized(req: Request): Promise<boolean> {
  const want = process.env.SUQA_EVENTS_SECRET, got = req.headers.get('x-suqa-secret');
  if (want && got && want.length === got.length && timingSafeEqual(Buffer.from(want), Buffer.from(got))) return true;
  try { const t = await getTenant(); return (await getTenantRole(t.id)) === 'admin'; } catch { return false; }
}
